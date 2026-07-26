/**
 * CircleUp REST API
 *
 * GET /circles                         → list circles (paginated, sortable, status-filterable)
 * GET /circles/summary                 → circle counts by status
 * GET /circles/:address                → circle detail + members + rounds
 * GET /circles/:address/members        → members with contribution status
 * GET /circles/:address/rounds         → all rounds (payouts + defaults)
 * GET /reputation/:member              → member reputation score
 * GET /indexer/state                   → indexer audit: last ledger + event counts
 * GET /health                          → health check (db + RPC status)
 */

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { query } from "./db/pool";
import { rpc, USDC } from "./indexer";

// ── CORS ─────────────────────────────────────────────────────────────────────
//
// ALLOWED_ORIGINS is a comma-separated allow-list, e.g.
// "https://app.circleup.xyz,https://staging.circleup.xyz". If unset, every
// origin is allowed (useful for local dev) but a warning is logged so this
// isn't mistaken for a deliberate production setting.
function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function buildCorsOptions(
  allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
): cors.CorsOptions {
  if (allowedOrigins.length === 0) {
    console.warn(
      "[api] ALLOWED_ORIGINS is not set — allowing all origins. " +
        "Set ALLOWED_ORIGINS to a comma-separated list in production.",
    );
    return { origin: true };
  }

  return {
    origin(origin, callback) {
      // requests with no Origin header (curl, server-to-server, health checks)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed`));
    },
  };
}

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Applies to every route including /health. Defaults to 100 requests per
// minute per IP; both are configurable so ops can tune per-deployment without
// a code change.
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100", 10);

const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function sendError(
  res: Response,
  status: number,
  message: string,
  details?: unknown,
) {
  res.status(status).json({
    error: {
      message,
      details: details ?? null,
    },
  });
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const SORTABLE_FIELDS = [
  "created_ledger",
  "updated_at",
  "round_amount",
  "member_count",
  "status",
] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

const CIRCLE_STATUSES = ["Pending", "Active", "Completed", "Cancelled"] as const;
type CircleStatus = (typeof CIRCLE_STATUSES)[number];

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

// ── CORS ─────────────────────────────────────────────────────────────────────
//
// ALLOWED_ORIGINS is a comma-separated allow-list, e.g.
// "https://app.circleup.xyz,https://staging.circleup.xyz". If unset, every
// origin is allowed (useful for local dev) but a warning is logged so this
// isn't mistaken for a deliberate production setting.
function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function buildCorsOptions(
  allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
): cors.CorsOptions {
  if (allowedOrigins.length === 0) {
    console.warn(
      "[api] ALLOWED_ORIGINS is not set — allowing all origins. " +
        "Set ALLOWED_ORIGINS to a comma-separated list in production.",
    );
    return { origin: true };
  }

  return {
    origin(origin, callback) {
      // requests with no Origin header (curl, server-to-server, health checks)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
  };
}

// ── Rate limiting ────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100", 10);

const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// ── Error helpers ────────────────────────────────────────────────────────────

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function sendError(res: Response, status: number, message: string, details?: unknown) {
  res.status(status).json({
    error: {
      message,
      details: details ?? null,
    },
  });
}

type ParseResult<T> = T | { error: string };

function isParseError<T>(result: ParseResult<T>): result is { error: string } {
  return typeof result === "object" && result !== null && "error" in result;
}

function parsePage(value: unknown): ParseResult<number> {
  if (value === undefined) return DEFAULT_PAGE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return { error: "page must be a positive integer" };
  }
  return n;
}

function parseLimit(value: unknown): ParseResult<number> {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return { error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
  }
  return n;
}

function parseSort(value: unknown): ParseResult<SortableField> {
  if (value === undefined) return "created_ledger";
  if (
    typeof value === "string" &&
    (SORTABLE_FIELDS as readonly string[]).includes(value)
  ) {
    return value as SortableField;
  }
  return { error: `sort must be one of: ${SORTABLE_FIELDS.join(", ")}` };
}

function parseOrder(value: unknown): ParseResult<"asc" | "desc"> {
  if (value === undefined) return "desc";
  if (value === "asc" || value === "desc") return value;
  return { error: "order must be 'asc' or 'desc'" };
}

function parseStatus(value: unknown): ParseResult<CircleStatus | undefined> {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (CIRCLE_STATUSES as readonly string[]).includes(value)
  ) {
    return value as CircleStatus;
  }
  return { error: `status must be one of: ${CIRCLE_STATUSES.join(", ")}` };
}

function parseCircleFilter(value: unknown): ParseResult<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "circle must be a non-empty string" };
  }
  return value.trim();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    }),
  ]);
}

interface ComponentHealth {
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}

async function checkComponentHealth(
  check: () => Promise<unknown>,
): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await withTimeout(check(), HEALTH_CHECK_TIMEOUT_MS);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface CircleRow {
  address: string;
  creator: string;
  round_amount: string;
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: string;
  round_deadline_ledgers: number | null;
  updated_at: string;
}

interface CircleMemberRow {
  circle_address: string;
  member_address: string;
  payout_order: number;
  collateral: string;
  defaults: number;
  joined_at: string | null;
  reputation_score: number | null;
}

interface CircleMemberWithContributionsRow extends CircleMemberRow {
  total_contributions: string;
}

interface CircleMemberTotalsRow {
  member_count: string;
  total_collateral: string;
  total_contributions: string;
}

interface ContributionRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface PayoutRow {
  circle_address: string;
  recipient: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface DefaultRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  penalty: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface ReputationRow {
  member_address: string;
  score: number;
  updated_at: string;
}

interface ReputationContributionSummaryRow {
  circle_address: string;
  contributions: string;
  total_rounds: number;
}

interface ReputationDefaultSummaryRow {
  circle_address: string;
  count: string;
}

interface IndexerStateRow {
  last_ledger: string;
}

interface IndexerStateAuditRow {
  last_ledger: string;
  updated_at: string;
}

interface EventTypeCountRow {
  event_type: string | null;
  count: string;
}

/** Returns a trimmed, non-empty version of a route param, or null if it's missing/blank. */
function nonBlankParam(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendError(
  res: Response,
  status: number,
  message: string,
  detail?: string,
): void {
  res.status(status).json({ error: message, ...(detail ? { detail } : {}) });
}

export function createApp() {
  const app = express();
  app.use(cors(buildCorsOptions()));
  app.use(apiRateLimiter);
  app.use(express.json());

  // cors() calls next(err) for rejected origins instead of sending a response
  // itself — without this handler, Express's default error page would leak a
  // stack trace instead of a clean 403.
  app.use(
    (err: Error, _req: Request, res: Response, next: express.NextFunction) => {
      if (err.message.startsWith("Origin ")) {
        res.status(403).json({ error: err.message });
        return;
      }
      next(err);
    },
  );

  // ── Health ───────────────────────────────────────────────────────────────────

  app.get("/health", async (_req: Request, res: Response) => {
    const [db, rpcHealth] = await Promise.all([
      checkComponentHealth(() => query("SELECT 1")),
      checkComponentHealth(() => rpc.getLatestLedger()),
    ]);

    const healthy = db.status === "ok" && rpcHealth.status === "ok";
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      db,
      rpc: rpcHealth,
      // Surfaces the configured USDC token address so operators can confirm
      // the indexer and app (NEXT_PUBLIC_USDC_ADDRESS) are tracking the same
      // token without cross-referencing separate .env files.
      config: { usdcAddress: USDC },
    });
  });

  // ── Circles ──────────────────────────────────────────────────────────────────

  app.get("/circles", async (req: Request, res: Response) => {
    const pageResult = parsePage(req.query.page);
    const limitResult = parseLimit(req.query.limit);
    const sortResult = parseSort(req.query.sort);
    const orderResult = parseOrder(req.query.order);
    const statusResult = parseStatus(req.query.status);

    const errors = [pageResult, limitResult, sortResult, orderResult, statusResult]
      .filter(isParseError)
      .map((r) => r.error);

    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }

    const page = pageResult as number;
    const limit = limitResult as number;
    const sort = sortResult as SortableField;
    const order = orderResult as "asc" | "desc";
    const status = statusResult as CircleStatus | undefined;

    const offset = (page - 1) * limit;
    const whereClause = status ? "WHERE c.status = $1" : "";
    const whereParams = status ? [status] : [];

    try {
      const [circles, [countRow]] = await Promise.all([
        query<
          Pick<
            CircleRow,
            | "address"
            | "creator"
            | "round_amount"
            | "member_count"
            | "status"
            | "current_round"
            | "total_rounds"
            | "created_ledger"
            | "updated_at"
          >
        >(
          `SELECT c.address, c.creator, c.round_amount, c.member_count,
                  c.status, c.current_round, c.total_rounds, c.created_ledger,
                  c.updated_at
           FROM circles c
           ${whereClause}
           ORDER BY c.${sort} ${order.toUpperCase()}
           LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
          [...whereParams, limit, offset],
        ),
        query<{ count: string }>(
          `SELECT COUNT(*) as count FROM circles c ${whereClause}`,
          whereParams,
        ),
      ]);
      const total = Number(countRow.count);

      res.json({
        circles,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.error("[api] Failed to list circles", err);
      sendError(res, 500, "Failed to list circles", getErrorMessage(err));
    }
  });

  app.get("/circles/summary", async (_req: Request, res: Response) => {
    try {
      const rows = await query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) as count FROM circles GROUP BY status`,
      );

      const byStatus = CIRCLE_STATUSES.reduce(
        (acc, s) => ({ ...acc, [s]: 0 }),
        {} as Record<CircleStatus, number>,
      );

      let total = 0;
      for (const row of rows) {
        const count = Number(row.count);
        total += count;
        if ((CIRCLE_STATUSES as readonly string[]).includes(row.status)) {
          byStatus[row.status as CircleStatus] = count;
        }
      }

      res.json({ total, byStatus });
    } catch (err) {
      console.error("[api] Failed to list circles", err);
      sendError(res, 500, "Failed to list circles", getErrorMessage(err));
    }
  });

  app.get("/circles/:address", async (req: Request, res: Response) => {
    const address = nonBlankParam(req.params.address);
    if (!address) {
      res.status(400).json({ error: "Circle address is required" });
      return;
    }
    try {
      const [circle] = await query<CircleRow>(
        `SELECT * FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({ error: `Circle '${address}' not found` });
        return;
      }

      const members = await query<CircleMemberRow>(
        `SELECT cm.*, r.score as reputation_score
         FROM circle_members cm
         LEFT JOIN reputation r ON r.member_address = cm.member_address
         WHERE cm.circle_address = $1
         ORDER BY cm.payout_order`,
        [address],
      );

      // Attach the latest indexed ledger so the client can derive wall-clock
      // estimates for the deadline countdown without a separate request.
      const [indexerState] = await query<IndexerStateRow>(
        `SELECT last_ledger FROM indexer_state WHERE id = 1`,
      );
      const latestLedger = indexerState ? Number(indexerState.last_ledger) : null;

      // Compute deadline_ledger for the current active round when we have
      // enough data.  Formula:
      //   deadline = created_ledger
      //            + (current_round + 1) * round_deadline_ledgers
      //
      // This is an approximation based on the creation ledger; the contract
      // sets the exact deadline per-round, but the indexer does not yet store
      // the per-round deadline_ledger from contract state.
      let deadlineLedger: number | null = null;
      if (
        circle.round_deadline_ledgers != null &&
        circle.created_ledger != null &&
        circle.status === "Active"
      ) {
        deadlineLedger =
          Number(circle.created_ledger) +
          (Number(circle.current_round) + 1) *
            Number(circle.round_deadline_ledgers);
      }

      res.json({
        circle: {
          ...circle,
          deadline_ledger: deadlineLedger,
        },
        members,
        latestLedger,
      });
    } catch (err) {
      console.error(`[api] Failed to load circle ${address}`, err);
      sendError(res, 500, "Failed to load circle", getErrorMessage(err));
    }
  });

  app.get("/circles/:address/members", async (req: Request, res: Response) => {
    const address = nonBlankParam(req.params.address);
    if (!address) {
      res.status(400).json({ error: "Circle address is required" });
      return;
    }
    try {
      const [circle] = await query<Pick<CircleRow, "address">>(
        `SELECT address FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({ error: `Circle '${address}' not found` });
        return;
      }

      const [members, [totals]] = await Promise.all([
        query<CircleMemberWithContributionsRow>(
          `SELECT cm.member_address, cm.payout_order, cm.collateral,
                  cm.defaults, cm.joined_at,
                  r.score as reputation_score,
                  (
                    SELECT COUNT(*) FROM contributions c2
                    WHERE c2.circle_address = cm.circle_address
                      AND c2.member_address = cm.member_address
                  ) as total_contributions
           FROM circle_members cm
           LEFT JOIN reputation r ON r.member_address = cm.member_address
           WHERE cm.circle_address = $1
           ORDER BY cm.payout_order`,
          [address],
        ),
        // COALESCE guards SUM/COUNT-derived totals against NULL, which
        // Postgres returns for aggregates over zero rows (e.g. a circle with
        // no members yet, or no contributions recorded) — without it, a
        // freshly created circle would report total_collateral: null instead
        // of "0", inconsistent with member_count: 0.
        query<CircleMemberTotalsRow>(
          `SELECT
             COUNT(cm.*) as member_count,
             COALESCE(SUM(cm.collateral), 0) as total_collateral,
             COALESCE(
               (SELECT COUNT(*) FROM contributions c WHERE c.circle_address = $1),
               0
             ) as total_contributions
           FROM circle_members cm
           WHERE cm.circle_address = $1`,
          [address],
        ),
      ]);

      res.json({
        members,
        totals: {
          memberCount: Number(totals.member_count),
          totalCollateral: totals.total_collateral,
          totalContributions: Number(totals.total_contributions),
        },
      });
    } catch (err) {
      console.error(`[api] Failed to load members for circle ${address}`, err);
      sendError(res, 500, "Failed to load circle members", getErrorMessage(err));
    }
  });

  app.get("/circles/:address/rounds", async (req: Request, res: Response) => {
    const address = nonBlankParam(req.params.address);
    if (!address) {
      res.status(400).json({ error: "Circle address is required" });
      return;
    }
    try {
      const [circle] = await query<
        Pick<CircleRow, "address" | "current_round" | "total_rounds" | "status">
      >(
        `SELECT address, current_round, total_rounds, status FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({ error: `Circle '${address}' not found` });
        return;
      }

      const payouts = await query<PayoutRow>(
        `SELECT * FROM payouts WHERE circle_address = $1 ORDER BY round_index`,
        [address],
      );
      const contributions = await query<ContributionRow>(
        `SELECT * FROM contributions WHERE circle_address = $1 ORDER BY round_index, created_at`,
        [address],
      );
      const defaults = await query<DefaultRow>(
        `SELECT * FROM defaults WHERE circle_address = $1 ORDER BY round_index`,
        [address],
      );

      // Group contributions and defaults by round
      const rounds = payouts.map((p) => ({
        roundIndex: p.round_index,
        status: "completed" as const,
        recipient: p.recipient,
        amount: p.amount,
        txHash: p.tx_hash,
        ledger: p.ledger,
        contributions: contributions.filter(
          (c) => c.round_index === p.round_index,
        ),
        defaults: defaults.filter((d) => d.round_index === p.round_index),
      }));

      // The round in progress has no payout yet, so it isn't in `rounds`
      // above — surface it separately (status "current" while the circle is
      // still Active, "cancelled" if it was cut short) rather than mixing an
      // incomplete entry into the completed-rounds list.
      const currentRoundHasPayout = payouts.some(
        (p) => p.round_index === circle.current_round,
      );
      const currentRound =
        !currentRoundHasPayout &&
        (circle.status === "Active" || circle.status === "Cancelled")
          ? {
              roundIndex: circle.current_round,
              status: circle.status === "Cancelled"
                ? ("cancelled" as const)
                : ("current" as const),
              recipient: null,
              amount: null,
              txHash: null,
              ledger: null,
              contributions: contributions.filter(
                (c) => c.round_index === circle.current_round,
              ),
              defaults: defaults.filter(
                (d) => d.round_index === circle.current_round,
              ),
            }
          : null;

      res.json({
        rounds,
        currentRound,
        pendingDefaults: defaults.filter(
          (d) => !payouts.find((p) => p.round_index === d.round_index),
        ),
      });
    } catch (err) {
      console.error(`[api] Failed to load rounds for circle ${address}`, err);
      sendError(res, 500, "Failed to load circle rounds", getErrorMessage(err));
    }
  });

  // ── Reputation ───────────────────────────────────────────────────────────────

  app.get("/reputation/:member", async (req: Request, res: Response) => {
    const member = nonBlankParam(req.params.member);
    if (!member) {
      res.status(400).json({ error: "Member address is required" });
      return;
    }

    // Optional ?circle=<address> narrows the contributions/defaults
    // breakdown to a single circle, e.g. for a member-in-circle detail view
    // instead of the member's activity across every circle they've joined.
    const circleResult = parseCircleFilter(req.query.circle);
    if (isParseError(circleResult)) {
      res.status(400).json({ error: circleResult.error });
      return;
    }
    const circleFilter = circleResult;

    try {
      const [row] = await query<ReputationRow>(
        `SELECT * FROM reputation WHERE member_address = $1`,
        [member],
      );
      const contributions = await query<ReputationContributionSummaryRow>(
        `SELECT c.circle_address, COUNT(*) as contributions,
                ci.total_rounds
         FROM contributions c
         JOIN circles ci ON ci.address = c.circle_address
         WHERE c.member_address = $1
         ${circleFilter ? "AND c.circle_address = $2" : ""}
         GROUP BY c.circle_address, ci.total_rounds`,
        circleFilter ? [member, circleFilter] : [member],
      );
      const defaults = await query<ReputationDefaultSummaryRow>(
        `SELECT circle_address, COUNT(*) as count
         FROM defaults WHERE member_address = $1
         ${circleFilter ? "AND circle_address = $2" : ""}
         GROUP BY circle_address`,
        circleFilter ? [member, circleFilter] : [member],
      );

      // A missing reputation row is not an error — it just means this member
      // has no recorded activity yet, so a fresh score of 0 is returned.
      // `found` lets clients distinguish that from a member with a real,
      // explicitly-tracked zero score.
      res.json({
        member,
        found: row != null,
        score: row?.score ?? 0,
        contributions,
        defaults,
        updatedAt: row?.updated_at ?? null,
      });
    } catch (err) {
      console.error(`[api] Failed to load reputation for member ${member}`, err);
      sendError(res, 500, "Failed to load reputation", getErrorMessage(err));
    }
  });

  // ── Indexer ──────────────────────────────────────────────────────────────────

  // Audit endpoint for ops/monitoring: reports how far the indexer has
  // progressed and how many events it has ingested per type, independent of
  // /health (which only checks connectivity, not indexing progress).
  app.get("/indexer/state", async (_req: Request, res: Response) => {
    try {
      const [stateRows, eventCountRows] = await Promise.all([
        query<IndexerStateAuditRow>(
          `SELECT last_ledger, updated_at FROM indexer_state WHERE id = 1`,
        ),
        query<EventTypeCountRow>(
          `SELECT event_type, COUNT(*) as count FROM ingested_events GROUP BY event_type`,
        ),
      ]);

      const [state] = stateRows;
      if (!state) {
        sendError(res, 500, "Indexer state has not been initialized");
        return;
      }

      const eventCounts: Record<string, number> = {};
      let totalEvents = 0;
      for (const row of eventCountRows) {
        const count = Number(row.count);
        totalEvents += count;
        eventCounts[row.event_type ?? "unknown"] = count;
      }

      res.json({
        lastLedger: Number(state.last_ledger),
        updatedAt: state.updated_at,
        totalEvents,
        eventCounts,
      });
    } catch (err) {
      console.error("[api] Failed to load indexer state", err);
      sendError(res, 500, "Failed to load indexer state", getErrorMessage(err));
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] Unhandled error", err);
    sendError(res, 500, "Internal server error", getErrorMessage(err));
  });

  return app;
}
