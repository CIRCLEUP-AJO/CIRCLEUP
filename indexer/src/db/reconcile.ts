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
import { query, pool } from "./pool";
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

type SimResult<T> = { ok: true; value: T } | { ok: false; error: string };

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
): Promise<SimResult<CanonicalCircleState>> {
  const [statusResult, configResult, roundResult] = await Promise.all([
    simulateContractRead(circleAddress, circleAddress, "get_status"),
    simulateContractRead(circleAddress, circleAddress, "get_config"),
    simulateContractRead(circleAddress, circleAddress, "get_current_round"),
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
      ? await query<DbCircleRow>(
          `SELECT address, status, current_round, total_rounds, member_count,
                  round_amount, updated_at
           FROM circles WHERE address = $1
           ORDER BY address LIMIT $2 OFFSET $3`,
          [options.circleAddress, pageSize, offset],
        )
      : await query<DbCircleRow>(
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

      const canonical = await readCanonicalCircleState(row.address);
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

      const members = await query<DbCircleMemberRow>(
        `SELECT member_address, collateral, defaults FROM circle_members WHERE circle_address = $1`,
        [row.address],
      );

      for (const m of members) {
        membersScanned++;
        const key = `${row.address}:${m.member_address}`;
        const memberScVal = new Address(m.member_address).toScVal();

        const [collateralResult, defaultsResult] = await Promise.all([
          simulateContractRead(row.address, row.address, "get_collateral", [memberScVal]),
          simulateContractRead(row.address, row.address, "get_defaults", [memberScVal]),
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

        const [repRow] = await query<DbReputationRow>(
          `SELECT score, updated_at FROM reputation WHERE member_address = $1`,
          [m.member_address],
        );
        if (!repRow || new Date(repRow.updated_at).getTime() > graceCutoff) continue;

        reputationScanned++;
        const scoreResult = await simulateContractRead(
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
 * Conditional UPDATE guarded on the exact indexed value the difference was
 * computed from (`... AND <column> = <indexed>::cast`). If the row has since
 * changed — repaired by a previous run, or updated by a fresh event — the
 * WHERE clause matches zero rows and the repair is reported as
 * "skipped_stale" rather than overwriting newer data. This is what makes
 * repair safe to re-run.
 */
async function repairCircleField(diff: Difference): Promise<boolean | null> {
  const spec = CIRCLE_FIELD_SQL[diff.field];
  if (!spec) return null;
  const rows = await query<{ address: string }>(
    `UPDATE circles SET ${spec.column} = $1::${spec.cast}, updated_at = NOW()
     WHERE address = $2 AND ${spec.column} = $3::${spec.cast}
     RETURNING address`,
    [diff.canonical, diff.key, diff.indexed],
  );
  return rows.length > 0;
}

async function repairCircleMemberField(diff: Difference): Promise<boolean | null> {
  const spec = CIRCLE_MEMBER_FIELD_SQL[diff.field];
  if (!spec) return null;
  const separatorIndex = diff.key.indexOf(":");
  const circleAddress = diff.key.slice(0, separatorIndex);
  const memberAddress = diff.key.slice(separatorIndex + 1);
  const rows = await query<{ id: number }>(
    `UPDATE circle_members SET ${spec.column} = $1::${spec.cast}
     WHERE circle_address = $2 AND member_address = $3 AND ${spec.column} = $4::${spec.cast}
     RETURNING id`,
    [diff.canonical, circleAddress, memberAddress, diff.indexed],
  );
  return rows.length > 0;
}

async function repairReputationField(diff: Difference): Promise<boolean | null> {
  if (diff.field !== "score") return null;
  const rows = await query<{ member_address: string }>(
    `UPDATE reputation SET score = $1::integer, updated_at = NOW()
     WHERE member_address = $2 AND score = $3::integer
     RETURNING member_address`,
    [diff.canonical, diff.key, diff.indexed],
  );
  return rows.length > 0;
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
): Promise<RepairOutcome[]> {
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const log = options.log ?? (() => {});
  const outcomes: RepairOutcome[] = [];

  const toApply = differences.slice(0, maxRepairs);
  if (differences.length > maxRepairs) {
    log(
      `[reconcile] ${differences.length} difference(s) found; maxRepairs=${maxRepairs} caps this run — ` +
        `re-run repair to continue with the remainder.`,
    );
  }

  for (const diff of toApply) {
    try {
      const applied =
        diff.entity === "circle"
          ? await repairCircleField(diff)
          : diff.entity === "circle_member"
          ? await repairCircleMemberField(diff)
          : await repairReputationField(diff);

      if (applied === null) {
        outcomes.push({ ...diff, outcome: "unsupported_field" });
        continue;
      }

      outcomes.push({ ...diff, outcome: applied ? "applied" : "skipped_stale" });
      log(
        `[reconcile] ${applied ? "repaired" : "skipped (stale)"}: ` +
          `${diff.entity} ${diff.key} ${diff.field} → ${diff.canonical}`,
      );
    } catch (err) {
      outcomes.push({
        ...diff,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
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
//   ts-node src/db/reconcile.ts [--repair] [--circle=<address>]
//     [--page-size=<n>] [--grace-ms=<n>] [--max-repairs=<n>]
//
// Flags:
//   --repair          Apply canonical values for the differences found
//                      (default is report-only; never mutates data).
//   --circle=<addr>   Restrict the scan to one circle.
//   --page-size=<n>   Circles fetched per DB page (default 100).
//   --grace-ms=<n>    Eventual-consistency tolerance window (default 30000).
//   --max-repairs=<n> Cap on repairs applied in one run (default 500).

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const repair = args.includes("--repair");
    const circleArg = args.find((a) => a.startsWith("--circle="));
    const pageSizeArg = args.find((a) => a.startsWith("--page-size="));
    const graceMsArg = args.find((a) => a.startsWith("--grace-ms="));
    const maxRepairsArg = args.find((a) => a.startsWith("--max-repairs="));

    const options: ReconciliationOptions = {
      log: (msg) => console.log(msg),
      ...(circleArg ? { circleAddress: circleArg.replace("--circle=", "") } : {}),
      ...(pageSizeArg ? { pageSize: Number(pageSizeArg.replace("--page-size=", "")) } : {}),
      ...(graceMsArg ? { graceMs: Number(graceMsArg.replace("--grace-ms=", "")) } : {}),
    };

    try {
      const report = await runReconciliationReport(options);
      printReconciliationReport(report);

      if (repair) {
        const maxRepairs = maxRepairsArg
          ? Number(maxRepairsArg.replace("--max-repairs=", ""))
          : undefined;
        const outcomes = await repairDifferences(report.differences, {
          maxRepairs,
          log: (msg) => console.log(msg),
        });
        printRepairOutcomes(outcomes);
      }

      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error("[reconcile] Error:", err);
      await pool.end();
      process.exit(1);
    }
  })();
}
