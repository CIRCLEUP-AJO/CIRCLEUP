/**
 * Issue 98: Detection of contradictory ledger responses and finality invariant verification.
 *
 * Consensus & Finality Architecture:
 * - Stellar Consensus Protocol (SCP) guarantees immediate, deterministic finality upon slot closing.
 * - Under normal operation, reorganizations/forks do not occur on Stellar.
 * - However, client-observable contradictions frequently arise from:
 *   1. Load-balanced Soroban RPC clusters where one replica lags behind the committed ledger.
 *   2. Node sequence regressions during validator restarts or failovers to older snapshots.
 *   3. Network partition leading to stale or partitioned ledger queries.
 *
 * Operational Policy:
 * - The indexer refuses to silently advance its cursor on contradictory ledger evidence.
 * - The indexer never attempts automatic destructive rollbacks because the underlying consensus
 *   remains forward-monotonic and immutable.
 * - Structured diagnostics are emitted with actionable remediation guidance.
 */

export type ContradictionType =
  | "SEQUENCE_REGRESSION"
  | "INCONSISTENT_EVENT_RANGE"
  | "LEDGER_IDENTITY_CONFLICT";

export interface LedgerContradictionEvidence {
  type: ContradictionType;
  durableLedger: number;
  observedLedger: number;
  observedId?: string;
  expectedId?: string;
  detail: string;
  remediation: string;
}

export class LedgerContradictionError extends Error {
  public readonly evidence: LedgerContradictionEvidence;

  constructor(evidence: LedgerContradictionEvidence) {
    super(
      `[LedgerContradiction] ${evidence.type}: Observed ledger ${evidence.observedLedger} contradicts durable ledger ${evidence.durableLedger}. ${evidence.detail}`,
    );
    this.name = "LedgerContradictionError";
    this.evidence = evidence;
  }
}

/**
 * Detect if the RPC's reported latest ledger has regressed behind the durable cursor.
 *
 * Time Complexity: O(1) integer comparison.
 * Space Complexity: O(1) diagnostic payload allocation.
 */
export function detectLedgerSequenceRegression(
  durableLastLedger: number,
  observedLatestLedger: number,
  observedId?: string,
): LedgerContradictionEvidence | null {
  if (durableLastLedger > 0 && observedLatestLedger < durableLastLedger) {
    return {
      type: "SEQUENCE_REGRESSION",
      durableLedger: durableLastLedger,
      observedLedger: observedLatestLedger,
      observedId,
      detail:
        `RPC latestLedger sequence (${observedLatestLedger}) has regressed behind indexer's committed cursor (${durableLastLedger}). ` +
        `This typically indicates routing to a lagging RPC replica or failover to an out-of-date node snapshot.`,
      remediation:
        "Verify RPC cluster load-balancer health. Isolate desynchronized nodes. Do not modify DB state manually; poller will resume once RPC catches up.",
    };
  }
  return null;
}

/**
 * Detect if returned event batches contain events outside the requested [fromLedger, toLedger] boundary.
 *
 * Time Complexity: O(N) where N is event count.
 * Space Complexity: O(1) auxiliary space.
 */
export function detectEventRangeContradiction(
  events: Array<{ ledger: number; id?: string }>,
  fromLedger: number,
  toLedger: number,
): LedgerContradictionEvidence | null {
  for (const ev of events) {
    if (ev.ledger < fromLedger) {
      return {
        type: "INCONSISTENT_EVENT_RANGE",
        durableLedger: fromLedger,
        observedLedger: ev.ledger,
        observedId: ev.id,
        detail:
          `Event ${ev.id ?? "unknown"} belongs to ledger ${ev.ledger}, which is lower than the queried range start (${fromLedger}).`,
        remediation:
          "Check RPC server pagination filters. Ensure node software version supports startLedger/cursor constraints.",
      };
    }
    if (ev.ledger > toLedger) {
      return {
        type: "INCONSISTENT_EVENT_RANGE",
        durableLedger: toLedger,
        observedLedger: ev.ledger,
        observedId: ev.id,
        detail:
          `Event ${ev.id ?? "unknown"} belongs to ledger ${ev.ledger}, which exceeds the maximum window ledger (${toLedger}).`,
        remediation:
          "Ensure indexer event pagination bounds results to the snapshot latestLedger.",
      };
    }
  }
  return null;
}
