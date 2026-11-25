/**
 * Reconciliation tooling for the CircleUp indexer (Issue #366).
 *
 * Projection drift can result from missed events, decoder bugs, or manual
 * database changes. This module compares the indexed Postgres state against
 * canonical on-chain reads and reports (or repairs) any divergence.
 *
 * Canonical fields compared, and their on-chain source:
 *   circles.status          → circle contract `get_status`
 *   circles.current_round   → circle contract `get_current_round`
 *                              (not applicable once the circle is Completed
 *                              or Cancelled — the contract errors for those
 *                              states, so the field is skipped rather than
 *                              flagged as drift)
 *   circles.total_rounds,
 *   circles.member_count    → circle contract `get_config` (members.length)
 *   circles.round_amount    → circle contract `get_config` (round_amount)
 *   circle_members.collateral → circle contract `get_collateral(member)`
 *   circle_members.defaults   → circle contract `get_defaults(member)`
 *   reputation.score         → reputation contract `score(member)`
 *
 * Eventual-consistency tolerance: a circle whose `updated_at` falls within
 * the last `graceMs` (default 30s) is skipped for this pass, along with its
 * members — the indexer may simply not have finished processing the most
 * recent on-chain event yet, and flagging that normal lag as drift would be
 * a false positive. Reputation rows carry their own `updated_at` and are
 * additionally gated on that.
 *
 * Two modes:
 *   report mode (default)  — read-only comparison. Never writes to the DB.
 *   repair mode (--repair) — re-applies canonical values for a fresh list of
 *                             differences. Each repair is a conditional
 *                             UPDATE guarded on the exact indexed value the
 *                             difference was computed from, so re-running
 *                             repair is idempotent: a row already fixed (or
 *                             changed again since the report ran) is left
 *                             alone rather than clobbered.
 */

import {
  SorobanRpc,
  xdr,
  scValToNative,
  Contract,
  Address,
  TransactionBuilder,
  Networks,
} from "@stellar/stellar-sdk";
import type { QueryResultRow } from "pg";
import { query, pool, withPoolCleanup } from "./pool";
import { rpc } from "../indexer";
import { REPUTATION_ADDRESS } from "../config";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_REPAIRS = 500;

// ── Raw contract wire shapes ─────────────────────────────────────────────────
//
// Mirrors sdk/src/types.ts RawCircleConfig / RawRoundState. Duplicated here
// (rather than depending on @circleup/sdk) because the indexer package reads
// on-chain state directly, the same way src/health.ts already does.

interface RawCircleConfig {
  members: string[];
  round_amount: bigint;
  round_deadline_ledgers: number;
}

interface RawRoundState {
  round_index: number;
  recipient: string;
  contributions_received: number;
  deadline_ledger: bigint;
  paid_out: boolean;
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── Canonical contract reads ──────────────────────────────────────────────────

export type SimResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

export type SimulateReadFn = (
  sourceAddress: string,
  contractId: string,
  method: string,
  args?: xdr.ScVal[],
) => Promise<SimResult<unknown>>;

/**
 * Read-only contract call via `simulateTransaction`. Never submits a
 * transaction. Uses `sourceAddress` (a contract address) as a stand-in
 * source account purely to build a well-formed envelope for simulation —
 * the same trick `checkContractStateDrift` in src/health.ts already relies
 * on, generalised here to any method/args.
 */
async function simulateContractRead(
  sourceAddress: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<SimResult<unknown>> {
  try {
    const account = await withTimeout(rpc.getAccount(sourceAddress), DEFAULT_TIMEOUT_MS);
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await withTimeout(rpc.simulateTransaction(tx), DEFAULT_TIMEOUT_MS);

    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
      const error = SorobanRpc.Api.isSimulationError(sim)
        ? sim.error
        : `${method} simulation returned no result`;
      return { ok: false, error };
    }

    return { ok: true, value: scValToNative(sim.result.retval as xdr.ScVal) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface CanonicalCircleState {
  status: string;
  /** null when the circle is Completed/Cancelled — get_current_round errors by contract design. */
  currentRound: number | null;
  totalRounds: number;
  memberCount: number;
  roundAmount: bigint;
}

async function readCanonicalCircleState(
  circleAddress: string,
  simFn: SimulateReadFn = simulateContractRead,
): Promise<SimResult<CanonicalCircleState>> {
  const [statusResult, configResult, roundResult] = await Promise.all([
    simFn(circleAddress, circleAddress, "get_status"),
    simFn(circleAddress, circleAddress, "get_config"),
    simFn(circleAddress, circleAddress, "get_current_round"),
  ]);

  if (!statusResult.ok) return { ok: false, error: `get_status: ${statusResult.error}` };
  if (!configResult.ok) return { ok: false, error: `get_config: ${configResult.error}` };

  const config = configResult.value as Partial<RawCircleConfig> | null;
  if (!config || !Array.isArray(config.members)) {
    return { ok: false, error: "get_config returned a malformed CircleConfig" };
  }

  const roundValue = roundResult.ok ? (roundResult.value as Partial<RawRoundState> | null) : null;
  const currentRound =
    roundValue && typeof roundValue.round_index === "number" ? roundValue.round_index : null;

  const roundAmountRaw = config.round_amount;
  const roundAmount =
    typeof roundAmountRaw === "bigint" ? roundAmountRaw : BigInt(String(roundAmountRaw ?? 0));

  return {
    ok: true,
    value: {
      status: String(statusResult.value),
      currentRound,
      totalRounds: config.members.length,
      memberCount: config.members.length,
      roundAmount,
    },
  };
}

// ── Differences ────────────────────────────────────────────────────────────────

export interface Difference {
  entity: "circle" | "circle_member" | "reputation";
  /** circle address, or "circleAddress:memberAddress" for circle_member */
  key: string;
  field: string;
  indexed: string;
  canonical: string;
}

function pushIfDifferent(
  differences: Difference[],
  entity: Difference["entity"],
  key: string,
  field: string,
  indexed: unknown,
  canonical: unknown,
): void {
  const indexedStr = String(indexed);
  const canonicalStr = String(canonical);
  if (indexedStr !== canonicalStr) {
    differences.push({ entity, key, field, indexed: indexedStr, canonical: canonicalStr });
  }
}

export interface UnreadableEntity {
  entity: Difference["entity"];
  key: string;
  error: string;
}

export interface ReconciliationReport {
  generatedAt: string;
  circlesScanned: number;
  circlesSkippedGrace: number;
  membersScanned: number;
  reputationScanned: number;
  unreadable: UnreadableEntity[];
  differences: Difference[];
}

export interface ReconciliationOptions {
  /** Rows fetched per page when scanning the circles table. */
  pageSize?: number;
  /** Skip rows updated more recently than this, in ms — see module doc. */
  graceMs?: number;
  /** Restrict the scan to a single circle address. */
  circleAddress?: string;
  log?: (msg: string) => void;
  queryFn?: QueryFn;
  simulateRead?: SimulateReadFn;
}

// ── Report mode (read-only) ───────────────────────────────────────────────────

interface DbCircleRow {
  address: string;
  status: string;
  current_round: number;
  total_rounds: number;
  member_count: number;
  round_amount: string;
  updated_at: string;
}

interface DbCircleMemberRow {
  member_address: string;
  collateral: string;
  defaults: number;
}

interface DbReputationRow {
  score: number;
  updated_at: string;
}

/**
 * Compare indexed Postgres state against canonical on-chain reads. Read-only
 * — issues no writes under any circumstance.
 */
export async function runReconciliationReport(
  options: ReconciliationOptions = {},
): Promise<ReconciliationReport> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const log = options.log ?? (() => {});
  const queryExec = options.queryFn ?? query;
  const simFn = options.simulateRead ?? simulateContractRead;
  const graceCutoff = Date.now() - graceMs;

  const differences: Difference[] = [];
  const unreadable: UnreadableEntity[] = [];
  const reputationSeen = new Set<string>();

  let circlesScanned = 0;
  let circlesSkippedGrace = 0;
  let membersScanned = 0;
  let reputationScanned = 0;
  let offset = 0;

  for (;;) {
    const rows = options.circleAddress
      ? await queryExec<DbCircleRow>(
          `SELECT address, status, current_round, total_rounds, member_count,
                  round_amount, updated_at
           FROM circles WHERE address = $1
           ORDER BY address LIMIT $2 OFFSET $3`,
          [options.circleAddress, pageSize, offset],
        )
      : await queryExec<DbCircleRow>(
          `SELECT address, status, current_round, total_rounds, member_count,
                  round_amount, updated_at
           FROM circles ORDER BY address LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

    if (rows.length === 0) break;

    for (const row of rows) {
      if (new Date(row.updated_at).getTime() > graceCutoff) {
        circlesSkippedGrace++;
        continue;
      }
      circlesScanned++;

      const canonical = await readCanonicalCircleState(row.address, simFn);
      if (!canonical.ok) {
        unreadable.push({ entity: "circle", key: row.address, error: canonical.error });
        continue;
      }

      const c = canonical.value;
      pushIfDifferent(differences, "circle", row.address, "status", row.status, c.status);
      pushIfDifferent(
        differences,
        "circle",
        row.address,
        "member_count",
        row.member_count,
        c.memberCount,
      );
      pushIfDifferent(
        differences,
        "circle",
        row.address,
        "total_rounds",
        row.total_rounds,
        c.totalRounds,
      );
      pushIfDifferent(
        differences,
        "circle",
        row.address,
        "round_amount",
        row.round_amount,
        c.roundAmount.toString(),
      );
      if (c.currentRound !== null) {
        pushIfDifferent(
          differences,
          "circle",
          row.address,
          "current_round",
          row.current_round,
          c.currentRound,
        );
      }

      const members = await queryExec<DbCircleMemberRow>(
        `SELECT member_address, collateral, defaults FROM circle_members WHERE circle_address = $1`,
        [row.address],
      );

      for (const m of members) {
        membersScanned++;
        const key = `${row.address}:${m.member_address}`;
        const memberScVal = new Address(m.member_address).toScVal();

        const [collateralResult, defaultsResult] = await Promise.all([
          simFn(row.address, row.address, "get_collateral", [memberScVal]),
          simFn(row.address, row.address, "get_defaults", [memberScVal]),
        ]);

        if (!collateralResult.ok) {
          unreadable.push({
            entity: "circle_member",
            key,
            error: `get_collateral: ${collateralResult.error}`,
          });
        } else {
          pushIfDifferent(
            differences,
            "circle_member",
            key,
            "collateral",
            m.collateral,
            String(collateralResult.value),
          );
        }

        if (!defaultsResult.ok) {
          unreadable.push({
            entity: "circle_member",
            key,
            error: `get_defaults: ${defaultsResult.error}`,
          });
        } else {
          pushIfDifferent(
            differences,
            "circle_member",
            key,
            "defaults",
            m.defaults,
            defaultsResult.value,
          );
        }

        if (reputationSeen.has(m.member_address)) continue;
        reputationSeen.add(m.member_address);

        const [repRow] = await queryExec<DbReputationRow>(
          `SELECT score, updated_at FROM reputation WHERE member_address = $1`,
          [m.member_address],
        );
        if (!repRow || new Date(repRow.updated_at).getTime() > graceCutoff) continue;

        reputationScanned++;
        const scoreResult = await simFn(
          REPUTATION_ADDRESS,
          REPUTATION_ADDRESS,
          "score",
          [memberScVal],
        );
        if (!scoreResult.ok) {
          unreadable.push({
            entity: "reputation",
            key: m.member_address,
            error: `score: ${scoreResult.error}`,
          });
        } else {
          pushIfDifferent(
            differences,
            "reputation",
            m.member_address,
            "score",
            repRow.score,
            scoreResult.value,
          );
        }
      }
    }

    log(
      `[reconcile] page done (offset=${offset}): ${circlesScanned} circle(s), ` +
        `${membersScanned} member(s), ${differences.length} difference(s) so far`,
    );
    offset += pageSize;
  }

  return {
    generatedAt: new Date().toISOString(),
    circlesScanned,
    circlesSkippedGrace,
    membersScanned,
    reputationScanned,
    unreadable,
    differences,
  };
}

// ── Repair mode ────────────────────────────────────────────────────────────────

export interface RepairOutcome extends Difference {
  outcome: "applied" | "skipped_stale" | "unsupported_field" | "error";
  error?: string;
}

export interface RepairOptions {
  /** Cap on how many differences are repaired in one run. */
  maxRepairs?: number;
  log?: (msg: string) => void;
}

export interface PlannedRepair {
  entity: Difference["entity"];
  /** circle address, or "circleAddress:memberAddress" for circle_member */
  key: string;
  field: string;
  indexed: string;
  canonical: string;
  supported: boolean;
  sqlPreview?: string;
}

export interface RepairPlan {
  generatedAt: string;
  dryRun: true;
  totalDifferences: number;
  capped: boolean;
  maxRepairs: number;
  skippedGrace: number;
  unreadable: UnreadableEntity[];
  plannedRepairs: PlannedRepair[];
  summary: {
    circlesScanned: number;
    circlesSkippedGrace: number;
    membersScanned: number;
    reputationScanned: number;
    differencesFound: number;
    plannedRepairs: number;
    unsupportedFields: number;
    unreadableCount: number;
  };
}

export interface PlanOptions {
  /** Maximum number of differences to include in the plan (default 500). */
  maxRepairs?: number;
}

export interface ApplyPlanOptions extends RepairOptions {
  /** Explicit confirmation required to mutate database. If false or omitted, mutation is rejected. */
  confirm?: boolean;
  queryFn?: QueryFn;
}

const CIRCLE_FIELD_SQL: Record<string, { column: string; cast: string }> = {
  status: { column: "status", cast: "text" },
  current_round: { column: "current_round", cast: "integer" },
  total_rounds: { column: "total_rounds", cast: "integer" },
  member_count: { column: "member_count", cast: "integer" },
  round_amount: { column: "round_amount", cast: "numeric" },
};

const CIRCLE_MEMBER_FIELD_SQL: Record<string, { column: string; cast: string }> = {
  collateral: { column: "collateral", cast: "numeric" },
  defaults: { column: "defaults", cast: "integer" },
};

/**
 * Check whether a field difference is supported by the automated repair mapping.
 */
export function isFieldSupported(entity: Difference["entity"], field: string): boolean {
  if (entity === "circle") return field in CIRCLE_FIELD_SQL;
  if (entity === "circle_member") return field in CIRCLE_MEMBER_FIELD_SQL;
  if (entity === "reputation") return field === "score";
  return false;
}

/**
 * Generates an SQL statement preview for human review in a dry-run plan.
 */
export function formatSqlPreview(diff: Difference): string | undefined {
  if (diff.entity === "circle") {
    const spec = CIRCLE_FIELD_SQL[diff.field];
    if (!spec) return undefined;
    return `UPDATE circles SET ${spec.column} = $1::${spec.cast}, updated_at = NOW() WHERE address = $2 AND ${spec.column} = $3::${spec.cast} [canonical='${diff.canonical}', key='${diff.key}', indexed='${diff.indexed}']`;
  }
  if (diff.entity === "circle_member") {
    const spec = CIRCLE_MEMBER_FIELD_SQL[diff.field];
    if (!spec) return undefined;
    const separatorIndex = diff.key.indexOf(":");
    const circleAddress = diff.key.slice(0, separatorIndex);
    const memberAddress = diff.key.slice(separatorIndex + 1);
    return `UPDATE circle_members SET ${spec.column} = $1::${spec.cast} WHERE circle_address = $2 AND member_address = $3 AND ${spec.column} = $4::${spec.cast} [canonical='${diff.canonical}', circle='${circleAddress}', member='${memberAddress}', indexed='${diff.indexed}']`;
  }
  if (diff.entity === "reputation" && diff.field === "score") {
    return `UPDATE reputation SET score = $1::integer, updated_at = NOW() WHERE member_address = $2 AND score = $3::integer [canonical='${diff.canonical}', key='${diff.key}', indexed='${diff.indexed}']`;
  }
  return undefined;
}

/**
 * Deterministic difference sorting for reproducible dry-run repair plans.
 */
export function compareDifferences(a: Difference, b: Difference): number {
  if (a.entity !== b.entity) return a.entity.localeCompare(b.entity);
  if (a.key !== b.key) return a.key.localeCompare(b.key);
  return a.field.localeCompare(b.field);
}

/**
 * Generate a deterministic, reproducible dry-run repair plan from a reconciliation report.
 * Validates that each planned field is supported and bounds the output by maxRepairs
 * so it is safe to attach to an incident report.
 */
export function createRepairPlan(
  report: ReconciliationReport,
  options: PlanOptions = {},
): RepairPlan {
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const sortedDiffs = [...report.differences].sort(compareDifferences);
  const totalDifferences = sortedDiffs.length;
  const capped = totalDifferences > maxRepairs;
  const toPlan = sortedDiffs.slice(0, maxRepairs);

  let unsupportedCount = 0;
  const plannedRepairs: PlannedRepair[] = toPlan.map((d) => {
    const supported = isFieldSupported(d.entity, d.field);
    if (!supported) unsupportedCount++;
    const sqlPreview = formatSqlPreview(d);
    return {
      entity: d.entity,
      key: d.key,
      field: d.field,
      indexed: d.indexed,
      canonical: d.canonical,
      supported,
      ...(sqlPreview ? { sqlPreview } : {}),
    };
  });

  return {
    generatedAt: report.generatedAt,
    dryRun: true,
    totalDifferences,
    capped,
    maxRepairs,
    skippedGrace: report.circlesSkippedGrace,
    unreadable: report.unreadable,
    plannedRepairs,
    summary: {
      circlesScanned: report.circlesScanned,
      circlesSkippedGrace: report.circlesSkippedGrace,
      membersScanned: report.membersScanned,
      reputationScanned: report.reputationScanned,
      differencesFound: totalDifferences,
      plannedRepairs: plannedRepairs.length,
      unsupportedFields: unsupportedCount,
      unreadableCount: report.unreadable.length,
    },
  };
}

/**
 * Conditional UPDATE guarded on the exact indexed value the difference was
 * computed from (`... AND <column> = <indexed>::cast`). If the row has since
 * changed — repaired by a previous run, or updated by a fresh event — the
 * WHERE clause matches zero rows and the repair is reported as
 * "skipped_stale" rather than overwriting newer data. This is what makes
 * repair safe to re-run.
 */
async function repairCircleField(
  diff: Difference | PlannedRepair,
  queryFn: QueryFn = query,
): Promise<boolean | null> {
  const spec = CIRCLE_FIELD_SQL[diff.field];
  if (!spec) return null;
  const rows = await queryFn<{ address: string }>(
    `UPDATE circles SET ${spec.column} = $1::${spec.cast}, updated_at = NOW()
     WHERE address = $2 AND ${spec.column} = $3::${spec.cast}
     RETURNING address`,
    [diff.canonical, diff.key, diff.indexed],
  );
  return rows.length > 0;
}

async function repairCircleMemberField(
  diff: Difference | PlannedRepair,
  queryFn: QueryFn = query,
): Promise<boolean | null> {
  const spec = CIRCLE_MEMBER_FIELD_SQL[diff.field];
  if (!spec) return null;
  const separatorIndex = diff.key.indexOf(":");
  const circleAddress = diff.key.slice(0, separatorIndex);
  const memberAddress = diff.key.slice(separatorIndex + 1);
  const rows = await queryFn<{ id: number }>(
    `UPDATE circle_members SET ${spec.column} = $1::${spec.cast}
     WHERE circle_address = $2 AND member_address = $3 AND ${spec.column} = $4::${spec.cast}
     RETURNING id`,
    [diff.canonical, circleAddress, memberAddress, diff.indexed],
  );
  return rows.length > 0;
}

async function repairReputationField(
  diff: Difference | PlannedRepair,
  queryFn: QueryFn = query,
): Promise<boolean | null> {
  if (diff.field !== "score") return null;
  const rows = await queryFn<{ member_address: string }>(
    `UPDATE reputation SET score = $1::integer, updated_at = NOW()
     WHERE member_address = $2 AND score = $3::integer
     RETURNING member_address`,
    [diff.canonical, diff.key, diff.indexed],
  );
  return rows.length > 0;
}

/**
 * Apply a pre-computed repair plan.
 *
 * Requires explicit confirmation (`confirm === true`).
 * Rechecks conditions before mutation via conditional UPDATE statements guarded
 * on the exact expected indexed value (`... AND <column> = <indexed>::cast`).
 * If a row was concurrently updated between preview and apply, the update matches
 * zero rows and is safely skipped as `skipped_stale`.
 */
export async function applyRepairPlan(
  plan: RepairPlan,
  options: ApplyPlanOptions = {},
  queryFn?: QueryFn,
): Promise<RepairOutcome[]> {
  if (options.confirm !== true) {
    throw new Error(
      "Mutation rejected: applying a repair plan requires explicit confirmation ({ confirm: true } or --confirm / --apply).",
    );
  }

  const queryExec = options.queryFn ?? queryFn ?? query;
  const log = options.log ?? (() => {});
  const outcomes: RepairOutcome[] = [];

  for (const item of plan.plannedRepairs) {
    if (!item.supported) {
      outcomes.push({
        entity: item.entity,
        key: item.key,
        field: item.field,
        indexed: item.indexed,
        canonical: item.canonical,
        outcome: "unsupported_field",
      });
      log(`[reconcile] unsupported field: ${item.entity} ${item.key} ${item.field}`);
      continue;
    }

    try {
      const applied =
        item.entity === "circle"
          ? await repairCircleField(item, queryExec)
          : item.entity === "circle_member"
          ? await repairCircleMemberField(item, queryExec)
          : await repairReputationField(item, queryExec);

      if (applied === null) {
        outcomes.push({
          entity: item.entity,
          key: item.key,
          field: item.field,
          indexed: item.indexed,
          canonical: item.canonical,
          outcome: "unsupported_field",
        });
      } else if (applied) {
        outcomes.push({
          entity: item.entity,
          key: item.key,
          field: item.field,
          indexed: item.indexed,
          canonical: item.canonical,
          outcome: "applied",
        });
        log(`[reconcile] repaired: ${item.entity} ${item.key} ${item.field} → ${item.canonical}`);
      } else {
        outcomes.push({
          entity: item.entity,
          key: item.key,
          field: item.field,
          indexed: item.indexed,
          canonical: item.canonical,
          outcome: "skipped_stale",
        });
        log(
          `[reconcile] skipped (stale): ${item.entity} ${item.key} ${item.field} (current value in DB differs from expected ${item.indexed})`,
        );
      }
    } catch (err) {
      outcomes.push({
        entity: item.entity,
        key: item.key,
        field: item.field,
        indexed: item.indexed,
        canonical: item.canonical,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}

/**
 * Apply canonical values for a list of differences (normally the output of
 * {@link runReconciliationReport} run immediately beforehand). Bounded by
 * `maxRepairs` so a large drift event does not turn into an unbounded write
 * burst — re-run repair to continue past the cap.
 */
export async function repairDifferences(
  differences: Difference[],
  options: RepairOptions = {},
  queryFn: QueryFn = query,
): Promise<RepairOutcome[]> {
  const dummyReport: ReconciliationReport = {
    generatedAt: new Date().toISOString(),
    circlesScanned: 0,
    circlesSkippedGrace: 0,
    membersScanned: 0,
    reputationScanned: 0,
    unreadable: [],
    differences,
  };
  const plan = createRepairPlan(dummyReport, { maxRepairs: options.maxRepairs });
  return applyRepairPlan(plan, { confirm: true, log: options.log }, queryFn);
}

// ── Pretty-printers ────────────────────────────────────────────────────────────

export function printReconciliationReport(report: ReconciliationReport): void {
  console.log("\n[reconcile] Reconciliation report");
  console.log("─".repeat(60));
  console.log(
    `  circles scanned: ${report.circlesScanned} ` +
      `(skipped, within grace window: ${report.circlesSkippedGrace})`,
  );
  console.log(`  members scanned: ${report.membersScanned}`);
  console.log(`  reputation rows scanned: ${report.reputationScanned}`);
  console.log(`  differences found: ${report.differences.length}`);
  console.log(`  entities unreadable on-chain: ${report.unreadable.length}`);

  if (report.differences.length > 0) {
    console.log("\n  Differences:");
    for (const d of report.differences) {
      console.log(
        `    • [${d.entity}] ${d.key} ${d.field}: indexed=${d.indexed} canonical=${d.canonical}`,
      );
    }
  }

  if (report.unreadable.length > 0) {
    console.log("\n  Unreadable (RPC/simulation failure — not counted as drift):");
    for (const u of report.unreadable) {
      console.log(`    • [${u.entity}] ${u.key}: ${u.error}`);
    }
  }

  console.log("─".repeat(60));
}

export function printRepairPlan(plan: RepairPlan): void {
  console.log("\n[reconcile] Dry-run repair plan (read-only preview)");
  console.log("─".repeat(60));
  console.log(`  generated at: ${plan.generatedAt}`);
  console.log(`  differences found: ${plan.totalDifferences}`);
  console.log(
    `  planned repairs: ${plan.plannedRepairs.length}` +
      (plan.capped ? ` (capped by maxRepairs=${plan.maxRepairs})` : ""),
  );
  console.log(`  skipped grace-window circles: ${plan.skippedGrace}`);
  console.log(`  unreadable entities: ${plan.unreadable.length}`);

  if (plan.plannedRepairs.length > 0) {
    console.log("\n  Planned field repairs:");
    for (const r of plan.plannedRepairs) {
      const statusTag = r.supported ? "[planned]" : "[unsupported]";
      console.log(
        `    • ${statusTag} ${r.entity} ${r.key} ${r.field}: ` +
          `current=${r.indexed} → canonical=${r.canonical}`,
      );
      if (r.sqlPreview) {
        console.log(`      preview: ${r.sqlPreview}`);
      }
    }
  } else {
    console.log("  No repairs planned (database is synchronized).");
  }

  if (plan.unreadable.length > 0) {
    console.log("\n  Unreadable state (excluded from repairs):");
    for (const u of plan.unreadable) {
      console.log(`    • [${u.entity}] ${u.key}: ${u.error}`);
    }
  }

  console.log("─".repeat(60));
  console.log(
    "  Mode: DRY-RUN. No changes were made to the database.\n" +
      "  To apply this plan, re-run with: --repair --confirm (or --apply)",
  );
  console.log("─".repeat(60));
}

export function printRepairOutcomes(outcomes: RepairOutcome[]): void {
  console.log("\n[reconcile] Repair outcomes");
  console.log("─".repeat(60));
  const applied = outcomes.filter((o) => o.outcome === "applied").length;
  const skipped = outcomes.filter((o) => o.outcome === "skipped_stale").length;
  const unsupported = outcomes.filter((o) => o.outcome === "unsupported_field").length;
  const errored = outcomes.filter((o) => o.outcome === "error").length;
  console.log(
    `  applied: ${applied}  skipped (stale): ${skipped}  ` +
      `unsupported: ${unsupported}  errors: ${errored}`,
  );
  for (const o of outcomes) {
    console.log(
      `    • [${o.outcome}] ${o.entity} ${o.key} ${o.field}` +
        (o.error ? ` — ${o.error}` : ""),
    );
  }
  console.log("─".repeat(60));
}

// ── CLI entry point ────────────────────────────────────────────────────────────
//
// Run directly:
//   ts-node src/db/reconcile.ts [--repair] [--confirm|--apply] [--dry-run] [--json]
//     [--circle=<address>] [--page-size=<n>] [--grace-ms=<n>] [--max-repairs=<n>]
//
// Flags:
//   --repair          Generate and apply repairs (requires --confirm or --apply to mutate;
//                      otherwise previews the dry-run plan).
//   --confirm         Confirm and execute repairs (alias: --apply).
//   --apply           Confirm and execute repairs (alias: --confirm).
//   --dry-run         Force dry-run plan output only.
//   --json            Output report, plan, and outcomes as JSON (safe for incidents).
//   --circle=<addr>   Restrict the scan to one circle.
//   --page-size=<n>   Circles fetched per DB page (default 100).
//   --grace-ms=<n>    Eventual-consistency tolerance window (default 30000).
//   --max-repairs=<n> Cap on repairs planned/applied in one run (default 500).

if (require.main === module) {
  withPoolCleanup(async () => {
    const args = process.argv.slice(2);
    const repair = args.includes("--repair");
    const confirm = args.includes("--confirm") || args.includes("--apply");
    const jsonOutput = args.includes("--json");
    const circleArg = args.find((a) => a.startsWith("--circle="));
    const pageSizeArg = args.find((a) => a.startsWith("--page-size="));
    const graceMsArg = args.find((a) => a.startsWith("--grace-ms="));
    const maxRepairsArg = args.find((a) => a.startsWith("--max-repairs="));

    const options: ReconciliationOptions = {
      log: jsonOutput ? () => {} : (msg) => console.log(msg),
      ...(circleArg ? { circleAddress: circleArg.replace("--circle=", "") } : {}),
      ...(pageSizeArg ? { pageSize: Number(pageSizeArg.replace("--page-size=", "")) } : {}),
      ...(graceMsArg ? { graceMs: Number(graceMsArg.replace("--grace-ms=", "")) } : {}),
    };

    const maxRepairs = maxRepairsArg
      ? Number(maxRepairsArg.replace("--max-repairs=", ""))
      : undefined;

    try {
      const report = await runReconciliationReport(options);
      const plan = createRepairPlan(report, { maxRepairs });

      if (jsonOutput) {
        if (repair && confirm) {
          const outcomes = await applyRepairPlan(plan, { confirm: true });
          console.log(JSON.stringify({ report, plan, outcomes }, null, 2));
        } else {
          console.log(JSON.stringify({ report, plan }, null, 2));
        }
        return;
      }

      printReconciliationReport(report);
      printRepairPlan(plan);

      if (repair) {
        if (!confirm) {
          console.log(
            "\n[reconcile] Notice: --repair was passed without --confirm or --apply.\n" +
              "  The above repair plan was simulated as a read-only dry-run.\n" +
              "  To execute the mutations, run: npm run reconcile:repair -- --confirm",
          );
        } else {
          console.log("\n[reconcile] Confirmation detected. Applying repair plan...");
          const outcomes = await applyRepairPlan(plan, {
            confirm: true,
            log: (msg) => console.log(msg),
          });
          printRepairOutcomes(outcomes);
        }
      }
    } catch (err) {
      console.error("[reconcile] Error:", err);
      throw err;
    }
  })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
