import * as path from "node:path";
import { requestTracing } from "./requestTracing";
/**
 * CircleUp REST API
 *
 * GET /circles                         → list circles (paginated, sortable, status-filterable)
 *                                        ?status=  Pending|Active|Completed|Cancelled|Closed
 *                                        ?sort=    created_ledger|updated_at|round_amount|member_count|status
 *                                        ?order=   asc|desc  (default: desc)
 *                                        ?page=    positive integer (default: 1)
 *                                        ?limit=   1–100 (default: 20)
 * GET /circles/summary                 → circle counts by status (Pending/Active/Completed/Cancelled/Closed)
 * GET /circles/:address                → circle detail + members + rounds
 * GET /circles/:address/members        → members with reputation, contribution counts, and current-round status
 * GET /circles/:address/rounds         → all rounds grouped by round_index: payouts + contributions + defaults
 * GET /circles/:address/activity       → chronological event feed (join, contribute, payout, default, lifecycle)
 *                                        ordered by ledger ASC, event_position ASC; paginated
 *                                        ?page=  positive integer (default: 1)
 *                                        ?limit= 1–100 (default: 50)
 * GET /members/:member/circles         → circles the member belongs to (paginated, optional ?status=)
 *                                        ?status=  Pending|Active|Completed|Cancelled|Closed
 *                                        ?page=    positive integer (default: 1)
 *                                        ?limit=   1–100 (default: 20)
 * GET /members/:member/contributions   → member contribution history (optional ?circle=)
 * GET /reputation/:member              → member reputation score
 * GET /circles/:address/export.csv     → CSV of public member, contribution, default and payout
 *                                        records (bounded, deterministic, formula-safe)
 * GET /circles/:address/reconciliation → read-only comparison of indexed member order, status,
 *                                        current round and payouts with the contract's views
 * GET /indexer/state                   → indexer audit: last ledger + event counts + entity totals
 * GET /indexer/schema                  → schema versioning and migration status diagnostics
 * GET /indexer/failures                → open event-handler failures (skipped events)
 *                                        ?ledger=   restrict to one ledger
 *                                        ?eventId=  look up one RPC event id
 *                                        ?limit=    1–100 (default: 20)
 * GET /health                          → health check (db + RPC status)
 *
 * DB helpers used: query<T> (many rows), queryOne<T> (0‥1 rows → T|null),
 * queryExact<T> (exactly 1 row or throws). The queryOne/queryExact helpers
 * replace the fragile `const [row] = await query(...)` destructuring pattern
 * that silently produced undefined when no row existed (see pool.ts).
 */

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { query, queryOne, queryExact, withTransaction } from "./db/pool";
import { rpc, USDC, getIndexerMetrics, isIndexerRunning } from "./indexer";
import { STELLAR_RPC_URL } from "./config";
import {
  CSV_EXPORT_MAX_ROWS,
  CsvExportTooLargeError,
  buildCircleActivityCsv,
  exportFilename,
  resolveNetworkName,
  type ExportContributionRow,
  type ExportDefaultRow,
  type ExportMemberRow,
  type ExportPayoutRow,
} from "./csvExport";
import {
  createDbCircleSource,
  createRpcChainReader,
  isValidCircleAddress,
  reconcileCircle,
} from "./circleReconciliation";
import { groupCircleRounds } from "./groupRounds";
import { runAllHealthChecks, checkLiveness, checkReadiness } from "./health";
import { isUndefinedTable, listOpenEventFailures } from "./eventFailures";
import { redactAddress } from "./redact";
import { logApiCorsRejected, logApiRequest, logApiRequestError } from "./logger";
import type { MigrationHealth } from "./db/migrate";
import { encodeHistoryCursor, parseHistoryCursor } from "./historyCursor";

// ── Address validation ────────────────────────────────────────────────────────
//
// Stellar has two address namespaces:
//   G-prefix (56 base32 chars) — ed25519 public key (wallet / member address)
//   C-prefix (56 base32 chars) — Soroban contract ID (circle / factory / token)
//
// These regexes are intentionally inlined here so the indexer has no
// dependency on the app package's address module.
const STELLAR_PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;
const SOROBAN_CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/** Returns true for a valid Stellar ed25519 public key (G-prefix, 56 chars). */
function isStellarPublicKey(addr: string): boolean {
  return STELLAR_PUBLIC_KEY_RE.test(addr);
}

/** Returns true for a valid Soroban contract ID (C-prefix, 56 chars). */
function isSorobanContractId(addr: string): boolean {
  return SOROBAN_CONTRACT_ID_RE.test(addr);
}

/**
 * Returns true for any valid canonical Stellar address — either a public key
 * or a Soroban contract ID.  Route params that may legitimately be either type
 * (e.g. `:member`, `:address`) should be validated with this function.
 */
function isCanonicalStellarAddress(addr: string): boolean {
  return isStellarPublicKey(addr) || isSorobanContractId(addr);
}

// ── CORS ─────────────────────────────────────────────────────────────────────
//
// ALLOWED_ORIGINS is a comma-separated allow-list, e.g.
// "https://app.circleup.xyz,https://staging.circleup.xyz". Only entries that
// are well-formed http(s) origins (scheme + host [+ port], no path/query) are
// honoured — malformed entries are dropped (dev) or, in production, treated
// as a configuration error (see buildCorsOptions below).
function isValidOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    // An Origin header is scheme + host [+ port] only — reject anything that
    // also carries a path, query string, or fragment.
    return `${parsed.protocol}//${parsed.host}` === origin;
  } catch {
    return false;
  }
}

function parseAllowedOrigins(raw: string | undefined): { origins: string[]; invalid: string[] } {
  const entries = (raw || "").split(",").map((o) => o.trim()).filter(Boolean);
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    (isValidOrigin(entry) ? origins : invalid).push(entry);
  }
  return { origins, invalid };
}

/**
 * Build the CORS options for the API.
 *
 * When `allowedOrigins` is omitted, the list is parsed from ALLOWED_ORIGINS.
 * An empty or entirely-invalid list falls back to allowing every origin in
 * development (with a warning) but throws in production — a service running
 * with `NODE_ENV=production` must never silently start wide open.
 *
 * Credentials are always disabled: the API is read-only and unauthenticated
 * (no cookies or HTTP auth are ever expected), so there is no case where a
 * cross-origin request needs `Access-Control-Allow-Credentials`.
 */
export function buildCorsOptions(
  allowedOrigins?: string[],
  { nodeEnv = process.env.NODE_ENV }: { nodeEnv?: string } = {},
): cors.CorsOptions {
  const isProduction = nodeEnv === "production";
  let origins: string[];

  if (allowedOrigins !== undefined) {
    origins = allowedOrigins;
  } else {
    const parsed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
    if (parsed.invalid.length > 0) {
      const message =
        `[api] ALLOWED_ORIGINS contains invalid entries: ${parsed.invalid.join(", ")}. ` +
        `Each origin must be an absolute http(s) URL with no path, e.g. "https://app.circleup.xyz".`;
      if (isProduction) throw new Error(message);
      console.warn(`${message} Ignoring the invalid entries.`);
    }
    origins = parsed.origins;
  }

  if (origins.length === 0) {
    if (isProduction) {
      throw new Error(
        "[api] ALLOWED_ORIGINS must be set to a comma-separated list of allowed origins " +
          "when NODE_ENV=production. Refusing to start with CORS open to all origins.",
      );
    }
    console.warn(
      "[api] ALLOWED_ORIGINS is not set — allowing all origins. " +
        "Set ALLOWED_ORIGINS to a comma-separated list in production.",
    );
    return { origin: true, credentials: false };
  }

  return {
    origin(origin, callback) {
      // requests with no Origin header (curl, server-to-server, health checks)
      if (!origin || origins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: false,
  };
}

// ── Proxy trust (client identity for rate limiting) ──────────────────────────
//
// express-rate-limit keys requests by req.ip. Behind a reverse proxy (nginx,
// an ALB, Cloudflare) the real client address only appears in
// X-Forwarded-For, so Express must be told how many proxy hops to trust —
// left unset, every client is bucketed under the proxy's own IP (one shared
// limit for the whole service); trusted blindly (`trust proxy: true`), a
// client can forge X-Forwarded-For to reset its own limit on every request.
//
// TRUST_PROXY_HOPS: number of hops between the client and this process.
//   0 (default) — trust nothing; req.ip is the direct socket address. Correct
//                 for local dev and any deployment exposed directly.
//   N            — trust the Nth hop from the edge (e.g. 1 behind a single
//                  load balancer / reverse proxy).
function parseTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `[api] TRUST_PROXY_HOPS must be a non-negative integer, got: "${raw}"`,
    );
  }
  return n;
}

export const TRUST_PROXY_HOPS = parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// List, detail, health, and history routes have different cost and abuse
// profiles, so each route class gets its own bucket instead of one global
// limit: a burst against the expensive list/history endpoints can no longer
// starve health checks or cheap detail reads, and vice versa. Every class
// shares RATE_LIMIT_WINDOW_MS but has its own max, independently tunable via
// env so operators can raise/lower a single class without touching the rest.
//
// Response body is the same generic message for every class and every 429 —
// it never reveals which limit was hit, its configured value, or anything
// else about the service's internals. standardHeaders (RateLimit-*,
// Retry-After) is enabled because those headers are the intended, documented
// way for a well-behaved client to back off; that is not an internal detail.

const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000",
  10,
);

/** Paginated, sortable, joined list — the most expensive read the API offers. */
const RATE_LIMIT_LIST_MAX = parseInt(process.env.RATE_LIMIT_LIST_MAX || "30", 10);
/** Single-entity / small-aggregate reads (circle detail, members, rounds, reputation, summary, indexer state). */
const RATE_LIMIT_DETAIL_MAX = parseInt(process.env.RATE_LIMIT_DETAIL_MAX || "100", 10);
/** Member contribution history — paginated and joined, walkable across many pages by an attacker. */
const RATE_LIMIT_HISTORY_MAX = parseInt(process.env.RATE_LIMIT_HISTORY_MAX || "30", 10);
/** Health checks are polled frequently by uptime monitors/load balancers and must stay reachable under load elsewhere. */
const RATE_LIMIT_HEALTH_MAX = parseInt(process.env.RATE_LIMIT_HEALTH_MAX || "300", 10);

function createRateLimiter(max: number) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });
}

const listRateLimiter = createRateLimiter(RATE_LIMIT_LIST_MAX);
const detailRateLimiter = createRateLimiter(RATE_LIMIT_DETAIL_MAX);
const historyRateLimiter = createRateLimiter(RATE_LIMIT_HISTORY_MAX);
const healthRateLimiter = createRateLimiter(RATE_LIMIT_HEALTH_MAX);

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

// ── Pagination / query-param constants ───────────────────────────────────────

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

// "Closed" is not a contract-enum variant — the contract records it as a
// boolean flag (DataKey::Closed), but the indexer projects it as a status
// string when it receives a circle/closed event.  Including it here lets
// callers filter GET /circles?status=Closed to retrieve fully-settled circles
// without a full scan and client-side filter.
const CIRCLE_STATUSES = ["Pending", "Active", "Completed", "Cancelled", "Closed"] as const;
type CircleStatus = (typeof CIRCLE_STATUSES)[number];

const HEALTH_CHECK_TIMEOUT_MS = 5_000;
void HEALTH_CHECK_TIMEOUT_MS; // retained for reference; checks now live in health.ts

// ── Numeric wire format (issue #897) ────────────────────────────────────────
//
// Every numeric response field has exactly one JSON representation; the
// per-field table lives in docs/INDEXER_NUMERIC_WIRE_FORMAT.md and is
// enforced by sdk/src/indexerSchema.ts:
//
//   • Base-unit amounts (NUMERIC: round_amount, collateral, amount, penalty,
//     totals) → decimal integer strings, never JSON numbers. pg already
//     returns NUMERIC as a string; never pass one through Number().
//   • Persisted BIGINT columns (row `ledger`, `created_ledger`,
//     `round_deadline_ledgers`) → decimal strings, exactly as pg returns them.
//   • Values the handler computes or converts (counts, page metadata,
//     latestLedger / lastLedger, deadline ledgers, activity `ledger`) → JSON
//     safe integers via toSafeInteger, which refuses to round silently.

/**
 * Convert a pg BIGINT / COUNT value to a JSON number, throwing instead of
 * silently rounding when it is outside Number's safe-integer range.
 */
export function toSafeInteger(value: string | number | bigint, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${field} is outside the JSON safe-integer range and cannot be serialised as a number`);
  }
  return n;
}

type ParseResult<T> = T | { error: string };

function isParseError<T>(result: ParseResult<T>): result is { error: string } {
  return typeof result === "object" && result !== null && "error" in result;
}

function parsePage(value: unknown): ParseResult<number> {
  if (value === undefined) return DEFAULT_PAGE;
  const n = Number(value);
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > Math.floor(Number.MAX_SAFE_INTEGER / MAX_LIMIT)) {
    return { error: "page must be a positive integer" };
  }
  return n;
}

function parseLimit(value: unknown): ParseResult<number> {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > MAX_LIMIT) {
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

// Stellar address: G-address (account) or C-address (contract), 56 base32 chars.
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

function isStellarAddress(value: string): boolean {
  return STELLAR_ADDRESS_RE.test(value);
}

function parseAddress(value: string | undefined, label: string): ParseResult<string> {
  if (!value || value.trim() === "") {
    return { error: `${label} is required` };
  }
  const trimmed = value.trim();
  if (!isStellarAddress(trimmed)) {
    return { error: `${label} must be a valid Stellar address (G… or C…, 56 characters)` };
  }
  return trimmed;
}

function parseCircleFilter(value: unknown): ParseResult<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "circle must be a non-empty string" };
  }
  const trimmed = value.trim();
  if (!isStellarAddress(trimmed)) {
    return { error: "circle must be a valid Stellar address (G… or C…, 56 characters)" };
  }
  return trimmed;
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
  /** BIGINT — pg returns it as a decimal string. */
  round_deadline_ledgers: string | null;
  updated_at: string;
}

interface CircleMemberRow {
  circle_address: string;
  member_address: string;
  payout_order: number;
  join_order: number | null;
  collateral: string;
  defaults: number;
  joined_at: string | null;
  reputation_score: number | null;
}

interface CircleMemberWithContributionsRow extends CircleMemberRow {
  total_contributions: string;
  has_contributed_current_round: boolean;
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

interface EntityCountsSingleRow {
  circles: string;
  members: string;
  contributions: string;
  payouts: string;
  defaults: string;
}

interface CircleStatusCountRow {
  status: string;
  count: string;
}


export function createApp(options: {
  cachedMigrationHealth?: MigrationHealth | null;
  /** Returns true once the coordinated shutdown sequence has begun. */
  isShuttingDown?: () => boolean;
} = {}) {
  const app = express();
  app.set("trust proxy", TRUST_PROXY_HOPS);
  app.use(requestTracing);
  app.use(cors({ ...buildCorsOptions(), exposedHeaders: ["X-Request-ID"] }));
  app.use(express.json());

  // ── Shutdown gate ──────────────────────────────────────────────────────────
  //
  // The entrypoint owns the HTTP server and calls server.close() (stop
  // accepting new connections) followed by closeAllConnections() once the
  // bounded drain deadline elapses.  This middleware makes the transition
  // observable to handlers: once shutdown has begun, new requests are refused
  // with 503 + Connection: close so clients retry elsewhere instead of
  // starting work that would race the pool being closed.  Requests already
  // in flight are unaffected — they finish normally (or are cut off by
  // closeAllConnections at the deadline).
  //
  // Handlers in this module are all request-scoped: none of them schedule
  // timers, spawn background tasks, or hold a connection past the response,
  // so no additional cleanup is required here beyond refusing new work.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (options.isShuttingDown?.()) {
      res.setHeader("Connection", "close");
      res.setHeader("Retry-After", "1");
      sendError(res, 503, "Server is shutting down");
      return;
    }
    next();
  });

  // Issue 97: Instrument HTTP requests with bounded route and status-code classes
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const durationMs = Date.now() - start;
      const path = req.path || "";
      let routeClass: RouteClass = "other";
      if (path.startsWith("/health") || path === "/livez" || path === "/readyz") {
        routeClass = "health";
      } else if (path === "/metrics") {
        routeClass = "metrics";
      } else if (
        path.endsWith("/export.csv") ||
        path.endsWith("/rounds") ||
        path.endsWith("/activity") ||
        path.endsWith("/members") ||
        path.includes("/contributions")
      ) {
        routeClass = "history";
      } else if (
        path === "/circles/summary" ||
        path.startsWith("/reputation/") ||
        /^\/circles\/[^/]+$/.test(path)
      ) {
        routeClass = "detail";
      } else if (
        path === "/circles" ||
        path.startsWith("/members/") ||
        path.startsWith("/indexer/")
      ) {
        routeClass = "list";
      }
      recordHttpRequest(routeClass, res.statusCode, durationMs);
    });
    next();
  });

  // cors() calls next(err) for rejected origins instead of sending a response
  // itself — without this handler, Express's default error page would leak a
  // stack trace instead of a clean 403.
  app.use(
    (err: Error, req: Request, res: Response, next: express.NextFunction) => {
      if (err.message.startsWith("Origin ")) {
        logApiCorsRejected({
          method: req.method,
          path: typeof req.route?.path === "string" ? req.route.path : "unmatched",
          requestId: res.locals.requestId,
          origin: undefined,
        });
        res.status(403).json({ error: err.message });
        return;
      }
      next(err);
    },
  );

  app.get("/openapi/v1.json", detailRateLimiter, (_req: Request, res: Response) => {
    res.sendFile(path.resolve(__dirname, "../../docs/api/v1/openapi.json"));
  });

  // ── Health ───────────────────────────────────────────────────────────────────
  //
  // Runs all operational health checks in parallel:
  //   • Postgres connectivity
  //   • Soroban RPC connectivity
  //   • Indexer ledger lag (DB last_ledger vs RPC latest_ledger)
  //   • Schema migration health (surfaced from startup check or live query)
  //   • Contract state drift (DB current_round vs on-chain value for a sampled
  //     Active circle — skipped when RPC is unavailable)
  //
  // Returns HTTP 200 when all checks pass, 503 when any component is degraded
  // or errored, so load-balancers and uptime monitors can act on the status
  // code without parsing the body.

  app.get("/health", healthRateLimiter, async (req: Request, res: Response) => {
    const probe = req.query.probe;
    if (probe === "liveness" || probe === "live") {
      const liveness = checkLiveness(options.isShuttingDown);
      res.status(liveness.status === "ok" ? 200 : 503).json(liveness);
      return;
    }
    if (probe === "readiness" || probe === "ready") {
      const readiness = await checkReadiness({
        rpc,
        cachedMigrationHealth: options.cachedMigrationHealth ?? null,
        isShuttingDown: options.isShuttingDown,
      });
      res.status(readiness.ready ? 200 : 503).json(readiness);
      return;
    }

    const report = await runAllHealthChecks({
      rpc,
      usdcAddress: USDC,
      cachedMigrationHealth: options.cachedMigrationHealth ?? null,
    });
    res.status(
      report.serviceStatus === "healthy" || report.status === "ok" ? 200 : 503,
    ).json(report);
  });

  // Dedicated Liveness probe endpoint for orchestrators (Kubernetes / ECS / Docker)
  app.get("/health/live", healthRateLimiter, (_req: Request, res: Response) => {
    const liveness = checkLiveness(options.isShuttingDown);
    res.status(liveness.status === "ok" ? 200 : 503).json(liveness);
  });
  app.get("/livez", healthRateLimiter, (_req: Request, res: Response) => {
    const liveness = checkLiveness(options.isShuttingDown);
    res.status(liveness.status === "ok" ? 200 : 503).json(liveness);
  });

  // Dedicated Readiness probe endpoint for orchestrators & load-balancers
  app.get("/health/ready", healthRateLimiter, async (_req: Request, res: Response) => {
    const readiness = await checkReadiness({
      rpc,
      cachedMigrationHealth: options.cachedMigrationHealth ?? null,
      isShuttingDown: options.isShuttingDown,
    });
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });
  app.get("/readyz", healthRateLimiter, async (_req: Request, res: Response) => {
    const readiness = await checkReadiness({
      rpc,
      cachedMigrationHealth: options.cachedMigrationHealth ?? null,
      isShuttingDown: options.isShuttingDown,
    });
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  // Issue 97: Export bounded indexer pipeline metrics for operations
  app.get("/metrics", healthRateLimiter, (req: Request, res: Response) => {
    const format = req.query.format;
    const accept = req.headers.accept ?? "";
    if (format === "json" || (!format && accept.includes("application/json") && !accept.includes("text/plain"))) {
      res.json(getPipelineMetrics());
      return;
    }
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(formatPrometheusMetrics());
  });

  // ── Circles ──────────────────────────────────────────────────────────────────

  app.get("/circles", listRateLimiter, async (req: Request, res: Response) => {
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
           ORDER BY c.${sort} ${order.toUpperCase()}, c.address ASC
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

  app.get("/circles/summary", detailRateLimiter, async (_req: Request, res: Response) => {
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
        // Accept any known status, including the indexer-only "Closed" value
        // that the contract does not expose as an enum variant.
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

  app.get("/circles/:address", detailRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;
    try {
      const circle = await queryOne<CircleRow>(
        `SELECT * FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({
          error: "Circle not found",
          detail:
            `No circle with address '${address}' has been indexed yet. ` +
            `The circle may not exist on-chain, or the indexer may not have ` +
            `processed the factory/circle_created event for this address.`,
          address,
        });
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
      const indexerState = await queryOne<IndexerStateRow>(
        `SELECT last_ledger FROM indexer_state WHERE id = 1`,
      );
      const latestLedger = indexerState ? toSafeInteger(indexerState.last_ledger, "latestLedger") : null;

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
      console.error(`[api] Failed to load circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to load circle", getErrorMessage(err));
    }
  });

  // ── Dedicated members endpoint (#539) ────────────────────────────────────────
  //
  // Returns all members for a single circle in payout_order with:
  //   • reputation score (joined from reputation table)
  //   • total historical contribution count across all rounds
  //   • hasContributedCurrentRound — whether the member has contributed in the
  //     circle's current round index (useful for the circle detail UI without
  //     needing to load the full rounds history)
  //   • totals aggregate: memberCount, totalCollateral, totalContributions
  //   • roundDeadlineLedgers — from the circle row, so clients can derive
  //     per-member deadline estimates without a second request

  app.get("/circles/:address/members", detailRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;
    try {
      const circle = await queryOne<Pick<CircleRow, "address" | "current_round" | "round_deadline_ledgers">>(
        `SELECT address, current_round, round_deadline_ledgers FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({
          error: "Circle not found",
          detail:
            `No circle with address '${address}' has been indexed yet. ` +
            `The circle may not exist on-chain, or the indexer may not have ` +
            `processed the factory/circle_created event for this address.`,
          address,
        });
        return;
      }

      const [members, totals] = await Promise.all([
        query<CircleMemberWithContributionsRow>(
          `SELECT cm.member_address, cm.payout_order, cm.join_order, cm.collateral,
                  cm.defaults, cm.joined_at,
                  r.score as reputation_score,
                  COALESCE(
                    (SELECT COUNT(*) FROM contributions c2
                     WHERE c2.circle_address = cm.circle_address
                       AND c2.member_address = cm.member_address),
                    0
                  ) as total_contributions,
                  EXISTS(
                    SELECT 1 FROM contributions c3
                    WHERE c3.circle_address = cm.circle_address
                      AND c3.member_address = cm.member_address
                      AND c3.round_index = $2
                  ) as has_contributed_current_round
           FROM circle_members cm
           LEFT JOIN reputation r ON r.member_address = cm.member_address
           WHERE cm.circle_address = $1
           ORDER BY cm.payout_order`,
          [address, circle.current_round],
        ),
        // COALESCE guards SUM/COUNT-derived totals against NULL, which
        // Postgres returns for aggregates over zero rows (e.g. a circle with
        // no members yet, or no contributions recorded) — without it, a
        // freshly created circle would report total_collateral: null instead
        // of "0", inconsistent with member_count: 0.
        queryOne<CircleMemberTotalsRow>(
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

      // totals will always have a row (COUNT over zero rows returns one row
      // with count=0); use queryOne default fallback just in case.
      const t = totals ?? { member_count: "0", total_collateral: "0", total_contributions: "0" };

      res.json({
        members: members.map((m) => ({
          ...m,
          total_contributions: Number(m.total_contributions),
        })),
        totals: {
          memberCount: Number(t.member_count),
          totalCollateral: t.total_collateral,
          totalContributions: Number(t.total_contributions),
        },
        roundDeadlineLedgers: circle.round_deadline_ledgers,
      });
    } catch (err) {
      console.error(`[api] Failed to load members for circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to load circle members", getErrorMessage(err));
    }
  });

  // ── Rounds history endpoint (#540) ───────────────────────────────────────────
  //
  // Returns all indexed rounds for a circle grouped by round_index.  Each round
  // includes its payout (if settled), all contributions, all defaults, and a
  // resolved `status` (completed | current | cancelled | open).
  //
  // Grouping improvements over a flat payout list:
  //   • Rounds that have contributions or defaults but no payout yet are
  //     surfaced in `openRounds` instead of being silently dropped.
  //   • The active current round is always present in `currentRound` even when
  //     it has no activity yet.
  //   • Duplicate payout rows (replay / ingest anomaly) are de-duplicated by
  //     `buildPayoutIndex` with a non-fatal warning log.
  //   • `deadlineLedger` is computed for every round from
  //     `created_ledger + (roundIndex + 1) * round_deadline_ledgers` so clients
  //     can display a countdown without a separate RPC call.

  app.get("/circles/:address/rounds", detailRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;
    try {
      const circle = await queryOne<
        Pick<CircleRow, "address" | "current_round" | "total_rounds" | "status" | "created_ledger" | "round_deadline_ledgers">
      >(
        `SELECT address, current_round, total_rounds, status, created_ledger, round_deadline_ledgers FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({
          error: "Circle not found",
          detail:
            `No circle with address '${address}' has been indexed yet. ` +
            `The circle may not exist on-chain, or the indexer may not have ` +
            `processed the factory/circle_created event for this address.`,
          address,
        });
        return;
      }

      const [payouts, contributions, defaults] = await Promise.all([
        query<PayoutRow>(
          `SELECT * FROM payouts WHERE circle_address = $1 ORDER BY round_index, id LIMIT 101`,
          [address],
        ),
        query<ContributionRow>(
          `SELECT * FROM contributions WHERE circle_address = $1 ORDER BY round_index, created_at, id LIMIT 101`,
          [address],
        ),
        query<DefaultRow>(
          `SELECT * FROM defaults WHERE circle_address = $1 ORDER BY round_index, id LIMIT 101`,
          [address],
        ),
      ]);

      if ([payouts, contributions, defaults].some(rows => rows.length > MAX_LIMIT)) {
        sendError(res, 413, "Grouped history exceeds 100 records per kind; use /circles/:address/history with page and limit");
        return;
      }
      // Single-pass grouping by round_index so contributions/defaults for
      // unpaid rounds are never silently dropped, and we avoid O(n×m)
      // filter scans per payout.
      //
      // Every GroupedRound carries a `status` field ("completed", "current",
      // "cancelled", or "open") that is included in the serialised JSON so
      // clients can branch on lifecycle phase directly rather than inferring
      // it from the presence/absence of payout fields (issue #529).
      const { rounds, currentRound, openRounds, pendingDefaults } =
        groupCircleRounds(circle, payouts, contributions, defaults);

      // Compute deadlineLedger for each round when the circle has the
      // round_deadline_ledgers field set (present on circles created after
      // migration 001). Formula:
      //   deadline = created_ledger + (roundIndex + 1) * round_deadline_ledgers
      //
      // This is an approximation derived from the creation ledger; the exact
      // per-round deadline is set inside the contract but is not yet stored
      // as a separate indexed column.
      //
      // `circle` is non-null here — the early return above guards that — but
      // TypeScript cannot narrow it across a function boundary, so we capture
      // the non-null value explicitly.
      const nonNullCircle = circle;
      const computeDeadlineLedger = (roundIndex: number): number | null => {
        if (nonNullCircle.round_deadline_ledgers == null || nonNullCircle.created_ledger == null) {
          return null;
        }
        return (
          Number(nonNullCircle.created_ledger) +
          (roundIndex + 1) * Number(nonNullCircle.round_deadline_ledgers)
        );
      };

      const annotate = <C extends { round_index: number }, D extends { round_index: number }>(
        r: import("./groupRounds").GroupedRound<C, D>,
      ) => ({ ...r, deadlineLedger: computeDeadlineLedger(r.roundIndex) });

      res.json({
        rounds: rounds.map(annotate),
        currentRound: currentRound ? annotate(currentRound) : null,
        // Unpaid non-current rounds that still have activity (rare, but
        // previously invisible to clients).
        openRounds: openRounds.map(annotate),
        pendingDefaults,
      });
    } catch (err) {
      console.error(`[api] Failed to load rounds for circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to load circle rounds", getErrorMessage(err));
    }
  });

  // Flat history preserves access to records too large for grouped responses.
  app.get("/circles/:address/history", historyRateLimiter, async (req: Request, res: Response) => {
    const address = parseAddress(req.params.address, "Circle address");
    if (isParseError(address)) { res.status(400).json({ error: address.error }); return; }
    const paging = parseHistoryPage(req, res);
    if (!paging) return;
    try {
      const circle = await queryOne("SELECT address FROM circles WHERE address = $1", [address]);
      if (!circle) { sendError(res, 404, "Circle not found"); return; }
      const source = `SELECT 'contribution'::text AS kind, id, ledger, (to_jsonb(c) || jsonb_build_object('amount', c.amount::text, 'ledger', c.ledger::text)) AS record FROM contributions c WHERE circle_address = $1
        UNION ALL SELECT 'default', id, ledger, (to_jsonb(d) || jsonb_build_object('penalty', d.penalty::text, 'ledger', d.ledger::text)) FROM defaults d WHERE circle_address = $1
        UNION ALL SELECT 'payout', id, ledger, (to_jsonb(p) || jsonb_build_object('amount', p.amount::text, 'ledger', p.ledger::text)) FROM payouts p WHERE circle_address = $1`;
      const events = await query(`SELECT kind, record FROM (${source}) h ORDER BY ledger ASC, kind ASC, id ASC LIMIT $2 OFFSET $3`, [address, paging.limit, paging.offset]);
      const count = await queryExact<{ count: string }>(`SELECT COUNT(*)::text AS count FROM (${source}) h`, [address]);
      res.json({ circle_address: address, events, pagination: historyMetadata(paging, Number(count.count)) });
    } catch (err) { sendError(res, 500, "Failed to load circle history"); }
  });

  // ── Member contribution history endpoint (#541) ───────────────────────────────
  //
  // ── Member circles endpoint (#dashboard) ────────────────────────────────────
  //
  // Returns all circles a wallet address belongs to as a member, paged.
  // Each item is a { circle, member } pair so the caller can display both
  // circle status and per-member participation (collateral, defaults,
  // reputation, contributions) in a single request.
  //
  // Optional ?status= narrows to one lifecycle phase.  Missing members yield
  // an empty list (not 404) — the caller can distinguish "no circles" from
  // "indexer outage" via the response envelope.
  //
  // Rate-limited at the history tier (paginated join is moderately expensive).

  app.get("/members/:member/circles", historyRateLimiter, async (req: Request, res: Response) => {
    const memberResult = parseAddress(req.params.member, "Member address");
    if (isParseError(memberResult)) {
      res.status(400).json({ error: memberResult.error });
      return;
    }
    const member = memberResult;

    const pageResult  = parsePage(req.query.page);
    const limitResult = parseLimit(req.query.limit);
    const statusResult = parseStatus(req.query.status);

    const errors = [pageResult, limitResult, statusResult]
      .filter(isParseError)
      .map((r) => r.error);
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }

    const page   = pageResult  as number;
    const limit  = limitResult as number;
    const status = statusResult as CircleStatus | undefined;
    const offset = (page - 1) * limit;

    const statusClause = status ? "AND c.status = $2" : "";
    const baseParams: (string | number)[] = status
      ? [member, status]
      : [member];

    try {
      const [rows, countRow] = await Promise.all([
        query<{
          address: string;
          creator: string;
          round_amount: string;
          member_count: number;
          status: string;
          current_round: number;
          total_rounds: number;
          created_ledger: string;
          updated_at: string;
          // Both BIGINT expressions — pg returns decimal strings.
          deadline_ledger: string | null;
          round_deadline_ledgers: string | null;
          // member fields
          payout_order: number;
          join_order: number | null;
          collateral: string;
          defaults: number;
          joined_at: string | null;
          reputation_score: number | null;
          total_contributions: string;
        }>(
          `SELECT
             c.address, c.creator, c.round_amount, c.member_count,
             c.status, c.current_round, c.total_rounds, c.created_ledger,
             c.updated_at, c.round_deadline_ledgers,
             -- Approximate deadline: created_ledger + (current_round+1)*round_deadline_ledgers
             CASE
               WHEN c.round_deadline_ledgers IS NOT NULL AND c.status = 'Active'
               THEN c.created_ledger + (c.current_round + 1) * c.round_deadline_ledgers
               ELSE NULL
             END AS deadline_ledger,
             cm.payout_order, cm.join_order, cm.collateral,
             cm.defaults, cm.joined_at,
             r.score AS reputation_score,
             COALESCE(
               (SELECT COUNT(*) FROM contributions co
                WHERE co.circle_address = cm.circle_address
                  AND co.member_address = cm.member_address),
               0
             ) AS total_contributions
           FROM circle_members cm
           JOIN circles c ON c.address = cm.circle_address
           LEFT JOIN reputation r ON r.member_address = cm.member_address
           WHERE cm.member_address = $1
             ${statusClause}
           ORDER BY c.updated_at DESC, c.address ASC
           LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
          [...baseParams, limit, offset],
        ),
        queryExact<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM circle_members cm
           JOIN circles c ON c.address = cm.circle_address
           WHERE cm.member_address = $1
             ${status ? "AND c.status = $2" : ""}`,
          status ? [member, status] : [member],
        ),
      ]);

      const total      = Number(countRow.count);
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

      res.json({
        circles: rows.map((row) => ({
          circle: {
            address:                row.address,
            creator:                row.creator,
            round_amount:           row.round_amount,
            member_count:           row.member_count,
            status:                 row.status,
            current_round:          row.current_round,
            total_rounds:           row.total_rounds,
            created_ledger:         row.created_ledger,
            updated_at:             row.updated_at,
            // Computed ledger → JSON integer, matching GET /circles/:address
            // (issue #897: previously leaked the raw BIGINT string here).
            deadline_ledger:        row.deadline_ledger == null
                                      ? null
                                      : toSafeInteger(row.deadline_ledger, "deadline_ledger"),
            round_deadline_ledgers: row.round_deadline_ledgers,
          },
          member: {
            payout_order:        row.payout_order,
            join_order:          row.join_order,
            collateral:          row.collateral,
            defaults:            row.defaults,
            joined_at:           row.joined_at,
            reputation_score:    row.reputation_score,
            total_contributions: Number(row.total_contributions),
          },
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore: page < totalPages,
        },
      });
    } catch (err) {
      console.error(
        `[api] Failed to load circles for member ${redactAddress(member)}`,
        err,
      );
      sendError(res, 500, "Failed to load member circles", getErrorMessage(err));
    }
  });

  // ── Circle activity feed endpoint (#timeline) ─────────────────────────────
  //
  // Chronological event feed for a single circle.  Merges contributions,
  // defaults, and payouts from the relational tables into a single ordered
  // sequence sorted by ledger ASC, then by event kind (contribution before
  // payout within the same ledger), then by id ASC as a stable tie-breaker.
  //
  // Each entry carries the raw amount / penalty string, tx hash, ledger, and
  // created_at so the UI can render "Indexed · ledger N" without a second
  // fetch and can link to Stellar Expert.  Actor is the member_address for
  // contributions and defaults, and the recipient for payouts.
  //
  // Bounded: ?limit= max 100 (default 50).  Paginated with the standard
  // pagination envelope so the client can load older events on demand.
  //
  // Note: this endpoint returns projected relational data only.  It does NOT
  // decode raw XDR or expose event payloads.  The `type` field uses the same
  // event-type strings recognised by the app's normaliseEventCategory mapper,
  // so the CircleTimeline component can categorise them without changes.

  app.get("/circles/:address/activity", historyRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;

    const pageResult  = parsePage(req.query.page);
    const limitResult = parseLimit(req.query.limit);
    // Issue #898: optional opaque keyset cursor (see historyCursor.ts).
    const cursorResult = parseHistoryCursor(req.query.cursor, "activity", address);
    const activityErrors = [pageResult, limitResult, cursorResult].filter(isParseError).map((r) => r.error);
    if (!("error" in cursorResult) && cursorResult.mode === "cursor" && req.query.page !== undefined) {
      activityErrors.push("cursor and page cannot be combined");
    }
    if (activityErrors.length > 0) {
      res.status(400).json({ error: activityErrors.join("; ") });
      return;
    }
    const page   = pageResult  as number;
    const limit  = Math.min(limitResult as number, 100);
    const offset = (page - 1) * limit;
    const cursor = cursorResult as Exclude<typeof cursorResult, { error: string }>;

    try {
      const circle = await queryOne<Pick<CircleRow, "address">>(
        `SELECT address FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({
          error: "Circle not found",
          detail:
            `No circle with address '${address}' has been indexed yet. ` +
            `The circle may not exist on-chain, or the indexer may not have ` +
            `processed the factory/circle_created event for this address.`,
          address,
        });
        return;
      }

      // Unified event feed: contributions + defaults + payouts, ordered
      // deterministically by (ledger ASC, kind_order ASC, id ASC).
      // kind_order ensures payouts sort after same-ledger contributions/defaults.
      const eventsSql = `
        SELECT
          'circle_contribute'  AS type,
          member_address       AS actor,
          round_index          AS round,
          amount::text         AS amount,
          NULL::text           AS penalty,
          tx_hash,
          ledger::bigint       AS ledger,
          0                    AS event_position,
          id                   AS sort_id,
          created_at           AS timestamp
        FROM contributions WHERE circle_address = $1
        UNION ALL
        SELECT
          'circle_default'     AS type,
          member_address       AS actor,
          round_index          AS round,
          NULL::text           AS amount,
          penalty::text        AS penalty,
          tx_hash,
          ledger::bigint       AS ledger,
          1                    AS event_position,
          id                   AS sort_id,
          created_at           AS timestamp
        FROM defaults WHERE circle_address = $1
        UNION ALL
        SELECT
          'circle_payout'      AS type,
          recipient            AS actor,
          round_index          AS round,
          amount::text         AS amount,
          NULL::text           AS penalty,
          tx_hash,
          ledger::bigint       AS ledger,
          2                    AS event_position,
          id                   AS sort_id,
          created_at           AS timestamp
        FROM payouts WHERE circle_address = $1
      `;

      interface ActivityEventRow {
        type: string;
        actor: string;
        round: number;
        amount: string | null;
        penalty: string | null;
        tx_hash: string;
        ledger: string;
        event_position: number;
        sort_id: number;
        timestamp: string;
      }
      const activitySelect =
        `SELECT type, actor, round, amount, penalty, tx_hash, ledger,
                event_position, sort_id, timestamp
         FROM (${eventsSql}) ev`;
      const activityOrder = `ORDER BY ledger ASC, event_position ASC, sort_id ASC`;
      const activityCursor = (row: ActivityEventRow) =>
        encodeHistoryCursor("activity", address, [row.ledger, row.event_position, row.sort_id]);

      const serialiseEvents = (events: ActivityEventRow[]) => events.map((ev) => ({
          type:           ev.type,
          actor:          ev.actor,
          round:          ev.round,
          amount:         ev.type === "circle_payout" || ev.type === "circle_contribute"
                            ? ev.amount
                            : null,
          penalty:        ev.type === "circle_default" ? ev.penalty : null,
          tx_hash:        ev.tx_hash,
          ledger:         toSafeInteger(ev.ledger, "ledger"),
          event_position: ev.event_position,
          // Stable id for deterministic React keys: ledger-position-sort_id
          id:             `${ev.ledger}-${ev.event_position}-${ev.sort_id}`,
          timestamp:      ev.timestamp,
        }));

      if (cursor.mode === "cursor") {
        // Keyset scan: no OFFSET and no COUNT(*), so deep pages stay cheap.
        // One extra row tells us whether another page exists.
        const after = cursor.after;
        const rows = await query<ActivityEventRow>(
          after
            ? `${activitySelect}
               WHERE (ledger, event_position, sort_id) > ($2::bigint, $3::int, $4::int)
               ${activityOrder}
               LIMIT $5`
            : `${activitySelect} ${activityOrder} LIMIT $2`,
          after ? [address, after[0], after[1], after[2], limit + 1] : [address, limit + 1],
        );
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        res.json({
          circle_address: address,
          events: serialiseEvents(pageRows),
          pagination: {
            limit,
            hasMore,
            nextCursor: hasMore ? activityCursor(pageRows[pageRows.length - 1]) : null,
          },
        });
        return;
      }

      const [events, countRow] = await Promise.all([
        query<ActivityEventRow>(
          `${activitySelect}
           ${activityOrder}
           LIMIT $2 OFFSET $3`,
          [address, limit, offset],
        ),
        queryExact<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM (${eventsSql}) ev`,
          [address],
        ),
      ]);

      const total      = toSafeInteger(countRow.count, "total");
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      const hasMore    = page < totalPages;

      res.json({
        circle_address: address,
        events: serialiseEvents(events),
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore,
          // Lets a page-1 reader continue with the cheaper keyset scan.
          nextCursor: hasMore && events.length > 0 ? activityCursor(events[events.length - 1]) : null,
        },
      });
    } catch (err) {
      console.error(
        `[api] Failed to load activity for circle ${redactAddress(address)}`,
        err,
      );
      sendError(res, 500, "Failed to load circle activity", getErrorMessage(err));
    }
  });

  // ── Member contribution history (#541) ────────────────────────────────────
  //
  // Read-only ledger of every indexed contribution for a member. Unlike
  // /reputation/:member (which returns per-circle counts) and
  // /circles/:address/rounds (which nests contributions under payouts), this
  // endpoint returns the raw contribution rows so clients can build a personal
  // history view without scanning every circle.
  //
  // Optional ?circle=<address> narrows results to one circle. Missing members
  // yield an empty list (not 404) — same convention as /reputation/:member.
  // An unknown ?circle= address is a 404 so callers get a clear signal that
  // the filter itself is invalid rather than a silently empty result.
  //
  // The response includes a `totalAmount` aggregate (sum of all contribution
  // amounts for the queried scope) and a `hasMore` boolean convenience field
  // derived from the pagination envelope so clients can page without computing
  // `page < totalPages` themselves.

  app.get("/members/:member/contributions", historyRateLimiter, async (req: Request, res: Response) => {
    const memberResult = parseAddress(req.params.member, "Member address");
    if (isParseError(memberResult)) {
      res.status(400).json({ error: memberResult.error });
      return;
    }
    const member = memberResult;

    const pageResult = parsePage(req.query.page);
    const limitResult = parseLimit(req.query.limit);
    const circleResult = parseCircleFilter(req.query.circle);
    // Issue #898: the cursor is bound to this member + circle filter, so a
    // token cannot be replayed against a different query.
    const cursorFilter = `${member}|${isParseError(circleResult) ? "" : circleResult ?? ""}`;
    const cursorResult = parseHistoryCursor(req.query.cursor, "contributions", cursorFilter);

    const errors = [pageResult, limitResult, circleResult, cursorResult]
      .filter(isParseError)
      .map((r) => r.error);
    if (!("error" in cursorResult) && cursorResult.mode === "cursor" && req.query.page !== undefined) {
      errors.push("cursor and page cannot be combined");
    }

    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }

    const page = pageResult as number;
    const limit = limitResult as number;
    const circleFilter = circleResult as string | undefined;
    const offset = (page - 1) * limit;
    const cursor = cursorResult as Exclude<typeof cursorResult, { error: string }>;

    try {
      if (circleFilter) {
        const circle = await queryOne<Pick<CircleRow, "address">>(
          `SELECT address FROM circles WHERE address = $1`,
          [circleFilter],
        );
        if (!circle) {
          res.status(404).json({
            error: "Circle not found",
            detail:
              `No circle with address '${circleFilter}' has been indexed yet. ` +
              `The ?circle= filter must reference an address that exists in the indexer.`,
            address: circleFilter,
          });
          return;
        }
      }

      const whereSql = circleFilter
        ? "WHERE c.member_address = $1 AND c.circle_address = $2"
        : "WHERE c.member_address = $1";
      const whereParams: (string | number)[] = circleFilter
        ? [member, circleFilter]
        : [member];

      interface ContribAggRow { count: string; total_amount: string }
      // Keyset columns ride along under aliases that are stripped before
      // serialising, so the row shape on the wire is unchanged.
      interface KeyedContributionRow extends ContributionRow {
        cursor_id: number;
        cursor_created_at: string;
      }
      const contributionSelect =
        `SELECT c.circle_address, c.member_address, c.round_index, c.amount::text as amount,
                c.tx_hash, c.ledger, c.created_at,
                c.id AS cursor_id, c.created_at::text AS cursor_created_at
         FROM contributions c`;
      const contributionOrder = `ORDER BY c.ledger DESC, c.round_index DESC, c.created_at DESC, c.id DESC`;
      const contributionCursor = (row: KeyedContributionRow) =>
        encodeHistoryCursor("contributions", cursorFilter, [
          row.ledger,
          row.round_index,
          row.cursor_created_at,
          row.cursor_id,
        ]);
      const stripKeys = (rows: KeyedContributionRow[]): ContributionRow[] =>
        rows.map(({ cursor_id: _id, cursor_created_at: _at, ...row }) => row);

      if (cursor.mode === "cursor") {
        // Keyset scan (newest first): strictly after the previous page's last
        // row. Skips COUNT(*); `totalAmount` is still the full-scope sum.
        const after = cursor.after;
        const keyParams = after ? [after[0], after[1], after[2], after[3]] : [];
        const base = whereParams.length;
        const keyClause = after
          ? ` AND (c.ledger, c.round_index, c.created_at, c.id) < ($${base + 1}::bigint, $${base + 2}::int, $${base + 3}::timestamptz, $${base + 4}::int)`
          : "";
        const [rows, sum] = await Promise.all([
          query<KeyedContributionRow>(
            `${contributionSelect}
             ${whereSql}${keyClause}
             ${contributionOrder}
             LIMIT $${base + keyParams.length + 1}`,
            [...whereParams, ...keyParams, limit + 1],
          ),
          queryOne<{ total_amount: string }>(
            `SELECT COALESCE(SUM(c.amount), 0)::text as total_amount FROM contributions c ${whereSql}`,
            whereParams,
          ),
        ]);
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        res.json({
          member,
          circle: circleFilter ?? null,
          contributions: stripKeys(pageRows),
          totalAmount: sum?.total_amount ?? "0",
          pagination: {
            limit,
            hasMore,
            nextCursor: hasMore ? contributionCursor(pageRows[pageRows.length - 1]) : null,
          },
        });
        return;
      }

      const [keyedContributions, agg] = await Promise.all([
        query<KeyedContributionRow>(
          `${contributionSelect}
           ${whereSql}
           ${contributionOrder}
           LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
          [...whereParams, limit, offset],
        ),
        queryOne<ContribAggRow>(
          `SELECT COUNT(*) as count, COALESCE(SUM(c.amount), 0)::text as total_amount
           FROM contributions c
           ${whereSql}`,
          whereParams,
        ),
      ]);

      const total = toSafeInteger(agg?.count ?? 0, "total");
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      const hasMore = page < totalPages;
      const contributions = stripKeys(keyedContributions);

      res.json({
        member,
        circle: circleFilter ?? null,
        contributions,
        totalAmount: agg?.total_amount ?? "0",
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore,
          // Lets a page-1 reader continue with the cheaper keyset scan.
          nextCursor:
            hasMore && keyedContributions.length > 0
              ? contributionCursor(keyedContributions[keyedContributions.length - 1])
              : null,
        },
      });
    } catch (err) {
      console.error(
        `[api] Failed to load contributions for member ${redactAddress(member)}`,
        err,
      );
      sendError(
        res,
        500,
        "Failed to load member contributions",
        getErrorMessage(err),
      );
    }
  });

  // ── Reputation ───────────────────────────────────────────────────────────────

  app.get("/reputation/:member", detailRateLimiter, async (req: Request, res: Response) => {
    const memberResult = parseAddress(req.params.member, "Member address");
    if (isParseError(memberResult)) {
      res.status(400).json({ error: memberResult.error });
      return;
    }
    const member = memberResult;
    const paging = parseHistoryPage(req, res);
    if (!paging) return;

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
      const row = await queryOne<ReputationRow>(
        `SELECT * FROM reputation WHERE member_address = $1`,
        [member],
      );
      const scope = `SELECT circle_address FROM contributions WHERE member_address = $1
        UNION SELECT circle_address FROM defaults WHERE member_address = $1`;
      const scopeSql = `SELECT circle_address FROM (${scope}) scope ${circleFilter ? "WHERE circle_address = $2" : ""}`;
      const scopeParams = circleFilter ? [member, circleFilter] : [member];
      const selected = await query<{ circle_address: string }>(`${scopeSql} ORDER BY circle_address ASC LIMIT $${scopeParams.length + 1} OFFSET $${scopeParams.length + 2}`, [...scopeParams, paging.limit, paging.offset]);
      const selectedAddresses = selected.map(row => row.circle_address);
      const count = await queryExact<{ count: string }>(`SELECT COUNT(*)::text AS count FROM (${scopeSql}) s`, scopeParams);
      const contributions = await query<ReputationContributionSummaryRow>(
        `SELECT c.circle_address, COUNT(*) as contributions,
                ci.total_rounds
         FROM contributions c
         JOIN circles ci ON ci.address = c.circle_address
         WHERE c.member_address = $1
         AND c.circle_address = ANY($2::text[])
         GROUP BY c.circle_address, ci.total_rounds ORDER BY c.circle_address ASC`,
        [member, selectedAddresses],
      );
      const defaults = await query<ReputationDefaultSummaryRow>(
        `SELECT circle_address, COUNT(*) as count
         FROM defaults WHERE member_address = $1
         AND circle_address = ANY($2::text[])
         GROUP BY circle_address ORDER BY circle_address ASC`,
        [member, selectedAddresses],
      );

      // A missing reputation row is not an error — it just means this member
      // has no recorded activity yet, so a fresh score of 0 is returned.
      // `found` lets clients distinguish that from a member with a real,
      // explicitly-tracked zero score.
      //
      // COUNT(*) in PostgreSQL always comes back as a string over the wire;
      // cast to number here so the JSON response shape matches the declared
      // ApiReputationResponse type in sdk/src/types.ts.
      res.json({
        member,
        found: row != null,
        pagination: historyMetadata(paging, Number(count.count)),
        // When `found` is false, the member has no recorded reputation activity
        // yet. This means either no reputation/increment event has been emitted
        // for this wallet address, or the indexer has not yet processed it.
        // A score of 0 is returned in either case; clients can use `found` to
        // distinguish an untracked wallet from one with an explicit zero score.
        detail: row == null
          ? `Member '${member}' has no reputation record in the indexer. ` +
            `This address has not completed any circle rounds yet, or the ` +
            `reputation/increment event has not been indexed.`
          : undefined,
        score: row?.score ?? 0,
        contributions: contributions.map((c) => ({
          circle_address: c.circle_address,
          contributions: Number(c.contributions),
          total_rounds: Number(c.total_rounds),
        })),
        defaults: defaults.map((d) => ({
          circle_address: d.circle_address,
          count: Number(d.count),
        })),
        updatedAt: row?.updated_at ?? null,
      });
    } catch (err) {
      console.error(`[api] Failed to load reputation for member ${redactAddress(member)}`, err);
      sendError(res, 500, "Failed to load reputation", getErrorMessage(err));
    }
  });

  // ── Circle audit events ───────────────────────────────────────────────────────
  //
  // Returns the structured audit log for terminal lifecycle transitions
  // (cancelled and closed) for a specific circle.  This is distinct from
  // /indexer/state (which reports aggregate event counts across all circles)
  // and /circles/:address (which returns the summarised status row).
  //
  // Callers can use this endpoint to:
  //   - Display the exact closer address and release amounts in the UI
  //   - Compute penalty forfeitures: total_expected_collateral - total_released
  //   - Audit which member triggered cancellation / closure and when
  //
  // Returns an empty `events` array (not 404) when no audit rows exist yet
  // for the circle, since events may arrive slightly after the status update
  // during indexer replay.

  app.get("/circles/:address/audit", detailRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;
    const paging = parseHistoryPage(req, res);
    if (!paging) return;

    try {
      const [circle] = await query<Pick<CircleRow, "address">>(
        `SELECT address FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({ error: `Circle '${address}' not found` });
        return;
      }

      const events = await query<{
        id: number;
        circle_address: string;
        event_type: string;
        triggered_by: string | null;
        ledger: string | null;
        tx_hash: string | null;
        total_released: string | null;
        total_expected_collateral: string | null;
        close_reason: string | null;
        created_at: string;
      }>(
        `SELECT id, circle_address, event_type, triggered_by, ledger, tx_hash,
                total_released, total_expected_collateral, close_reason, created_at
         FROM circle_audit_events
         WHERE circle_address = $1
         ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3`,
        [address, paging.limit, paging.offset],
      );
      const count = await queryExact<{ count: string }>("SELECT COUNT(*)::text AS count FROM circle_audit_events WHERE circle_address = $1", [address]);
      res.json({ circle_address: address, events, pagination: historyMetadata(paging, Number(count.count)) });
    } catch (err) {
      console.error(`[api] Failed to load audit events for circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to load circle audit events", getErrorMessage(err));
    }
  });

  // ── Circle activity CSV export ──────────────────────────────────────────────
  //
  // Offline record of a circle's public indexed activity.  All reads run in
  // one READ ONLY, REPEATABLE READ transaction so the four record groups come
  // from the same snapshot even while the indexer is writing.  Exports above
  // CSV_EXPORT_MAX_ROWS are refused with 413 instead of being truncated.  See
  // src/csvExport.ts for column, ordering, amount and escaping rules.

  app.get("/circles/:address/export.csv", historyRateLimiter, async (req: Request, res: Response) => {
    const address = typeof req.params.address === "string" ? req.params.address.trim() : "";
    if (!isSorobanContractId(address)) {
      sendError(res, 400, "Circle address must be a valid Soroban contract address (C…, 56 characters)");
      return;
    }

    try {
      const result = await withTransaction(async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");

        const circle = await client.query(`SELECT address FROM circles WHERE address = $1`, [address]);
        if (circle.rowCount === 0) return { kind: "not_found" as const };

        const counts = await client.query(
          `SELECT ((SELECT COUNT(*) FROM circle_members WHERE circle_address = $1)
                 + (SELECT COUNT(*) FROM contributions  WHERE circle_address = $1)
                 + (SELECT COUNT(*) FROM defaults       WHERE circle_address = $1)
                 + (SELECT COUNT(*) FROM payouts        WHERE circle_address = $1))::text AS total`,
          [address],
        );
        const total = Number(counts.rows[0]?.total ?? 0);
        if (total > CSV_EXPORT_MAX_ROWS) return { kind: "too_large" as const, total };

        const [members, contributions, defaults, payouts] = [
          await client.query(
            `SELECT member_address, payout_order, join_order, defaults, collateral::text AS collateral
               FROM circle_members WHERE circle_address = $1
              ORDER BY payout_order ASC, member_address ASC`,
            [address],
          ),
          await client.query(
            `SELECT member_address, round_index, amount::text AS amount, ledger::text AS ledger, tx_hash
               FROM contributions WHERE circle_address = $1
              ORDER BY round_index ASC, ledger ASC, member_address ASC, tx_hash ASC`,
            [address],
          ),
          await client.query(
            `SELECT member_address, round_index, penalty::text AS penalty, ledger::text AS ledger, tx_hash
               FROM defaults WHERE circle_address = $1
              ORDER BY round_index ASC, ledger ASC, member_address ASC, tx_hash ASC`,
            [address],
          ),
          await client.query(
            `SELECT recipient, round_index, amount::text AS amount, is_exceptional,
                    ledger::text AS ledger, tx_hash
               FROM payouts WHERE circle_address = $1
              ORDER BY round_index ASC, ledger ASC, tx_hash ASC`,
            [address],
          ),
        ];

        return {
          kind: "ok" as const,
          csv: buildCircleActivityCsv({
            network: resolveNetworkName(STELLAR_RPC_URL),
            circleAddress: address,
            members: members.rows as ExportMemberRow[],
            contributions: contributions.rows as ExportContributionRow[],
            defaults: defaults.rows as ExportDefaultRow[],
            payouts: payouts.rows as ExportPayoutRow[],
          }),
        };
      });

      if (result.kind === "not_found") {
        sendError(res, 404, `Circle '${address}' not found`);
        return;
      }
      if (result.kind === "too_large") {
        sendError(res, 413, `Export exceeds the maximum of ${CSV_EXPORT_MAX_ROWS} rows`, {
          rows: result.total,
          maxRows: CSV_EXPORT_MAX_ROWS,
        });
        return;
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(address)}"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.status(200).send(result.csv);
    } catch (err) {
      if (err instanceof CsvExportTooLargeError) {
        sendError(res, 413, `Export exceeds the maximum of ${err.maxRows} rows`, {
          rows: err.rowCount,
          maxRows: err.maxRows,
        });
        return;
      }
      console.error(`[api] Failed to export activity for circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to export circle activity", getErrorMessage(err));
    }
  });

  // ── Circle reconciliation (diagnostic) ──────────────────────────────────────
  //
  // Read-only comparison of one circle's indexed member order, status, current
  // round and payout records with the contract's own views.  Never writes.
  // The response distinguishes genuine drift (200, outcome "mismatch") from an
  // unreachable RPC (503, outcome "rpc_unavailable") and from an address that
  // is not a CircleUp circle (422, outcome "incompatible_contract").  See
  // src/circleReconciliation.ts for the field mapping.

  app.get("/circles/:address/reconciliation", historyRateLimiter, async (req: Request, res: Response) => {
    const address = typeof req.params.address === "string" ? req.params.address.trim() : "";
    if (!isValidCircleAddress(address)) {
      sendError(res, 400, "Circle address must be a valid Soroban contract address (C…)");
      return;
    }

    try {
      const report = await reconcileCircle(address, {
        reader: createRpcChainReader(rpc),
        source: createDbCircleSource(query),
      });
      const status =
        report.outcome === "not_indexed"
          ? 404
          : report.outcome === "rpc_unavailable"
            ? 503
            : report.outcome === "incompatible_contract"
              ? 422
              : 200;
      res.status(status).json(report);
    } catch (err) {
      console.error(`[api] Failed to reconcile circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to reconcile circle", getErrorMessage(err));
    }
  });

  // ── Indexer ──────────────────────────────────────────────────────────────────

  // Audit endpoint for ops/monitoring: reports how far the indexer has
  // progressed and how many events it has ingested per type, independent of
  // /health (which only checks connectivity, not indexing progress).
  app.get("/indexer/state", detailRateLimiter, async (_req: Request, res: Response) => {
    try {
      const [stateRows, eventCountRows, [entityCounts], statusRows] = await Promise.all([
        query<IndexerStateAuditRow>(
          `SELECT last_ledger, updated_at FROM indexer_state WHERE id = 1`,
        ),
        query<EventTypeCountRow>(
          `SELECT event_type, COUNT(*) as count FROM ingested_events GROUP BY event_type`,
        ),
        query<EntityCountsSingleRow>(
          `SELECT
             (SELECT COUNT(*) FROM circles)::text AS circles,
             (SELECT COUNT(*) FROM circle_members)::text AS members,
             (SELECT COUNT(*) FROM contributions)::text AS contributions,
             (SELECT COUNT(*) FROM payouts)::text AS payouts,
             (SELECT COUNT(*) FROM defaults)::text AS defaults`,
        ),
        query<CircleStatusCountRow>(
          `SELECT status, COUNT(*) as count FROM circles GROUP BY status`,
        ),
      ]);

      const state = stateRows[0] ?? null;
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

      const circlesByStatus: Record<string, number> = {};
      for (const row of statusRows) {
        circlesByStatus[row.status] = Number(row.count);
      }

      res.json({
        lastLedger: toSafeInteger(state.last_ledger, "lastLedger"),
        updatedAt: state.updated_at,
        totalEvents,
        eventCounts,
        entityCounts: {
          circles: Number(entityCounts?.circles ?? 0),
          members: Number(entityCounts?.members ?? 0),
          contributions: Number(entityCounts?.contributions ?? 0),
          payouts: Number(entityCounts?.payouts ?? 0),
          defaults: Number(entityCounts?.defaults ?? 0),
          circlesByStatus,
        },
      });
    } catch (err) {
      console.error("[api] Failed to load indexer state", err);
      sendError(res, 500, "Failed to load indexer state", getErrorMessage(err));
    }
  });

  // Operational health endpoint: exposes poll-cycle metrics, backoff state,
  // and event processing counts for monitoring dashboards and alerting.
  app.get("/indexer/health", detailRateLimiter, async (_req: Request, res: Response) => {
    try {
      const metrics = getIndexerMetrics();
      const running = isIndexerRunning();

      // Determine overall status: degraded if backoff is elevated, healthy otherwise
      const status = metrics.backoffConsecutiveFailures > 0 ? "degraded" : "ok";

      res.status(status === "ok" ? 200 : 503).json({
        status,
        running,
        backfill: metrics.backfill,
        events: {
          processed: metrics.totalEventsProcessed,
          failed: metrics.totalEventsFailed,
          skipped: metrics.totalEventsSkipped,
          retried: metrics.totalEventsRetried,
        },
        pollCycles: {
          completed: metrics.pollCyclesCompleted,
          failed: metrics.pollCyclesFailed,
        },
        lastPoll: {
          durationMs: metrics.lastPollDurationMs,
          ledgerRange: metrics.lastPollLedgerRange,
        },
        backoff: {
          consecutiveFailures: metrics.backoffConsecutiveFailures,
          currentIntervalMs: metrics.backoffCurrentIntervalMs,
        },
      });
    } catch (err) {
      console.error("[api] Failed to load indexer health", err);
      sendError(res, 500, "Failed to load indexer health", getErrorMessage(err));
    }
  });

  // Events the indexer skipped because their handler failed, and which have
  // not since been re-ingested or acknowledged.  Rows carry the event's
  // identity (RPC event id, ledger, tx hash, contract, type) and a redacted
  // error — never the event payload.  See docs/INDEXER_RELIABILITY.md for the
  // safe reprocessing path.
  app.get("/indexer/failures", detailRateLimiter, async (req: Request, res: Response) => {
    const limitResult = parseLimit(req.query.limit);
    if (isParseError(limitResult)) {
      sendError(res, 400, limitResult.error);
      return;
    }

    let ledger: number | undefined;
    if (req.query.ledger !== undefined) {
      const n = Number(req.query.ledger);
      if (typeof req.query.ledger !== "string" || !/^[0-9]+$/.test(req.query.ledger) || !Number.isSafeInteger(n) || n < 0) {
        sendError(res, 400, "ledger must be a non-negative integer");
        return;
      }
      ledger = n;
    }

    let eventId: string | undefined;
    if (req.query.eventId !== undefined) {
      if (typeof req.query.eventId !== "string" || !/^[0-9A-Za-z:_-]{1,200}$/.test(req.query.eventId)) {
        sendError(res, 400, "eventId must be an RPC event id");
        return;
      }
      eventId = req.query.eventId;
    }

    try {
      const failures = await listOpenEventFailures({ ledger, eventId, limit: limitResult });
      res.json({ failures, count: failures.length, limit: limitResult });
    } catch (err) {
      if (isUndefinedTable(err)) {
        sendError(res, 503, "event_failures table is missing — run migrations");
        return;
      }
      console.error("[api] Failed to load event failures", err);
      sendError(res, 500, "Failed to load event failures", getErrorMessage(err));
    }
  });

  // Exposes the full migration history for ops and diagnostics: which migrations
  // have been applied, which are pending, and whether the schema is clean.
  app.get("/indexer/schema", detailRateLimiter, async (_req: Request, res: Response) => {
    try {
      const { checkMigrationHealth } = await import("./db/migrate");
      const health = await checkMigrationHealth();
      res.json({
        state: health.state,
        summary: health.summary,
        canStartSafely: health.canStartSafely,
        currentVersion: health.status.currentVersion,
        applied: health.status.applied,
        pending: health.status.pending,
        missingOnDisk: health.status.missingOnDisk,
        modified: health.status.modified,
      });
    } catch (err) {
      console.error("[api] Failed to load schema status", err);
      sendError(res, 500, "Failed to load schema status", getErrorMessage(err));
    }
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const message = getErrorMessage(err);
    logApiRequestError({
      method: req.method,
      path: typeof req.route?.path === "string" ? req.route.path : "unmatched",
          requestId: res.locals.requestId,
      statusCode: 500,
      error: "Request failed",
    });
    console.error("[api] Unhandled error", err);
    sendError(res, 500, "Internal server error", message);
  });

  return app;
}

/**
 * Close an HTTP server created from createApp() with a bounded drain period.
 *
 * Sequence (matches the coordinated shutdown in the entrypoint):
 *   1. server.close() — stop accepting new connections; in-flight requests
 *      are allowed to finish and their sockets close naturally.
 *   2. If the server has not closed within `drainMs`, force-close every
 *      remaining socket via closeAllConnections() so a stuck request cannot
 *      block process replacement indefinitely.
 *
 * Resolves with `{ drained: true }` when all connections finished within the
 * deadline, or `{ drained: false, forced: true }` when the deadline was hit
 * and remaining connections were terminated.  Never rejects — callers log the
 * outcome and proceed to close the pool.  Safe to call more than once: a
 * second call on an already-closed server resolves immediately without
 * touching sockets again.
 */
export async function closeHttpServer(
  server: import("node:http").Server,
  drainMs: number,
): Promise<{ drained: boolean; forced: boolean }> {
  if (!server.listening) {
    return { drained: true, forced: false };
  }

  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<{ drained: boolean; forced: boolean }>((resolve) => {
    server.close(() => resolve({ drained: true, forced: false }));
    timer = setTimeout(() => {
      // Deadline exceeded: terminate remaining sockets.  server.close()'s
      // callback still fires once the sockets are gone, but we resolve now so
      // the caller is not held up by a socket that refuses to close.
      try {
        server.closeAllConnections();
      } catch {
        // Older Node versions without closeAllConnections — nothing to do.
      }
      resolve({ drained: false, forced: true });
    }, drainMs);
    if (typeof timer.unref === "function") timer.unref();
  });

  const result = await closed;
  if (timer) clearTimeout(timer);
  return result;
}

function parseHistoryPage(req: Request, res: Response): { page: number; limit: number; offset: number } | null {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit);
  if (isParseError(page) || isParseError(limit)) {
    res.status(400).json({ error: [page, limit].filter(isParseError).map(e => e.error).join("; ") });
    return null;
  }
  return { page, limit, offset: (page - 1) * limit };
}
function historyMetadata(p: { page: number; limit: number }, total: number) {
  const totalPages = Math.ceil(total / p.limit);
  return { page: p.page, limit: p.limit, total, totalPages, hasMore: p.page < totalPages };
}
