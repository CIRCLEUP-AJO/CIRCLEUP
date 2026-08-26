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
 * Ordering model
 * ──────────────
 * Events are fetched for a ledger range [fromLedger, toLedger], sorted by
 * (ledger ASC, event-id ASC) for canonical on-chain ordering, and processed
 * one ledger at a time.  Each ledger's batch is wrapped in a single Postgres
 * transaction that also advances the indexer_state cursor and writes a
 * ledger_checkpoints record, so either the full ledger commits or nothing
 * does.  Individual event failures use savepoints — a bad event handler rolls
 * back only its own writes and lets the rest of the ledger proceed.
 *
 * Recovery
 * ────────
 * On crash/restart the cursor is read from DB (never from memory), so the
 * indexer resumes exactly from the last durable ledger boundary.  Events
 * already recorded in ingested_events are skipped by the dedup check inside
 * ingestEventInTx, giving exactly-once semantics across restarts.
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
import { redactAddress, redactTxHash, formatAmount } from "./redact";

export const rpc = new SorobanRpc.Server(STELLAR_RPC_URL, {
  allowHttp: true,
});

const FACTORY = CIRCLE_FACTORY_ADDRESS;
const REPUTATION = REPUTATION_ADDRESS;
export const USDC = USDC_ADDRESS;

// ─── Soroban RPC retry ───────────────────────────────────────────────────────

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

/**
 * A resolved (event, handler) pair ready for per-ledger processing.
 * The handler must be called inside an existing Postgres transaction.
 */
export interface EventHandler {
  event: SdkEvent;
  handler: (client: PoolClient) => Promise<void>;
}

function getContractIdStr(event: SdkEvent): string | null {
  const c = event.contractId;
  if (!c) return null;
  if (typeof c === "string") return c;
  if (typeof (c as { toString?: () => string }).toString === "function") {
    return (c as { toString: () => string }).toString();
  }
  return null;
}

function getTopicStr(event: SdkEvent, idx: number): string {
  const val = event.topic[idx];
  return scValToNative(val as xdr.ScVal) as string;
}

function getValueNative(event: SdkEvent): unknown {
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

/**
 * Extract the event index from an SDK event's `id` field.
 *
 * The Soroban RPC event id format is: "ledger-txIndex-eventIndex" (0-padded).
 * Example: "0000012345678-0000000002-0000000001" represents:
 *   ledger 12345678, tx index 2, event index 1
 *
 * Returns null if the id is missing or malformed.
 */
export function parseEventIndex(event: SdkEvent): number | null {
  const id = event.id;
  if (typeof id !== "string") return null;
  
  const parts = id.split("-");
  if (parts.length !== 3) return null;
  
  const eventIndex = parseInt(parts[2], 10);
  return Number.isNaN(eventIndex) ? null : eventIndex;
}

// ─── Ledger ordering utilities ────────────────────────────────────────────────

/**
 * Groups events by their ledger number, returning a Map sorted by ledger ASC.
 * Events within each ledger retain their original insertion order; callers
 * should sort by event.id before calling to get canonical on-chain ordering.
 */
export function groupEventsByLedger(events: SdkEvent[]): Map<number, SdkEvent[]> {
  const map = new Map<number, SdkEvent[]>();
  for (const event of events) {
    const ledger = event.ledger ?? 0;
    const bucket = map.get(ledger);
    if (bucket) {
      bucket.push(event);
    } else {
      map.set(ledger, [event]);
    }
  }
  return new Map([...map.entries()].sort(([a], [b]) => a - b));
}

/**
 * Returns ledger numbers in [fromLedger, toLedger] absent from seenLedgers.
 * Useful for identifying ranges where no contract events were emitted and for
 * detecting cases where an RPC call silently dropped an expected ledger.
 */
export function detectLedgerGaps(
  seenLedgers: number[],
  fromLedger: number,
  toLedger: number,
): number[] {
  const seen = new Set(seenLedgers);
  const gaps: number[] = [];
  for (let l = fromLedger; l <= toLedger; l++) {
    if (!seen.has(l)) gaps.push(l);
  }
  return gaps;
}

// ─── Dedup-aware event ingestor (caller owns the transaction) ─────────────────

/**
 * Ingest one event inside the caller's open transaction.
 *
 * Checks ingested_events for the event_key; if already present, returns false
 * without running the handler (idempotent replay path).  Otherwise records
 * the key and runs handleEvent inside the same transaction.
 *
 * Issue 28: Now includes event_index in the insert for canonical identity-based
 * deduplication. The unique constraint on (ledger, tx_hash, event_index) makes
 * duplicate delivery a silent no-op at the database layer.
 *
 * Callers should wrap this in a SAVEPOINT so a throwing handler rolls back
 * only that event's writes and not the entire ledger batch.
 */
export async function ingestEventInTx(
  client: PoolClient,
  event: SdkEvent,
  handleEvent: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  const eventKey = createEventKey(event);
  const eventIndex = parseEventIndex(event);

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
    `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type, event_index)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_key) DO NOTHING`,
    [eventKey, contractId, event.ledger, event.txHash, eventType, eventIndex],
  );

  await handleEvent(client);
  return true;
}

// ─── Per-ledger atomic processor ─────────────────────────────────────────────

/**
 * Process all events for one ledger inside a single Postgres transaction.
 *
 * Each event is wrapped in a savepoint: a throwing handler rolls back only its
 * own writes and does not abort the rest of the ledger.  After all events are
 * attempted the indexer_state cursor is advanced to `ledger` and a
 * ledger_checkpoints record is written — both inside the same transaction, so
 * a crash before COMMIT leaves the DB at the previous ledger boundary with no
 * partial state.
 *
 * items must be pre-sorted in canonical ledger order (ledger ASC, event id ASC)
 * by the caller.
 */
export async function processLedger(
  ledger: number,
  items: EventHandler[],
): Promise<{ processed: number; failed: number }> {
  return withTransaction(async (client) => {
    let processed = 0;
    let failed = 0;

    for (const { event, handler } of items) {
      const contractId = getContractIdStr(event);
      const topic0 = event.topic?.[0] ? getTopicStr(event, 0) : "";
      const topic1 = event.topic?.[1] ? getTopicStr(event, 1) : "";

      await client.query("SAVEPOINT sp_event");
      try {
        const ingested = await ingestEventInTx(client, event, handler);
        await client.query("RELEASE SAVEPOINT sp_event");
        if (ingested) {
          processed++;
          totalEventsProcessed++;
        }
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT sp_event");
        failed++;
        totalEventsFailed++;
        console.error(
          `[indexer] Failed to process ${topic0}/${topic1} event ` +
            `(contract=${redactAddress(contractId ?? "unknown")}, ledger=${ledger}` +
            (event.txHash ? `, tx=${redactTxHash(event.txHash)}` : "") +
            "):",
          err,
        );
      }
    }

    // Advance the durable ledger cursor atomically with the event writes.
    // If this transaction rolls back (e.g. DB OOM), the cursor stays at the
    // previous ledger so the next poll retries this ledger from scratch.
    await client.query(
      "UPDATE indexer_state SET last_ledger = $1, updated_at = NOW() WHERE id = 1",
      [ledger],
    );

    await client.query(
      `INSERT INTO ledger_checkpoints (ledger, events_count, failed_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (ledger) DO UPDATE
         SET events_count  = EXCLUDED.events_count,
             failed_count  = EXCLUDED.failed_count,
             processed_at  = NOW()`,
      [ledger, processed, failed],
    );

    return { processed, failed };
  });
}

// ─── Event data parsers (pure, no I/O — exported for unit tests) ─────────────

/**
 * Parse the data payload of a `factory/circle_created` event.
 *
 * Contract data tuple (contracts/circle_factory/src/lib.rs):
 *   (circle_address: Address, creator: Address, circle_index: u32)
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

// ─── Cursor helpers ───────────────────────────────────────────────────────────

async function getLastLedger(): Promise<number> {
  const rows = await query<{ last_ledger: string }>(
    "SELECT last_ledger FROM indexer_state WHERE id = 1",
  );
  return rows.length > 0 ? Number(rows[0].last_ledger) : 0;
}

async function setLastLedger(ledger: number) {
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
    `[indexer] New circle created: ${redactAddress(circleAddress)} by ${redactAddress(creator)} (factory index: ${circleIndex})`,
  );
}

async function handleCircleJoined(client: PoolClient, circleAddr: string, event: SdkEvent) {
  const memberAddr = getValueNative(event) as string;

  await client.query(
    `UPDATE circle_members SET joined_at = NOW()
     WHERE circle_address = $1 AND member_address = $2`,
    [circleAddr, memberAddr],
  );
  console.log(`[indexer] Member joined: ${redactAddress(memberAddr)} → ${redactAddress(circleAddr)}`);
}

async function handleCircleActive(client: PoolClient, circleAddr: string) {
  await client.query(
    "UPDATE circles SET status = 'Active', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  console.log(`[indexer] Circle active: ${redactAddress(circleAddr)}`);
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
  console.log(`[indexer] Contribution: ${redactAddress(memberAddr)} round ${roundIndex} → ${redactAddress(circleAddr)}`);
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
  console.log(`[indexer] Payout: ${redactAddress(recipient)} ${formatAmount(pot)} round ${roundIndex} from ${redactAddress(circleAddr)}`);
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
  console.log(`[indexer] Default: ${redactAddress(memberAddr)} ${formatAmount(penalty)} round ${roundIndex} in ${redactAddress(circleAddr)}`);
}

async function handleCircleCompleted(client: PoolClient, circleAddr: string) {
  await client.query(
    "UPDATE circles SET status = 'Completed', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  console.log(`[indexer] Circle completed: ${redactAddress(circleAddr)}`);
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
  console.log(`[indexer] Reputation: ${redactAddress(memberAddr)} → score ${score}`);
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

let totalEventsProcessed = 0;
let totalEventsFailed = 0;

interface EventLogContext {
  contractId: string | null;
  topic: string;
  ledger: number;
  txHash?: string;
}

/**
 * Runs a single event's handler in isolation, updating cumulative metrics.
 * Exported for use in one-off testing and health utilities; the main ingest
 * pipeline uses processLedger which manages isolation via savepoints.
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
        `(contract=${redactAddress(ctx.contractId ?? "unknown")}, ledger=${ctx.ledger}` +
        (ctx.txHash ? `, tx=${redactTxHash(ctx.txHash)}` : "") +
        "):",
      err,
    );
    return false;
  }
}

// ─── Main poll cycle ──────────────────────────────────────────────────────────

/**
 * Fetch all relevant events for [fromLedger, toLedger], build canonical
 * (event, handler) pairs sorted by ledger then event id, and process each
 * ledger's batch atomically via processLedger.
 *
 * New circles discovered within the range are included in the circle-event
 * query without a DB round-trip, so joined/active/etc. events in the same
 * ledger as circle_created are not missed.
 *
 * The cursor in indexer_state is advanced per ledger inside processLedger.
 * After all event-carrying ledgers are done, setLastLedger advances the
 * cursor to toLedger to cover any trailing empty ledgers.
 */
async function processEvents(fromLedger: number, toLedger: number) {
  const startedAt = Date.now();

  // ── 1. Fetch factory + reputation events ────────────────────────────────
  const factoryResponse = await withRpcRetry("getEvents(factory+reputation)", () =>
    rpc.getEvents({
      startLedger: fromLedger,
      filters: [
        {
          type: "contract",
          contractIds: [FACTORY, REPUTATION],
        },
      ],
      limit: EVENTS_LIMIT,
    }),
  );

  // ── 2. Pre-extract new circle addresses from factory events ──────────────
  // Doing this before any DB writes lets us include newly-created circles in
  // the circle-event query even before their circle_created event is committed.
  const newCircleAddrs: string[] = [];
  for (const event of factoryResponse.events) {
    if (!event.topic || event.topic.length < 2) continue;
    if (getTopicStr(event, 0) === "factory" && getTopicStr(event, 1) === "circle_created") {
      try {
        const { circleAddress } = parseCircleCreatedEvent(getValueNative(event));
        newCircleAddrs.push(circleAddress);
      } catch {
        // parse errors surface again at ingest time with full context
      }
    }
  }

  // ── 3. Merge known + newly-discovered circle addresses ───────────────────
  const existingCircles = await query<{ address: string }>("SELECT address FROM circles");
  const allCircleAddrs = [
    ...new Set([...existingCircles.map((c) => c.address), ...newCircleAddrs]),
  ];

  // ── 4. Fetch circle contract events ──────────────────────────────────────
  const circleEvents: SdkEvent[] = [];
  if (allCircleAddrs.length > 0) {
    const circleResponse = await withRpcRetry("getEvents(circles)", () =>
      rpc.getEvents({
        startLedger: fromLedger,
        filters: [{ type: "contract", contractIds: allCircleAddrs }],
        limit: EVENTS_LIMIT,
      }),
    );
    circleEvents.push(...circleResponse.events);
  }

  // ── 5. Build (event, handler) pairs ──────────────────────────────────────
  const items: EventHandler[] = [];

  for (const event of factoryResponse.events) {
    if (!event.topic || event.topic.length < 2) continue;
    const t0 = getTopicStr(event, 0);
    const t1 = getTopicStr(event, 1);
    if (t0 === "factory" && t1 === "circle_created") {
      items.push({ event, handler: (c) => handleFactoryCircleCreated(c, event) });
    } else if (t0 === "reputation" && t1 === "increment") {
      items.push({ event, handler: (c) => handleReputationIncrement(c, event) });
    }
  }

  for (const event of circleEvents) {
    if (!event.topic || event.topic.length < 2) continue;
    const t0 = getTopicStr(event, 0);
    const t1 = getTopicStr(event, 1);
    if (t0 !== "circle") continue;
    const contractId = getContractIdStr(event);
    if (!contractId) continue;

    let handler: ((client: PoolClient) => Promise<void>) | null = null;
    switch (t1) {
      case "joined":      handler = (c) => handleCircleJoined(c, contractId, event); break;
      case "active":      handler = (c) => handleCircleActive(c, contractId); break;
      case "contributed": handler = (c) => handleCircleContributed(c, contractId, event); break;
      case "payout":      handler = (c) => handleCirclePayout(c, contractId, event); break;
      case "default":     handler = (c) => handleCircleDefault(c, contractId, event); break;
      case "completed":   handler = (c) => handleCircleCompleted(c, contractId); break;
    }
    if (handler) items.push({ event, handler });
  }

  // ── 6. Sort by (ledger ASC, event id ASC) — canonical on-chain order ────
  // event.id encodes (ledger, txIndex, eventIndex), so string comparison is
  // sufficient for within-ledger ordering.
  items.sort((a, b) => {
    if (a.event.ledger !== b.event.ledger) return a.event.ledger - b.event.ledger;
    return (a.event.id ?? "").localeCompare(b.event.id ?? "");
  });

  // ── 7. Group by ledger ───────────────────────────────────────────────────
  const byLedger = new Map<number, EventHandler[]>();
  for (const item of items) {
    const l = item.event.ledger;
    const bucket = byLedger.get(l);
    if (bucket) bucket.push(item);
    else byLedger.set(l, [item]);
  }
  const sortedLedgers = [...byLedger.keys()].sort((a, b) => a - b);

  // ── 8. Process each ledger atomically, checkpointing per ledger ──────────
  let totalSeen = 0;
  let totalFailed = 0;

  for (const ledger of sortedLedgers) {
    const { processed, failed } = await processLedger(ledger, byLedger.get(ledger)!);
    totalSeen += processed;
    totalFailed += failed;
  }

  // ── 9. Advance cursor to cover any empty trailing ledgers ────────────────
  // processLedger sets the cursor to the highest event-carrying ledger.
  // Ledgers between that and toLedger had no relevant events; advance past them
  // so the next poll doesn't re-fetch a known-empty range.
  const lastEventLedger = sortedLedgers.length > 0
    ? sortedLedgers[sortedLedgers.length - 1]
    : 0;
  if (lastEventLedger < toLedger) {
    await setLastLedger(toLedger);
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[indexer] Processed ledgers ${fromLedger}-${toLedger}: ` +
      `${totalSeen} event(s), ${totalFailed} failed, ${durationMs}ms` +
      (totalEventsFailed > 0 ? ` (${totalEventsFailed} failed since start)` : ""),
  );
}

// ─── Backoff policy (Issue 29) ────────────────────────────────────────────────

/**
 * Exponential backoff state for the polling loop.
 *
 * Temporary RPC failures should not cause a hot loop or immediate process exit.
 * This policy tracks consecutive failures and computes the next wait interval
 * with capped exponential backoff + jitter.
 */
interface BackoffState {
  consecutiveFailures: number;
  currentIntervalMs: number;
}

const BACKOFF_INITIAL_MS = parseInt(
  process.env.POLL_BACKOFF_INITIAL_MS || "1000",
  10,
);
const BACKOFF_MAX_MS = parseInt(
  process.env.POLL_BACKOFF_MAX_MS || "60000",
  10,
);
const BACKOFF_MULTIPLIER = parseFloat(
  process.env.POLL_BACKOFF_MULTIPLIER || "2.0",
);

function createBackoffState(): BackoffState {
  return {
    consecutiveFailures: 0,
    currentIntervalMs: BACKOFF_INITIAL_MS,
  };
}

function resetBackoff(state: BackoffState): void {
  state.consecutiveFailures = 0;
  state.currentIntervalMs = BACKOFF_INITIAL_MS;
}

function incrementBackoff(state: BackoffState): void {
  state.consecutiveFailures++;
  state.currentIntervalMs = Math.min(
    BACKOFF_MAX_MS,
    state.currentIntervalMs * BACKOFF_MULTIPLIER,
  );
}

/**
 * Compute the actual wait time with full jitter: returns a random value in
 * [0, currentIntervalMs] to spread load when many indexers recover simultaneously.
 */
function computeJitteredWait(state: BackoffState): number {
  return Math.floor(Math.random() * state.currentIntervalMs);
}

/**
 * Check if we should log a warning about repeated failures.
 * Warns at failure 3, 6, 12, 24, ... (doubling interval).
 */
function shouldWarnBackoff(state: BackoffState): boolean {
  const n = state.consecutiveFailures;
  return n >= 3 && (n & (n - 1)) === 0; // power of 2 check
}

// ─── Poll cycle ───────────────────────────────────────────────────────────────

const backoffState = createBackoffState();

/**
 * One poll iteration: read the durable cursor from DB, fetch the latest
 * ledger from RPC, and process any new ledgers.
 *
 * The cursor is always read from the DB (not from an in-memory variable) so
 * that any per-ledger progress made before a crash is reflected on restart
 * without any special recovery logic.
 *
 * Issue 29: Added exponential backoff on transient RPC failures so temporary
 * outages don't cause a hot loop or process exit. The backoff state resets
 * after any successful poll.
 */
async function runPollCycle(): Promise<void> {
  let lastLedger = await getLastLedger();
  if (lastLedger === 0) lastLedger = START_LEDGER;

  const latestLedger = await withRpcRetry("getLatestLedger", () => rpc.getLatestLedger());
  const toLedger = latestLedger.sequence;

  if (toLedger > lastLedger) {
    await processEvents(lastLedger + 1, toLedger);
  }
  
  // Success — reset backoff so the next failure starts from the initial interval
  resetBackoff(backoffState);
}

// ─── Poller lifecycle (graceful shutdown) ─────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight: Promise<void> | null = null;
let shuttingDown = false;
let indexerStarted = false;

export async function startIndexer() {
  if (indexerStarted) {
    throw new Error("[indexer] Event poller is already running");
  }

  console.log(
    `[indexer] Starting CircleUp event indexer ` +
      `(poll interval: ${POLL_INTERVAL_MS}ms, events per page: ${EVENTS_LIMIT})...`,
  );

  shuttingDown = false;
  indexerStarted = true;

  const tick = () => {
    if (shuttingDown) return;
    if (pollInFlight) {
      console.warn("[indexer] Previous poll still in flight — skipping overlapping tick");
      return;
    }

    pollInFlight = (async () => {
      try {
        await runPollCycle();
      } catch (err) {
        incrementBackoff(backoffState);
        
        if (shouldWarnBackoff(backoffState)) {
          console.warn(
            `[indexer] Poll has failed ${backoffState.consecutiveFailures} consecutive times. ` +
            `Current backoff interval: ${Math.floor(backoffState.currentIntervalMs / 1000)}s. ` +
            `Check RPC connectivity and logs.`,
          );
        }
        
        console.error(
          `[indexer] Poll error (will retry after backoff):`,
          err,
        );
        
        // Apply jittered backoff before the next tick
        const waitMs = computeJitteredWait(backoffState);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    })().finally(() => {
      pollInFlight = null;
    });
  };

  // Run an immediate tick so we don't wait a full interval on startup.
  tick();
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
  console.log("[indexer] Graceful shutdown requested — stopping event poller...");

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

export function getIndexerMetrics() {
  return { totalEventsProcessed, totalEventsFailed };
}
