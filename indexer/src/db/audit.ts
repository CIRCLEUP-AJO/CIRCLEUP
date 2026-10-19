/**
 * Issue #624: Read-only audit utilities for detecting projection inconsistencies.
 *
 * A reachable, schema-clean database can still contain inconsistent projections.
 * This module provides bounded SQL checks that detect drift in:
 *   - Event identities (duplicate/missing ledger+tx_hash+event_index)
 *   - Checkpoints (ledger gaps, orphaned checkpoints)
 *   - Derived circle state (status inconsistencies, round drift)
 *
 * Detection is strictly separate from repair or replay — this module never
 * mutates data. Callers decide what to do with the diagnostic output.
 *
 * Each check is bounded by configurable limits so audits complete predictably
 * even on large datasets.
 */

import { query, pool } from "./pool";

/**
 * Configuration for bounded audit execution.
 */
export interface AuditOptions {
  /** Maximum circles to scan in one pass (default: 1000). */
  maxCircles?: number;
  /** Maximum members per circle to check (default: 500). */
  maxMembersPerCircle?: number;
  /** Maximum ledgers to check for gaps (default: 10000). */
  maxLedgers?: number;
  /** Log progress messages (default: no-op). */
  log?: (msg: string) => void;
}

/**
 * Result of a single audit check.
 */
export interface AuditFinding {
  /** Unique identifier for this finding type. */
  checkId: string;
  /** Human-readable check name. */
  checkName: string;
  /** Severity level. */
  severity: "info" | "warning" | "error";
  /** Entity type affected. */
  entity: "event" | "checkpoint" | "circle" | "member";
  /** Human-readable description of the finding. */
  description: string;
  /** Evidence rows (limited sample). */
  evidence: Record<string, unknown>[];
  /** Count of total affected entities. */
  affectedCount: number;
  /** Remediation guidance. */
  remediation: string;
}

/**
 * Complete audit report.
 */
export interface AuditReport {
  generatedAt: string;
  checksRun: number;
  findings: AuditFinding[];
  /** Summary counts by severity. */
  summary: {
    info: number;
    warning: number;
    error: number;
  };
}

/**
 * Default audit options.
 */
const DEFAULT_OPTIONS: Required<AuditOptions> = {
  maxCircles: 1000,
  maxMembersPerCircle: 500,
  maxLedgers: 10000,
  log: () => {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Check 1: Duplicate event identities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect duplicate event identities in ingested_events.
 * A well-formed indexer should never have two rows with the same
 * (ledger, tx_hash, event_index) — this would indicate duplicate ingestion
 * that slipped past the ON CONFLICT guard, or a unique-index violation.
 */
export async function checkDuplicateEventIdentities(
  opts: AuditOptions = {},
): Promise<AuditFinding> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const log = options.log;

  log("[audit] Checking duplicate event identities...");

  // Find duplicate (ledger, tx_hash, event_index) combinations
  const duplicates = await query<{
    ledger: string;
    tx_hash: string;
    event_index: number | null;
    count: string;
  }>(
    `SELECT ledger, tx_hash, event_index, COUNT(*) as count
     FROM ingested_events
     WHERE event_index IS NOT NULL
     GROUP BY ledger, tx_hash, event_index
     HAVING COUNT(*) > 1
     LIMIT 10`,
  );

  // Get total count
  const [totals] = await query<{ total: string }>(
    `SELECT COUNT(*) as total FROM (
      SELECT ledger, tx_hash, event_index
      FROM ingested_events
      WHERE event_index IS NOT NULL
      GROUP BY ledger, tx_hash, event_index
      HAVING COUNT(*) > 1
    ) AS duplicates`,
  );

  const affectedCount = Number(totals?.total ?? 0);

  return {
    checkId: "duplicate-event-identities",
    checkName: "Duplicate Event Identities",
    severity: affectedCount > 0 ? "error" : "info",
    entity: "event",
    description:
      affectedCount > 0
        ? `Found ${affectedCount} duplicate event identity group(s) in ingested_events`
        : "No duplicate event identities found",
    evidence: duplicates.map((d) => ({
      ledger: d.ledger,
      txHash: d.tx_hash?.slice(0, 8) + "...",
      eventIndex: d.event_index,
      count: Number(d.count),
    })),
    affectedCount,
    remediation:
      affectedCount > 0
        ? "Run a full replay from the earliest duplicate ledger, or manually delete the duplicate rows keeping the oldest."
        : "No action needed.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2: Ledger checkpoint gaps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect gaps in ledger_checkpoints and validate cursor consistency.
 * Checkpoints should exist for every ledger that was processed. Gaps may
 * indicate a crash mid-batch where the cursor advanced but the checkpoint
 * wasn't written, or duplicate-ledger processing.
 */
export async function checkLedgerCheckpointGaps(
  opts: AuditOptions = {},
): Promise<AuditFinding> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const log = options.log;

  log("[audit] Checking ledger checkpoint gaps...");

  // Get min/max ledgers from both tables to establish range
  const [range] = await query<{
    min_ledger: string;
    max_ledger: string;
    last_indexed: string;
  }>(
    `SELECT 
       COALESCE(MIN(lc.ledger), 0) as min_ledger,
       COALESCE(MAX(lc.ledger), 0) as max_ledger,
       COALESCE(MAX(is.last_ledger), 0) as last_indexed
     FROM ledger_checkpoints lc
     CROSS JOIN (SELECT last_ledger FROM indexer_state WHERE id = 1) is`,
  );

  const lastIndexed = Number(range?.last_indexed ?? 0);
  const maxCheckpoint = Number(range?.max_ledger ?? 0);

  if (maxCheckpoint === 0) {
    return {
      checkId: "ledger-checkpoint-gaps",
      checkName: "Ledger Checkpoint Gaps",
      severity: "info",
      entity: "checkpoint",
      description: "No checkpoints recorded yet",
      evidence: [],
      affectedCount: 0,
      remediation: "No action needed — indexer hasn't processed any ledgers yet.",
    };
  }

  // Detect gaps in checkpoint sequence
  const gaps = await query<{ gap_start: string; gap_end: string; missing_count: string }>(
    `SELECT 
       (lc1.ledger + 1)::text as gap_start,
       (lc2.ledger - 1)::text as gap_end,
       (lc2.ledger - lc1.ledger - 1)::text as missing_count
     FROM ledger_checkpoints lc1
     JOIN ledger_checkpoints lc2 ON lc2.ledger = (
       SELECT MIN(ledger) FROM ledger_checkpoints WHERE ledger > lc1.ledger
     )
     WHERE lc2.ledger - lc1.ledger > 1
     ORDER BY lc1.ledger
     LIMIT 10`,
  );

  // Check if indexer state cursor is ahead of any checkpoint
  const cursorAhead = await query<{
    last_indexed: string;
    max_checkpoint: string;
  }>(
    `SELECT 
       (SELECT last_ledger FROM indexer_state WHERE id = 1) as last_indexed,
       (SELECT MAX(ledger) FROM ledger_checkpoints) as max_checkpoint`,
  );

  const cursorAheadCount = Number(cursorAhead[0]?.last_indexed ?? 0) > Number(cursorAhead[0]?.max_checkpoint ?? 0)
    ? Number(cursorAhead[0]?.last_indexed) - Number(cursorAhead[0]?.max_checkpoint)
    : 0;

  const affectedCount = gaps.length + (cursorAheadCount > 0 ? 1 : 0);

  return {
    checkId: "ledger-checkpoint-gaps",
    checkName: "Ledger Checkpoint Gaps",
    severity: affectedCount > 0 ? "warning" : "info",
    entity: "checkpoint",
    description:
      affectedCount > 0
        ? `Found ${gaps.length} ledger gap(s) and cursor ahead of checkpoints by ${cursorAheadCount} ledger(s)`
        : "All ledger checkpoints are continuous",
    evidence: [
      ...gaps.map((g) => ({
        type: "gap",
        fromLedger: g.gap_start,
        toLedger: g.gap_end,
        missingLedgers: Number(g.missing_count),
      })),
      ...(cursorAheadCount > 0
        ? [
            {
              type: "cursor_ahead",
              lastIndexed,
              maxCheckpoint,
              difference: cursorAheadCount,
            },
          ]
        : []),
    ],
    affectedCount,
    remediation:
      affectedCount > 0
        ? "If gaps: re-run the indexer from the first gap ledger. If cursor ahead: this is normal during active processing."
        : "No action needed.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 3: Circle status consistency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect circles with inconsistent status projections.
 * Valid status transitions: Pending -> Active -> Completed
 *                         Pending -> Cancelled
 *                         Active -> Closed (via close())
 * A circle cannot regress to a prior status.
 */
export async function checkCircleStatusConsistency(
  opts: AuditOptions = {},
): Promise<AuditFinding> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const log = options.log;

  log("[audit] Checking circle status consistency...");

  // Find circles where status ordering is violated
  const statusViolations = await query<{
    address: string;
    current_round: number;
    total_rounds: number;
    status: string;
  }>(
    `SELECT address, current_round, total_rounds, status
     FROM circles
     WHERE 
       (status = 'Completed' AND current_round != total_rounds)
       OR (status = 'Active' AND current_round >= total_rounds)
       OR (status = 'Pending' AND current_round > 0)
     ORDER BY updated_at DESC
     LIMIT $1`,
    [options.maxCircles],
  );

  // Check for circles stuck at Pending beyond reasonable time (e.g., > 1000 ledgers since creation)
  const stuckPending = await query<{
    address: string;
    created_ledger: string;
    last_ledger: string;
    ledgers_since_creation: string;
  }>(
    `SELECT c.address, c.created_ledger, 
            (SELECT last_ledger FROM indexer_state WHERE id = 1) as last_ledger,
            ((SELECT last_ledger FROM indexer_state WHERE id = 1) - c.created_ledger) as ledgers_since_creation
     FROM circles c
     WHERE c.status = 'Pending'
       AND ((SELECT last_ledger FROM indexer_state WHERE id = 1) - c.created_ledger) > 1000
     ORDER BY c.created_ledger ASC
     LIMIT 10`,
  );

  const affectedCount = statusViolations.length + stuckPending.length;

  return {
    checkId: "circle-status-consistency",
    checkName: "Circle Status Consistency",
    severity: affectedCount > 0 ? "warning" : "info",
    entity: "circle",
    description:
      affectedCount > 0
        ? `Found ${statusViolations.length} status violation(s) and ${stuckPending.length} stuck-pending circle(s)`
        : "All circles have consistent status projections",
    evidence: [
      ...statusViolations.map((c) => ({
        type: "status_violation",
        address: c.address.slice(0, 8) + "...",
        currentRound: c.current_round,
        totalRounds: c.total_rounds,
        status: c.status,
      })),
      ...stuckPending.map((c) => ({
        type: "stuck_pending",
        address: c.address.slice(0, 8) + "...",
        createdLedger: c.created_ledger,
        ledgersSinceCreation: Number(c.ledgers_since_creation),
      })),
    ],
    affectedCount,
    remediation:
      affectedCount > 0
        ? "Status violations may indicate indexer bugs — investigate the affected circles manually. Stuck Pending circles may need manual resolution or member action."
        : "No action needed.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 4: Circle round drift
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect drift between current_round and actual round activity.
 * current_round should equal the highest round_index with any activity
 * (contributions, payouts, defaults) + 1 (for the active round).
 */
export async function checkCircleRoundDrift(
  opts: AuditOptions = {},
): Promise<AuditFinding> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const log = options.log;

  log("[audit] Checking circle round drift...");

  // Find circles where current_round doesn't match the latest activity
  const drift = await query<{
    address: string;
    current_round: number;
    max_round_index: number;
    has_payout: boolean;
    has_contributions: boolean;
  }>(
    `SELECT 
       c.address,
       c.current_round,
       COALESCE(MAX(COALESCE(p.round_index, 0)), 0) as max_round_index,
       COUNT(DISTINCT p.round_index) > 0 as has_payout,
       COUNT(DISTINCT cn.round_index) > 0 as has_contributions
     FROM circles c
     LEFT JOIN payouts p ON p.circle_address = c.address
     LEFT JOIN contributions cn ON cn.circle_address = c.address
     WHERE c.status IN ('Active', 'Completed')
     GROUP BY c.address, c.current_round
     HAVING c.current_round != COALESCE(MAX(COALESCE(p.round_index, 0)), 0) + 1
     ORDER BY c.updated_at DESC
     LIMIT $1`,
    [options.maxCircles],
  );

  return {
    checkId: "circle-round-drift",
    checkName: "Circle Round Drift",
    severity: drift.length > 0 ? "warning" : "info",
    entity: "circle",
    description:
      drift.length > 0
        ? `Found ${drift.length} circle(s) with round drift`
        : "All active circles have consistent round projections",
    evidence: drift.map((d) => ({
      address: d.address.slice(0, 8) + "...",
      currentRound: d.current_round,
      maxIndexedRound: d.max_round_index,
      hasPayout: d.has_payout,
      hasContributions: d.has_contributions,
    })),
    affectedCount: drift.length,
    remediation:
      drift.length > 0
        ? "Round drift may indicate missed payout/round_started events — consider re-indexing from the circle's creation ledger."
        : "No action needed.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 5: Orphaned member records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect circle_members records without a corresponding circle, or
 * circles without any members.
 */
export async function checkOrphanedMembers(
  opts: AuditOptions = {},
): Promise<AuditFinding> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const log = options.log;

  log("[audit] Checking orphaned member records...");

  // Members without a circle
  const orphanedMembers = await query<{
    circle_address: string;
    member_address: string;
  }>(
    `SELECT cm.circle_address, cm.member_address
     FROM circle_members cm
     LEFT JOIN circles c ON c.address = cm.circle_address
     WHERE c.address IS NULL
     LIMIT 10`,
  );

  // Circles without members
  const circlesWithoutMembers = await query<{
    address: string;
    member_count: number;
  }>(
    `SELECT c.address, c.member_count
     FROM circles c
     WHERE c.member_count > 0
       AND NOT EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_address = c.address)
     LIMIT 10`,
  );

  const affectedCount = orphanedMembers.length + circlesWithoutMembers.length;

  return {
    checkId: "orphaned-member-records",
    checkName: "Orphaned Member Records",
    severity: affectedCount > 0 ? "error" : "info",
    entity: "member",
    description:
      affectedCount > 0
        ? `Found ${orphanedMembers.length} orphaned member(s) and ${circlesWithoutMembers.length} circle(s) without members`
        : "All member records are properly linked",
    evidence: [
      ...orphanedMembers.map((m) => ({
        type: "orphaned_member",
        circleAddress: m.circle_address.slice(0, 8) + "...",
        memberAddress: m.member_address.slice(0, 8) + "...",
      })),
      ...circlesWithoutMembers.map((c) => ({
        type: "circle_without_members",
        address: c.address.slice(0, 8) + "...",
        declaredMemberCount: c.member_count,
      })),
    ],
    affectedCount,
    remediation:
      affectedCount > 0
        ? "Orphaned members: delete or re-link to valid circles. Circles without members: investigate — these may be partially-indexed circles."
        : "No action needed.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 6: Contribution/consistency for valid circles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect circles where contribution counts are inconsistent with expected values.
 * Each active round should have exactly member_count contributions.
 */
export async function checkContributionConsistency(
  opts: AuditOptions = {},
): Promise<AuditFinding> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const log = options.log;

  log("[audit] Checking contribution consistency...");

  // Find rounds where contribution count != member_count for non-defaulted rounds
  const inconsistent = await query<{
    address: string;
    round_index: number;
    actual_contributions: string;
    expected_contributions: string;
  }>(
    `SELECT 
       c.address,
       p.round_index,
       COALESCE(cn.actual_count, 0)::text as actual_contributions,
       c.member_count::text as expected_contributions
     FROM circles c
     JOIN payouts p ON p.circle_address = c.address
     LEFT JOIN (
       SELECT circle_address, round_index, COUNT(*) as actual_count
       FROM contributions
       GROUP BY circle_address, round_index
     ) cn ON cn.circle_address = p.circle_address AND cn.round_index = p.round_index
     WHERE cn.actual_count != c.member_count
     ORDER BY c.updated_at DESC
     LIMIT $1`,
    [options.maxCircles],
  );

  return {
    checkId: "contribution-consistency",
    checkName: "Contribution Consistency",
    severity: inconsistent.length > 0 ? "error" : "info",
    entity: "circle",
    description:
      inconsistent.length > 0
        ? `Found ${inconsistent.length} round(s) with contribution count mismatch`
        : "All rounds have correct contribution counts",
    evidence: inconsistent.map((i) => ({
      address: i.address.slice(0, 8) + "...",
      roundIndex: i.round_index,
      actual: i.actual_contributions,
      expected: i.expected_contributions,
    })),
    affectedCount: inconsistent.length,
    remediation:
      inconsistent.length > 0
        ? "This may indicate missed contribution events or malformed events — investigate or re-index from the circle's creation."
        : "No action needed.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main audit runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all bounded audit checks and produce a report.
 *
 * This function is read-only — it never modifies the database.
 * Each check is bounded by the provided options to ensure predictable runtime.
 */
export async function runAudit(options: AuditOptions = {}): Promise<AuditReport> {
  const log = options.log ?? (() => {});

  log("[audit] Starting bounded audit scan...");

  const findings: AuditFinding[] = [
    await checkDuplicateEventIdentities(options),
    await checkLedgerCheckpointGaps(options),
    await checkCircleStatusConsistency(options),
    await checkCircleRoundDrift(options),
    await checkOrphanedMembers(options),
    await checkContributionConsistency(options),
  ];

  const summary = {
    info: findings.filter((f) => f.severity === "info").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    error: findings.filter((f) => f.severity === "error").length,
  };

  log(`[audit] Complete: ${summary.info} info, ${summary.warning} warnings, ${summary.error} errors`);

  return {
    generatedAt: new Date().toISOString(),
    checksRun: findings.length,
    findings,
    summary,
  };
}

/**
 * Pretty-print an audit report to console.
 */
export function printAuditReport(report: AuditReport): void {
  console.log("\n" + "═".repeat(70));
  console.log(" CircleUp Indexer Audit Report");
  console.log("═".repeat(70));
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Checks run: ${report.checksRun}`);
  console.log("");
  console.log(`Summary: ${report.summary.info} info, ${report.summary.warning} warnings, ${report.summary.error} errors`);
  console.log("");

  if (report.findings.length === 0) {
    console.log("No findings.");
  } else {
    for (const finding of report.findings) {
      const severityIcon = finding.severity === "error" ? "✗" : finding.severity === "warning" ? "⚠" : "✓";
      console.log(`[${severityIcon}] ${finding.checkName} (${finding.severity})`);
      console.log(`    ${finding.description}`);
      if (finding.evidence.length > 0) {
        console.log(`    Evidence (${finding.affectedCount} affected):`);
        for (const ev of finding.evidence.slice(0, 5)) {
          console.log(`      - ${JSON.stringify(ev)}`);
        }
        if (finding.evidence.length > 5) {
          console.log(`      ... and ${finding.evidence.length - 5} more`);
        }
      }
      console.log(`    Remediation: ${finding.remediation}`);
      console.log("");
    }
  }

  console.log("═".repeat(70));
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const maxCirclesArg = args.find((a) => a.startsWith("--max-circles="));
    const maxLedgersArg = args.find((a) => a.startsWith("--max-ledgers="));

    const options: AuditOptions = {
      log: (msg) => console.log(msg),
      ...(maxCirclesArg
        ? { maxCircles: Number(maxCirclesArg.replace("--max-circles=", "")) }
        : {}),
      ...(maxLedgersArg
        ? { maxLedgers: Number(maxLedgersArg.replace("--max-ledgers=", "")) }
        : {}),
    };

    try {
      const report = await runAudit(options);
      printAuditReport(report);

      // Exit with error if any findings of severity "error" exist
      const hasErrors = report.summary.error > 0;
      await pool.end();
      process.exit(hasErrors ? 1 : 0);
    } catch (err) {
      console.error("[audit] Error:", err);
      await pool.end();
      process.exit(1);
    }
  })();
}