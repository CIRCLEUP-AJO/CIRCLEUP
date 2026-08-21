/**
 * CircleUp Event Indexer
 *
 * Polls the Stellar Soroban RPC for events emitted by the factory, circle,
 * and reputation contracts and writes them into Postgres.
 *
 * Events consumed:
 *   factory/circle_created  → inserts circles + circle_members rows
 *   circle/joined            → updates circle_members.joined_at
 *   circle/active            → updates circles.status = 'Active'
 *   circle/contributed       → inserts contributions row
 *   circle/payout            → inserts payouts row, updates circles.current_round
 *   circle/default           → inserts defaults row
 *   circle/completed         → updates circles.status = 'Completed'
 *   reputation/increment     → upserts reputation row
 *
 * Ordering and durability guarantees:
 *   - Events are processed in canonical ledger order (ascending sequence).
 *   - All events for a single ledger are committed in one transaction together
 *     with the indexer_state.last_ledger advance and a ledger_checkpoints row.
 *     Either all commit or all roll back — no partial ledger state.
 *   - ingested_events.event_key provides exactly-once semantics: duplicate or
 *     replayed events are skipped inside the same transaction.
 *   - On crash or restart the indexer resumes from the last durable ledger
 *     boundary recorded in indexer_state.last_ledger.
 *   - Operators can replay a ledger range via replayLedgerRange() without
 *     manual DB surgery.
 */

import { SorobanRpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./db/pool";
import {
  STELLAR_RPC_URL,
  CIRCLE_FACTORY_ADDRESS,
  REPUTATION_ADDRESS,
  USDC_ADDRESS,
  START_LEDGER,
  POLL_INTERVAL_MS,
  EVENTS_LIMIT,
} from "./config";

export const rpc = new SorobanRpc.Server(STELLAR_RPC_URL, {
  allowHttp: true,
});

const FACTORY = CIRCLE_FACTORY_ADDRESS;
const REPUTATION = REPUTATION_ADDRESS;
// Not consumed by any on-chain call today — the indexer doesn't need to
// distinguish contribution assets — but validated at startup and surfaced via
// GET /health so operators can confirm the indexer and app agree on which
// USDC token they're tracking.
export const USDC = USDC_ADDRESS;

// ─── RPC abstraction (injectable for tests) ───────────────────────────────────

/** Minimal RPC surface the indexer uses — lets tests inject a fake. */
export type RpcLike = Pick<SorobanRpc.Server, "getEvents" | "getLatestLedger">;

// Module-level override populated only during tests via _setRpcForTesting().
let _rpcForTesting: RpcLike | null = null;

/** Test-only: override the live RPC client.  Pass null to restore the real one. */
export function _setRpcForTesting(client: RpcLike | null): void {
  _rpcForTesting = client;
}

function activeRpc(): RpcLike {
  return _rpcForTesting ?? rpc;
}

// ─── Soroban RPC retry ───────────────────────────────────────────────────────
//
// getEvents / getLatestLedger fail transiently under RPC rate limits, brief
// network blips, and 5xx responses. Without an in-cycle retry the poll loop
// would skip the whole ledger range until the next interval, delaying ingest
// and flooding logs with one-shot errors.

const RPC_RETRY_MAX_ATTEMPTS = parseInt(
  process.env.RPC_RETRY_MAX_ATTEMPTS || "4",
  10,
);
const RPC_RETRY_BASE_DELAY_MS = parseInt(
  process.env.RPC_RETRY_BASE_DELAY_MS || "500",
  10,
);

/** Error codes / substrings that are safe to retry. Exported for unit tests. */
export function isTransientRpcError(err: unknown): boolean {
  if (err == null) return false;

  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }

  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("network") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout")
  );
}

function describeRpcError(err: unknown): string {
  if (err instanceof Error) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/**
 * Run an RPC call with exponential backoff on transient failures.
 * Non-transient errors (malformed request, auth, etc.) fail immediately.
 * Exported for unit tests.
 */
export async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  {
    maxAttempts = RPC_RETRY_MAX_ATTEMPTS,
    baseDelayMs = RPC_RETRY_BASE_DELAY_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    maxAttempts?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  let lastErr: unknown;
  const attempts = Math.max(1, maxAttempts);
  let tried = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    tried = attempt;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = isTransientRpcError(err);
      if (!transient || attempt === attempts) {
        break;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[indexer] Transient RPC failure during ${label} ` +
          `(attempt ${attempt}/${attempts}): ${describeRpcError(err)} ` +
          `— retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(
    `[indexer] Soroban RPC ${label} failed after ${tried} attempt(s): ` +
      describeRpcError(lastErr),
  );
}

// The SDK's getEvents returns EventResponse; extract the string contractId safely.
type SdkEvent = SorobanRpc.Api.EventResponse;

// getEvents return shape — used for explicit generic annotation on withRpcRetry
// to avoid TypeScript losing the type through the activeRpc() indirection when
// @stellar/stellar-sdk is not yet installed in CI (TS infers unknown otherwise).
type GetEventsPage = { events: SdkEvent[] };

function getContractIdStr(event: SdkEvent): string | null {
  const c = event.contractId;
  if (!c) return null;
  if (typeof c === "string") return c;
  // Contract object — call toString() which returns the strkey
  if (typeof (c as { toString?: () => string }).toString === "function") {
    return (c as { toString: () => string }).toString();
  }
  return null;
}

function getTopicStr(event: SdkEvent, idx: number): string {
  // In EventResponse, topic entries are already xdr.ScVal objects
  const val = event.topic[idx];
  return scValToNative(val as xdr.ScVal) as string;
}

function getValueNative(event: SdkEvent): unknown {
  // In EventResponse, value is already an xdr.ScVal object
  return scValToNative(event.value as xdr.ScVal);
}

function normalizeForKey(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => normalizeForKey(item)).join(",")}]`;
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function createEventKey(event: SdkEvent): string {
  const contractId = getContractIdStr(event) ?? "";
  const topicParts = (event.topic ?? []).map((topic) => normalizeForKey(scValToNative(topic as xdr.ScVal)));
  return [
    event.ledger ?? 0,
    event.txHash ?? "",
    contractId,
    topicParts.join("|"),
    normalizeForKey(getValueNative(event)),
  ].join(":");
}

// ─── Ledger grouping ──────────────────────────────────────────────────────────

/**
 * Group a flat event list by ledger sequence number, returning a Map ordered
 * by ascending ledger so callers can iterate in canonical Stellar order.
 * Exported for unit tests.
 */
export function groupEventsByLedger(events: SdkEvent[]): Map<number, SdkEvent[]> {
  const byLedger = new Map<number, SdkEvent[]>();
  for (const event of events) {
    const ledger = event.ledger;
    if (!byLedger.has(ledger)) byLedger.set(ledger, []);
    byLedger.get(ledger)!.push(event);
  }
  // Sort ascending so processing is always ledger-ordered regardless of RPC
  // return order.
  return new Map([...byLedger.entries()].sort(([a], [b]) => a - b));
}

// ─── In-transaction event ingest ─────────────────────────────────────────────

/**
 * Attempt to ingest one event within an already-open Postgres transaction.
 * Returns true when the event was new and its handler ran successfully.
 * Returns false when the event_key already exists in ingested_events (duplicate
 * or replay — skipped without error).
 * Throws when the handler itself throws — the caller's transaction will roll
 * back, preserving the no-partial-state invariant for the whole ledger.
 */
async function ingestEventInTx(
  client: PoolClient,
  event: SdkEvent,
  handleEvent: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  const eventKey = createEventKey(event);

  const existing = await client.query<{ event_key: string }>(
    "SELECT event_key FROM ingested_events WHERE event_key = $1",
    [eventKey],
  );
  if (existing.rows.length > 0) return false;

  const contractId = getContractIdStr(event) ?? "";
  const topic0 = event.topic?.[0] ? getTopicStr(event, 0) : "";
  const topic1 = event.topic?.[1] ? getTopicStr(event, 1) : "";
  const eventType = topic0 && topic1 ? `${topic0}:${topic1}` : topic0;

  await client.query(
    `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_key) DO NOTHING`,
    [eventKey, contractId, event.ledger, event.txHash, eventType],
  );

  await handleEvent(client);
  return true;
}

// ─── Event data parsers (pure, no I/O — exported for unit tests) ─────────────

/**
 * Parse the data payload of a `factory/circle_created` event.
 *
 * Contract data tuple (contracts/circle_factory/src/lib.rs):
 *   (circle_address: Address, creator: Address, circle_index: u32)
 *
 * Returns a typed object so callers never have to remember positional order,
 * and so tests can assert on field names rather than array indices.
 */
export function parseCircleCreatedEvent(value: unknown): {
  circleAddress: string;
  creator: string;
  circleIndex: number;
} {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(
      `factory/circle_created: expected data tuple [address, creator, circle_index] ` +
        `but received ${JSON.stringify(value)}`,
    );
  }
  const [circleAddress, creator, circleIndex] = value as [string, string, number];
  if (typeof circleAddress !== "string" || circleAddress.length === 0) {
    throw new Error(
      `factory/circle_created: circle_address must be a non-empty string, got ${JSON.stringify(circleAddress)}`,
    );
  }
  if (typeof creator !== "string" || creator.length === 0) {
    throw new Error(
      `factory/circle_created: creator must be a non-empty string, got ${JSON.stringify(creator)}`,
    );
  }
  if (typeof circleIndex !== "number" || !Number.isInteger(circleIndex) || circleIndex < 0) {
    throw new Error(
      `factory/circle_created: circle_index must be a non-negative integer, got ${JSON.stringify(circleIndex)}`,
    );
  }
  return { circleAddress, creator, circleIndex };
}

// ─── Ledger cursor ────────────────────────────────────────────────────────────

async function getLastLedger(): Promise<number> {
  const rows = await query<{ last_ledger: string }>(
    "SELECT last_ledger FROM indexer_state WHERE id = 1",
  );
  return rows.length > 0 ? Number(rows[0].last_ledger) : 0;
}

async function setLastLedger(ledger: number): Promise<void> {
  await query(
    "UPDATE indexer_state SET last_ledger = $1, updated_at = NOW() WHERE id = 1",
    [ledger],
  );
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleFactoryCircleCreated(client: PoolClient, event: SdkEvent) {
  const { circleAddress, creator, circleIndex } = parseCircleCreatedEvent(
    getValueNative(event),
  );

  await client.query(
    `INSERT INTO circles
       (address, creator, round_amount, member_count, total_rounds, status,
        current_round, created_ledger)
     VALUES ($1, $2, 0, 0, 0, 'Pending', 0, $3)
     ON CONFLICT (address) DO NOTHING`,
    [circleAddress, creator, event.ledger],
  );
  console.log(
    `[indexer] New circle created: ${circleAddress} by ${creator} (factory index: ${circleIndex})`,
  );
}

async function handleCircleJoined(client: PoolClient, circleAddr: string, event: SdkEvent) {
  const memberAddr = getValueNative(event) as string;

  await client.query(
    `UPDATE circle_members SET joined_at = NOW()
     WHERE circle_address = $1 AND member_address = $2`,
    [circleAddr, memberAddr],
  );
  console.log(`[indexer] Member joined: ${memberAddr} → ${circleAddr}`);
}

async function handleCircleActive(client: PoolClient, circleAddr: string) {
  await client.query(
    "UPDATE circles SET status = 'Active', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  console.log(`[indexer] Circle active: ${circleAddr}`);
}

async function handleCircleContributed(client: PoolClient, circleAddr: string, event: SdkEvent) {
  const [memberAddr, roundIndex] = getValueNative(event) as [string, number];

  const rows = await client.query<{ round_amount: string }>(
    "SELECT round_amount FROM circles WHERE address = $1",
    [circleAddr],
  );
  const amount = rows.rows.length > 0 ? rows.rows[0].round_amount : "0";

  await client.query(
    `INSERT INTO contributions (circle_address, member_address, round_index, amount, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (circle_address, member_address, round_index) DO NOTHING`,
    [circleAddr, memberAddr, roundIndex, amount, event.txHash, event.ledger],
  );
  console.log(`[indexer] Contribution: ${memberAddr} round ${roundIndex} → ${circleAddr}`);
}

async function handleCirclePayout(client: PoolClient, circleAddr: string, event: SdkEvent) {
  const [recipient, pot, roundIndex] = getValueNative(event) as [string, bigint, number];

  await client.query(
    `INSERT INTO payouts (circle_address, recipient, round_index, amount, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (circle_address, round_index) DO NOTHING`,
    [circleAddr, recipient, roundIndex, pot.toString(), event.txHash, event.ledger],
  );

  await client.query(
    `UPDATE circles SET current_round = $1, updated_at = NOW() WHERE address = $2`,
    [roundIndex + 1, circleAddr],
  );
  console.log(`[indexer] Payout: ${recipient} received ${pot} round ${roundIndex} from ${circleAddr}`);
}

async function handleCircleDefault(client: PoolClient, circleAddr: string, event: SdkEvent) {
  const [memberAddr, penalty, roundIndex] = getValueNative(event) as [string, bigint, number];

  await client.query(
    `INSERT INTO defaults (circle_address, member_address, round_index, penalty, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [circleAddr, memberAddr, roundIndex, penalty.toString(), event.txHash, event.ledger],
  );

  await client.query(
    `UPDATE circle_members SET defaults = defaults + 1
     WHERE circle_address = $1 AND member_address = $2`,
    [circleAddr, memberAddr],
  );
  console.log(`[indexer] Default: ${memberAddr} penalty ${penalty} round ${roundIndex} in ${circleAddr}`);
}

async function handleCircleCompleted(client: PoolClient, circleAddr: string) {
  await client.query(
    "UPDATE circles SET status = 'Completed', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  console.log(`[indexer] Circle completed: ${circleAddr}`);
}

async function handleReputationIncrement(client: PoolClient, event: SdkEvent) {
  const score = getValueNative(event) as number;
  const memberAddr = scValToNative(event.topic[1] as xdr.ScVal) as string;

  await client.query(
    `INSERT INTO reputation (member_address, score, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (member_address) DO UPDATE SET score = $2, updated_at = NOW()`,
    [memberAddr, score],
  );
  console.log(`[indexer] Reputation: ${memberAddr} → score ${score}`);
}

// ─── Metrics ───────────────────────────────────────────────────────────────

let totalEventsProcessed = 0;
let totalEventsFailed = 0;

interface EventLogContext {
  contractId: string | null;
  topic: string;
  ledger: number;
  txHash?: string;
}

/**
 * Runs a single event's handler in isolation so a malformed or unexpected
 * event can't abort the rest of the batch.
 * NOTE: this utility is kept for backward compatibility and metrics tracking.
 * The new per-ledger pipeline uses ingestEventInTx directly and lets handler
 * errors propagate to roll back the entire ledger transaction.
 */
export async function runEventHandler(
  handler: () => Promise<void>,
  ctx: EventLogContext,
): Promise<boolean> {
  try {
    await handler();
    totalEventsProcessed++;
    return true;
  } catch (err) {
    totalEventsFailed++;
    console.error(
      `[indexer] Failed to process ${ctx.topic} event ` +
        `(contract=${ctx.contractId ?? "unknown"}, ledger=${ctx.ledger}` +
        (ctx.txHash ? `, tx=${ctx.txHash}` : "") +
        "):",
      err,
    );
    return false;
  }
}

// ─── Per-ledger atomic processing ────────────────────────────────────────────

/**
 * Dispatch a single event to the right domain handler within an open tx.
 *
 * Returns:
 *   null  — no applicable handler (unknown topic / unregistered contract)
 *   true  — new event; handler ran and ingested_events row was written
 *   false — duplicate; event_key already exists in ingested_events (skipped)
 *
 * Throws on handler error — the caller's transaction rolls back entirely,
 * guaranteeing no partial ledger state is left behind.
 */
async function dispatchEventInTx(
  client: PoolClient,
  event: SdkEvent,
  knownCircleAddrs: ReadonlySet<string>,
): Promise<boolean | null> {
  if (!event.topic || event.topic.length < 2) return null;

  const topic0 = getTopicStr(event, 0);
  const topic1 = getTopicStr(event, 1);
  const contractId = getContractIdStr(event);

  let handler: ((client: PoolClient) => Promise<void>) | null = null;

  if (topic0 === "factory" && topic1 === "circle_created") {
    handler = (c) => handleFactoryCircleCreated(c, event);
  } else if (topic0 === "reputation" && topic1 === "increment") {
    handler = (c) => handleReputationIncrement(c, event);
  } else if (topic0 === "circle" && contractId && knownCircleAddrs.has(contractId)) {
    switch (topic1) {
      case "joined":
        handler = (c) => handleCircleJoined(c, contractId, event);
        break;
      case "active":
        handler = (c) => handleCircleActive(c, contractId);
        break;
      case "contributed":
        handler = (c) => handleCircleContributed(c, contractId, event);
        break;
      case "payout":
        handler = (c) => handleCirclePayout(c, contractId, event);
        break;
      case "default":
        handler = (c) => handleCircleDefault(c, contractId, event);
        break;
      case "completed":
        handler = (c) => handleCircleCompleted(c, contractId);
        break;
    }
  }

  if (!handler) return null;
  return ingestEventInTx(client, event, handler);
}

export interface LedgerIngestResult {
  ledger: number;
  eventsSeen: number;
  eventsIngested: number;
  status: "completed" | "failed";
  error?: string;
}

/**
 * Process all events for one ledger sequence number in a single Postgres
 * transaction.  The transaction atomically:
 *   1. Checks and records each event in ingested_events (dedupe).
 *   2. Runs the domain handler for each new event.
 *   3. Advances indexer_state.last_ledger to this ledger.
 *   4. Writes a ledger_checkpoints row.
 *
 * If any handler throws the whole transaction is rolled back — indexer_state
 * is not advanced, no events are committed, and the caller receives a
 * LedgerIngestResult with status 'failed'.  The ledger will be retried on the
 * next poll cycle.
 */
export async function processLedgerGroup(
  ledger: number,
  events: SdkEvent[],
  knownCircleAddrs: ReadonlySet<string>,
): Promise<LedgerIngestResult> {
  let eventsSeen = 0;
  let eventsIngested = 0;
  let failureError: string | undefined;

  try {
    await withTransaction(async (client) => {
      for (const event of events) {
        // null  → unknown topic or unregistered contract — not counted
        // true  → new event ingested
        // false → duplicate skipped; still counts as "seen"
        const dispatched = await dispatchEventInTx(client, event, knownCircleAddrs);
        if (dispatched === null) continue; // not applicable
        eventsSeen++;
        if (dispatched) eventsIngested++;
      }

      // Advance the durable ledger cursor atomically with the event writes.
      // GREATEST() ensures we never move the cursor backward (e.g. if a replay
      // of an old range runs concurrently with the live poll).
      await client.query(
        `UPDATE indexer_state
         SET last_ledger = GREATEST(last_ledger, $1), updated_at = NOW()
         WHERE id = 1`,
        [ledger],
      );

      // Record outcome so operators can see per-ledger status without querying
      // ingested_events directly.
      await client.query(
        `INSERT INTO ledger_checkpoints
           (ledger, status, events_seen, events_ingested, events_failed, processed_at)
         VALUES ($1, 'completed', $2, $3, 0, NOW())
         ON CONFLICT (ledger) DO UPDATE SET
           status        = 'completed',
           events_seen   = EXCLUDED.events_seen,
           events_ingested = EXCLUDED.events_ingested,
           events_failed = 0,
           error         = NULL,
           processed_at  = NOW()`,
        [ledger, eventsSeen, eventsIngested],
      );
    });
  } catch (err) {
    // Transaction rolled back — nothing committed for this ledger.
    // Record the failure outside the (now-dead) transaction so operators can
    // identify stuck ledgers and trigger a replay.
    failureError = err instanceof Error ? err.message : String(err);
    console.error(
      `[indexer] Ledger ${ledger} transaction failed — rolled back (${failureError})`,
    );

    totalEventsFailed += eventsSeen;

    try {
      await query(
        `INSERT INTO ledger_checkpoints
           (ledger, status, events_seen, events_ingested, events_failed, error, processed_at)
         VALUES ($1, 'failed', $2, 0, $3, $4, NOW())
         ON CONFLICT (ledger) DO UPDATE SET
           status        = 'failed',
           events_seen   = EXCLUDED.events_seen,
           events_failed = EXCLUDED.events_failed,
           error         = EXCLUDED.error,
           processed_at  = NOW()`,
        [ledger, eventsSeen, eventsSeen, failureError],
      );
    } catch (checkpointErr) {
      console.warn(`[indexer] Could not write failed checkpoint for ledger ${ledger}:`, checkpointErr);
    }

    return { ledger, eventsSeen, eventsIngested: 0, status: "failed", error: failureError };
  }

  totalEventsProcessed += eventsIngested;
  return { ledger, eventsSeen, eventsIngested, status: "completed" };
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

/**
 * Fetch and ingest all contract events in [fromLedger, toLedger].
 *
 * Two-phase fetch mirrors the current architecture:
 *   Phase 1 — factory + reputation events (these can create new circles).
 *   Phase 2 — circle events (queried after phase 1 so newly created circles
 *              are included in the contract-id filter).
 *
 * Within each phase, events are grouped by ledger and processed one ledger at
 * a time — each in its own atomic transaction — so a single bad ledger cannot
 * corrupt neighbour ledgers.
 *
 * If any ledger's transaction fails, processEvents throws and runPollCycle
 * does NOT advance last_ledger past the last successful ledger, guaranteeing
 * the failed range is retried on the next tick.
 */
async function processEvents(fromLedger: number, toLedger: number): Promise<void> {
  const startedAt = Date.now();
  let totalSeen = 0;
  let totalIngested = 0;
  let totalFailed = 0;

  // ── Phase 1: factory + reputation ───────────────────────────────────────────
  const factoryResponse = await withRpcRetry<GetEventsPage>("getEvents(factory+reputation)", () =>
    activeRpc().getEvents({
      startLedger: fromLedger,
      filters: [
        {
          type: "contract",
          contractIds: [FACTORY, REPUTATION],
        },
      ],
      limit: EVENTS_LIMIT,
    }) as Promise<GetEventsPage>,
  );

  const factoryByLedger = groupEventsByLedger(factoryResponse.events);
  const emptySet = new Set<string>();

  for (const [ledger, events] of factoryByLedger) {
    const result = await processLedgerGroup(ledger, events, emptySet);
    totalSeen += result.eventsSeen;
    totalIngested += result.eventsIngested;
    if (result.status === "failed") {
      totalFailed += result.eventsSeen;
      // Propagate so runPollCycle does not advance last_ledger
      throw new Error(
        `[indexer] Phase-1 ledger ${ledger} failed: ${result.error ?? "unknown"}`,
      );
    }
  }

  // ── Phase 2: circle events ───────────────────────────────────────────────────
  // Re-query circles AFTER phase 1 so circles created in this batch are
  // included in the filter for their own events.
  const circles = await query<{ address: string }>("SELECT address FROM circles");

  if (circles.length > 0) {
    const circleAddrs = new Set(circles.map((c) => c.address));

    const circleResponse = await withRpcRetry<GetEventsPage>("getEvents(circles)", () =>
      activeRpc().getEvents({
        startLedger: fromLedger,
        filters: [{ type: "contract", contractIds: [...circleAddrs] }],
        limit: EVENTS_LIMIT,
      }) as Promise<GetEventsPage>,
    );

    const circleByLedger = groupEventsByLedger(circleResponse.events);

    for (const [ledger, events] of circleByLedger) {
      const result = await processLedgerGroup(ledger, events, circleAddrs);
      totalSeen += result.eventsSeen;
      totalIngested += result.eventsIngested;
      if (result.status === "failed") {
        totalFailed += result.eventsSeen;
        throw new Error(
          `[indexer] Phase-2 ledger ${ledger} failed: ${result.error ?? "unknown"}`,
        );
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[indexer] Processed ledgers ${fromLedger}-${toLedger}: ` +
      `${totalIngested}/${totalSeen} event(s) ingested, ${totalFailed} failed, ${durationMs}ms` +
      (totalEventsFailed > 0 ? ` (${totalEventsFailed} failed since start)` : ""),
  );
}

// ─── Replay / backfill ────────────────────────────────────────────────────────

export interface ReplayOptions {
  /**
   * When true, delete ingested_events and ledger_checkpoints rows for the
   * range before re-fetching, forcing full re-processing of every event.
   * When false (default), already-ingested events are skipped by the dedupe
   * check inside each ledger transaction — only missing or failed events are
   * reprocessed.
   */
  clearIngestedEvents?: boolean;
}

export interface ReplayResult {
  fromLedger: number;
  toLedger: number;
  ledgersProcessed: number;
  totalEventsSeen: number;
  totalEventsIngested: number;
  failedLedgers: number[];
}

/**
 * Re-process a ledger range without manual DB surgery.
 *
 * Typical use cases:
 *   - A ledger was marked 'failed' in ledger_checkpoints and needs a retry
 *     after a transient DB or RPC error is resolved.
 *   - A handler bug was fixed and affected ledgers need to be re-applied
 *     (use clearIngestedEvents: true to force full re-processing).
 *   - Backfill a ledger range that was skipped due to a gap.
 *
 * Unlike the live poll loop, replay never advances last_ledger backward —
 * it only moves it forward if the replayed range exceeds the current cursor.
 */
export async function replayLedgerRange(
  fromLedger: number,
  toLedger: number,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  if (fromLedger > toLedger) {
    throw new Error(
      `[indexer] replayLedgerRange: fromLedger (${fromLedger}) must be ≤ toLedger (${toLedger})`,
    );
  }

  console.log(
    `[indexer] Replaying ledger range ${fromLedger}-${toLedger}` +
      (opts.clearIngestedEvents ? " (clearing prior ingest records)" : ""),
  );

  if (opts.clearIngestedEvents) {
    await query(
      "DELETE FROM ingested_events WHERE ledger >= $1 AND ledger <= $2",
      [fromLedger, toLedger],
    );
    await query(
      "DELETE FROM ledger_checkpoints WHERE ledger >= $1 AND ledger <= $2",
      [fromLedger, toLedger],
    );
    console.log(`[indexer] Cleared ingest records for ledgers ${fromLedger}-${toLedger}`);
  }

  let ledgersProcessed = 0;
  let totalEventsSeen = 0;
  let totalEventsIngested = 0;
  const failedLedgers: number[] = [];

  // Phase 1: factory + reputation
  const factoryResponse = await withRpcRetry<GetEventsPage>("getEvents(factory+reputation)[replay]", () =>
    activeRpc().getEvents({
      startLedger: fromLedger,
      filters: [{ type: "contract", contractIds: [FACTORY, REPUTATION] }],
      limit: EVENTS_LIMIT,
    }) as Promise<GetEventsPage>,
  );

  const factoryByLedger = groupEventsByLedger(factoryResponse.events);
  const emptySet = new Set<string>();

  for (const [ledger, events] of factoryByLedger) {
    if (ledger > toLedger) break;
    const result = await processLedgerGroup(ledger, events, emptySet);
    ledgersProcessed++;
    totalEventsSeen += result.eventsSeen;
    totalEventsIngested += result.eventsIngested;
    if (result.status === "failed") failedLedgers.push(ledger);
  }

  // Phase 2: circle events (re-query after phase 1)
  const circles = await query<{ address: string }>("SELECT address FROM circles");

  if (circles.length > 0) {
    const circleAddrs = new Set(circles.map((c) => c.address));

    const circleResponse = await withRpcRetry<GetEventsPage>("getEvents(circles)[replay]", () =>
      activeRpc().getEvents({
        startLedger: fromLedger,
        filters: [{ type: "contract", contractIds: [...circleAddrs] }],
        limit: EVENTS_LIMIT,
      }) as Promise<GetEventsPage>,
    );

    const circleByLedger = groupEventsByLedger(circleResponse.events);

    for (const [ledger, events] of circleByLedger) {
      if (ledger > toLedger) break;
      const result = await processLedgerGroup(ledger, events, circleAddrs);
      ledgersProcessed++;
      totalEventsSeen += result.eventsSeen;
      totalEventsIngested += result.eventsIngested;
      if (result.status === "failed" && !failedLedgers.includes(ledger)) {
        failedLedgers.push(ledger);
      }
    }
  }

  // Advance the cursor if the replay range is ahead of the current position.
  const currentLedger = await getLastLedger();
  if (toLedger > currentLedger) {
    await setLastLedger(toLedger);
  }

  const result: ReplayResult = {
    fromLedger,
    toLedger,
    ledgersProcessed,
    totalEventsSeen,
    totalEventsIngested,
    failedLedgers,
  };

  console.log(
    `[indexer] Replay complete: ${ledgersProcessed} ledger(s), ` +
      `${totalEventsIngested}/${totalEventsSeen} event(s) ingested` +
      (failedLedgers.length > 0 ? `, failed ledgers: ${failedLedgers.join(", ")}` : ""),
  );

  return result;
}

// ─── Poller lifecycle (graceful shutdown) ─────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight: Promise<void> | null = null;
let shuttingDown = false;
let indexerStarted = false;

/**
 * Run one poll cycle: fetch latest ledger and ingest events in (lastLedger, to].
 * Returns the durable ledger cursor (the value in indexer_state after the cycle).
 * On batch-level failure, last_ledger reflects the last atomically committed
 * ledger — the failed range will be retried on the next tick.
 */
async function runPollCycle(lastLedger: number): Promise<number> {
  const latestLedger = await activeRpc().getLatestLedger();
  const toLedger = latestLedger.sequence;

  if (toLedger > lastLedger) {
    // processEvents advances last_ledger within each per-ledger transaction.
    // If it throws (a ledger failed), last_ledger reflects the last successful
    // ledger — we do NOT call setLastLedger(toLedger) so the failed range is
    // retried next tick.
    await processEvents(lastLedger + 1, toLedger);

    // Advance past any empty-event ledgers at the end of the range.
    // This is a plain UPDATE (not inside a per-event transaction) — it moves
    // the cursor forward only when processEvents completed without throwing,
    // meaning all encountered ledgers were committed successfully.
    await setLastLedger(toLedger);
    return toLedger;
  }
  return lastLedger;
}

export async function startIndexer() {
  if (indexerStarted) {
    throw new Error("[indexer] Event poller is already running");
  }

  console.log(
    `[indexer] Starting CircleUp event indexer ` +
      `(poll interval: ${POLL_INTERVAL_MS}ms, events per page: ${EVENTS_LIMIT})...`,
  );

  let lastLedger = await getLastLedger();
  if (lastLedger === 0) {
    lastLedger = START_LEDGER;
  }

  console.log(`[indexer] Starting from ledger ${lastLedger}`);

  shuttingDown = false;
  indexerStarted = true;

  const tick = () => {
    if (shuttingDown) {
      return;
    }
    if (pollInFlight) {
      console.warn(
        "[indexer] Previous poll still in flight — skipping overlapping tick",
      );
      return;
    }

    pollInFlight = (async () => {
      try {
        lastLedger = await runPollCycle(lastLedger);
      } catch (err) {
        console.error(
          `[indexer] Poll error (will retry from ledger ${lastLedger + 1}):`,
          err,
        );
      }
    })().finally(() => {
      pollInFlight = null;
    });
  };

  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

/**
 * Stop the event poller cleanly: clear the interval, refuse new ticks, and
 * wait for any in-flight poll cycle to finish so we don't exit mid-write.
 */
export async function stopIndexer(): Promise<void> {
  if (!indexerStarted && !pollTimer && !pollInFlight) {
    console.log("[indexer] Event poller is not running — nothing to stop");
    return;
  }

  if (shuttingDown) {
    console.log("[indexer] Shutdown already in progress — waiting...");
    if (pollInFlight) {
      await pollInFlight.catch(() => undefined);
    }
    return;
  }

  shuttingDown = true;
  console.log(
    "[indexer] Graceful shutdown requested — stopping event poller...",
  );

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (pollInFlight) {
    console.log("[indexer] Waiting for in-flight poll cycle to finish...");
    await pollInFlight.catch(() => undefined);
  }

  indexerStarted = false;
  console.log("[indexer] Event poller stopped cleanly");
}

/** Test/ops helper: whether the poller has been started and not fully stopped. */
export function isIndexerRunning(): boolean {
  return indexerStarted && !shuttingDown;
}

// Exposed for tests and potential future health/metrics endpoints.
export function getIndexerMetrics() {
  return { totalEventsProcessed, totalEventsFailed };
}
