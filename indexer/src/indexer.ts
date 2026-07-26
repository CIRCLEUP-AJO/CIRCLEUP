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
 */

import { SorobanRpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import { query } from "./db/pool";
import * as dotenv from "dotenv";

dotenv.config();

const POLL_INTERVAL_MS = 5_000;
const EVENTS_LIMIT = 100;

const rpc = new SorobanRpc.Server(process.env.STELLAR_RPC_URL!, {
  allowHttp: true,
});

const FACTORY = process.env.CIRCLE_FACTORY_ADDRESS!;
const REPUTATION = process.env.REPUTATION_ADDRESS!;

// The SDK's getEvents returns EventResponse; extract the string contractId safely.
type SdkEvent = SorobanRpc.Api.EventResponse;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function handleFactoryCircleCreated(event: SdkEvent) {
  // The factory emits: (circle_address, creator, round_deadline_ledgers)
  // Index 2 (round_deadline_ledgers) may be absent on older contract versions.
  const value = getValueNative(event) as [string, string, number?];
  const [circleAddr, creator, roundDeadlineLedgers] = value;

  await query(
    `INSERT INTO circles
       (address, creator, round_amount, member_count, total_rounds, status,
        current_round, created_ledger, round_deadline_ledgers)
     VALUES ($1, $2, 0, 0, 0, 'Pending', 0, $3, $4)
     ON CONFLICT (address) DO NOTHING`,
    [
      circleAddr,
      creator,
      event.ledger,
      roundDeadlineLedgers != null ? Number(roundDeadlineLedgers) : null,
    ],
  );
  console.log(
    `[indexer] New circle created: ${circleAddr} by ${creator}` +
      (roundDeadlineLedgers != null
        ? ` (deadline: ${roundDeadlineLedgers} ledgers/round)`
        : ""),
  );
}

async function handleCircleJoined(circleAddr: string, event: SdkEvent) {
  const memberAddr = getValueNative(event) as string;

  await query(
    `UPDATE circle_members SET joined_at = NOW()
     WHERE circle_address = $1 AND member_address = $2`,
    [circleAddr, memberAddr],
  );
  console.log(`[indexer] Member joined: ${memberAddr} → ${circleAddr}`);
}

async function handleCircleActive(circleAddr: string) {
  await query(
    "UPDATE circles SET status = 'Active', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  console.log(`[indexer] Circle active: ${circleAddr}`);
}

async function handleCircleContributed(circleAddr: string, event: SdkEvent) {
  const [memberAddr, roundIndex] = getValueNative(event) as [string, number];

  const rows = await query<{ round_amount: string }>(
    "SELECT round_amount FROM circles WHERE address = $1",
    [circleAddr],
  );
  const amount = rows.length > 0 ? rows[0].round_amount : "0";

  await query(
    `INSERT INTO contributions (circle_address, member_address, round_index, amount, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (circle_address, member_address, round_index) DO NOTHING`,
    [circleAddr, memberAddr, roundIndex, amount, event.txHash, event.ledger],
  );
  console.log(`[indexer] Contribution: ${memberAddr} round ${roundIndex} → ${circleAddr}`);
}

async function handleCirclePayout(circleAddr: string, event: SdkEvent) {
  const [recipient, pot, roundIndex] = getValueNative(event) as [string, bigint, number];

  await query(
    `INSERT INTO payouts (circle_address, recipient, round_index, amount, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (circle_address, round_index) DO NOTHING`,
    [circleAddr, recipient, roundIndex, pot.toString(), event.txHash, event.ledger],
  );

  await query(
    `UPDATE circles SET current_round = $1, updated_at = NOW() WHERE address = $2`,
    [roundIndex + 1, circleAddr],
  );
  console.log(`[indexer] Payout: ${recipient} received ${pot} round ${roundIndex} from ${circleAddr}`);
}

async function handleCircleDefault(circleAddr: string, event: SdkEvent) {
  const [memberAddr, penalty, roundIndex] = getValueNative(event) as [string, bigint, number];

  await query(
    `INSERT INTO defaults (circle_address, member_address, round_index, penalty, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [circleAddr, memberAddr, roundIndex, penalty.toString(), event.txHash, event.ledger],
  );

  await query(
    `UPDATE circle_members SET defaults = defaults + 1
     WHERE circle_address = $1 AND member_address = $2`,
    [circleAddr, memberAddr],
  );
  console.log(`[indexer] Default: ${memberAddr} penalty ${penalty} round ${roundIndex} in ${circleAddr}`);
}

async function handleCircleCompleted(circleAddr: string) {
  await query(
    "UPDATE circles SET status = 'Completed', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  console.log(`[indexer] Circle completed: ${circleAddr}`);
}

async function handleReputationIncrement(event: SdkEvent) {
  const score = getValueNative(event) as number;
  // The member address is the second topic emitted by the reputation contract
  const memberAddr = scValToNative(event.topic[1] as xdr.ScVal) as string;

  await query(
    `INSERT INTO reputation (member_address, score, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (member_address) DO UPDATE SET score = $2, updated_at = NOW()`,
    [memberAddr, score],
  );
  console.log(`[indexer] Reputation: ${memberAddr} → score ${score}`);
}

// ─── Metrics ───────────────────────────────────────────────────────────────

// Cumulative counters surfaced in each cycle's summary log line so a spike in
// errors is visible without cross-referencing individual error entries.
let totalEventsProcessed = 0;
let totalEventsFailed = 0;

interface EventLogContext {
  contractId: string | null;
  topic: string;
  ledger: number;
  txHash?: string;
}

// Runs a single event's handler in isolation so a malformed or unexpected
// event (e.g. a contract upgrade adding/removing a topic field) can't abort
// the rest of the batch — without this, one bad event in a 100-event page
// would silently drop every event after it for that poll cycle.
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

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function processEvents(fromLedger: number, toLedger: number) {
  const startedAt = Date.now();
  let eventsSeen = 0;
  let eventsFailed = 0;

  // Factory + reputation events
  const factoryResponse = await rpc.getEvents({
    startLedger: fromLedger,
    filters: [
      {
        type: "contract",
        contractIds: [FACTORY, REPUTATION],
      },
    ],
    limit: EVENTS_LIMIT,
  });

  for (const event of factoryResponse.events) {
    if (!event.topic || event.topic.length < 2) continue;
    const topic0 = getTopicStr(event, 0);
    const topic1 = getTopicStr(event, 1);

    let handler: (() => Promise<void>) | null = null;
    if (topic0 === "factory" && topic1 === "circle_created") {
      handler = () => handleFactoryCircleCreated(event);
    } else if (topic0 === "reputation" && topic1 === "increment") {
      handler = () => handleReputationIncrement(event);
    }
    if (!handler) continue;

    eventsSeen++;
    const ok = await runEventHandler(handler, {
      contractId: getContractIdStr(event),
      topic: `${topic0}/${topic1}`,
      ledger: event.ledger,
      txHash: event.txHash,
    });
    if (!ok) eventsFailed++;
  }

  // Circle contract events — query all known circles
  const circles = await query<{ address: string }>("SELECT address FROM circles");

  if (circles.length > 0) {
    const circleAddresses = circles.map((c) => c.address);
    const circleResponse = await rpc.getEvents({
      startLedger: fromLedger,
      filters: [{ type: "contract", contractIds: circleAddresses }],
      limit: EVENTS_LIMIT,
    });

    for (const event of circleResponse.events) {
      if (!event.topic || event.topic.length < 2) continue;

      const contractId = getContractIdStr(event);
      if (!contractId) continue;

      const topic0 = getTopicStr(event, 0);
      const topic1 = getTopicStr(event, 1);

      if (topic0 !== "circle") continue;

      let handler: (() => Promise<void>) | null = null;
      switch (topic1) {
        case "joined":       handler = () => handleCircleJoined(contractId, event);      break;
        case "active":       handler = () => handleCircleActive(contractId);            break;
        case "contributed":  handler = () => handleCircleContributed(contractId, event); break;
        case "payout":       handler = () => handleCirclePayout(contractId, event);      break;
        case "default":      handler = () => handleCircleDefault(contractId, event);     break;
        case "completed":    handler = () => handleCircleCompleted(contractId);          break;
      }
      if (!handler) continue;

      eventsSeen++;
      const ok = await runEventHandler(handler, {
        contractId,
        topic: `circle/${topic1}`,
        ledger: event.ledger,
        txHash: event.txHash,
      });
      if (!ok) eventsFailed++;
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[indexer] Processed ledgers ${fromLedger}-${toLedger}: ` +
      `${eventsSeen} event(s), ${eventsFailed} failed, ${durationMs}ms` +
      (totalEventsFailed > 0 ? ` (${totalEventsFailed} failed since start)` : ""),
  );
}

export async function startIndexer() {
  console.log("[indexer] Starting CircleUp event indexer...");

  let lastLedger = await getLastLedger();
  if (lastLedger === 0) {
    const startLedger = parseInt(process.env.START_LEDGER || "0", 10);
    lastLedger = startLedger;
  }

  console.log(`[indexer] Starting from ledger ${lastLedger}`);

  setInterval(async () => {
    try {
      const latestLedger = await rpc.getLatestLedger();
      const toLedger = latestLedger.sequence;

      if (toLedger > lastLedger) {
        // processEvents isolates per-event failures internally; if it throws,
        // the failure is at the batch level (RPC/DB unreachable) so we must
        // NOT advance lastLedger — retry the same range next tick instead of
        // silently skipping the ledgers we failed to fetch.
        await processEvents(lastLedger + 1, toLedger);
        lastLedger = toLedger;
        await setLastLedger(lastLedger);
      }
    } catch (err) {
      console.error(
        `[indexer] Poll error (will retry from ledger ${lastLedger + 1}):`,
        err,
      );
    }
  }, POLL_INTERVAL_MS);
}

// Exposed for tests and potential future health/metrics endpoints.
export function getIndexerMetrics() {
  return { totalEventsProcessed, totalEventsFailed };
}
