/**
 * Environment variable validation and typed config for the indexer.
 *
 * Required vars are checked once at module load time so a missing address
 * fails loudly on boot (clear message, non-zero exit) instead of surfacing
 * later as a cryptic RPC/DB error — e.g. an empty CIRCLE_FACTORY_ADDRESS
 * would otherwise make getEvents() silently return nothing forever.
 */

import * as dotenv from "dotenv";

dotenv.config();

const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "STELLAR_RPC_URL",
  "CIRCLE_FACTORY_ADDRESS",
  "REPUTATION_ADDRESS",
  "USDC_ADDRESS",
] as const;

const CONTRACT_ADDRESS_VARS = [
  "CIRCLE_FACTORY_ADDRESS",
  "REPUTATION_ADDRESS",
  "USDC_ADDRESS",
] as const;

/** Soroban contract IDs are C-prefixed, 56-char base32 strings. */
const SOROBAN_CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

type Env = Record<string, string | undefined>;

/** Returns the required keys that are missing or blank. Exported for unit testing. */
export function getMissingEnvVars(env: Env = process.env): string[] {
  return REQUIRED_ENV_VARS.filter((key) => !env[key] || env[key]!.trim() === "");
}

/**
 * Validate that every set contract address env var is a well-formed Soroban
 * contract ID (C-prefixed, 56 base32 chars). Returns one error string per
 * malformed value. Exported for unit testing.
 *
 * An empty/unset value is not flagged here — presence is checked separately
 * by {@link getMissingEnvVars}. This only fires when a value is present but
 * malformed, so a typo'd address fails fast at startup with a clear message.
 */
export function getMalformedContractAddresses(env: Env = process.env): string[] {
  const malformed: string[] = [];
  for (const key of CONTRACT_ADDRESS_VARS) {
    const value = env[key]?.trim();
    if (value && !SOROBAN_CONTRACT_ID_RE.test(value)) {
      malformed.push(
        `${key} is not a valid Soroban contract ID (expected C-prefixed 56-char base32, got "${value}")`,
      );
    }
  }
  return malformed;
}

/** Throws a single error listing every missing or malformed variable. Exported for unit testing. */
export function assertEnvVars(env: Env = process.env): void {
  const missing = getMissingEnvVars(env);
  const malformed = getMalformedContractAddresses(env);
  const problems = [
    ...missing.map((k) => `  • ${k} is missing or blank`),
    ...malformed.map((m) => `  • ${m}`),
  ];
  if (problems.length === 0) {
    console.log("[circleup-indexer] Environment validation passed ✓");
    return;
  }

  throw new Error(
    `[circleup-indexer] Environment variable configuration error:\n` +
      problems.join("\n") +
      `\n\nCopy indexer/.env.example to indexer/.env and fill in the correct values.`,
  );
}

/** Parses a positive-integer env var, falling back to `fallback` when unset. Exported for unit testing. */
export function parsePositiveIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`[circleup-indexer] ${name} must be a positive integer, got: "${raw}"`);
  }
  return n;
}

/** Exported for unit testing. */
export function parseStartLedger(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[circleup-indexer] START_LEDGER must be a non-negative integer, got: "${raw}"`);
  }
  return n;
}

// ── DB connection retry bounds ────────────────────────────────────────────────
// Hard upper bounds prevent a misconfigured env var from creating an
// indefinitely long startup stall.  The retry ceiling (50) gives plenty of
// headroom for slow container orchestration while still terminating within a
// reasonable time.  The delay ceiling (60 s) stops exponential backoff from
// producing absurdly long waits on a badly-set base delay.
const DB_CONNECT_MAX_RETRIES_MAX = 50;
const DB_CONNECT_BASE_DELAY_MS_MAX = 60_000;

/** Exported for unit testing. */
export function parseDbConnectMaxRetries(raw: string | undefined): number {
  const n = parsePositiveIntEnv("DB_CONNECT_MAX_RETRIES", raw, 5);
  if (n > DB_CONNECT_MAX_RETRIES_MAX) {
    throw new Error(
      `[circleup-indexer] DB_CONNECT_MAX_RETRIES must be at most ${DB_CONNECT_MAX_RETRIES_MAX}, got: "${raw}"`,
    );
  }
  return n;
}

/** Exported for unit testing. */
export function parseDbConnectBaseDelayMs(raw: string | undefined): number {
  const n = parsePositiveIntEnv("DB_CONNECT_BASE_DELAY_MS", raw, 1_000);
  if (n > DB_CONNECT_BASE_DELAY_MS_MAX) {
    throw new Error(
      `[circleup-indexer] DB_CONNECT_BASE_DELAY_MS must be at most ${DB_CONNECT_BASE_DELAY_MS_MAX}, got: "${raw}"`,
    );
  }
  return n;
}

// Soroban RPC's getEvents rejects a limit above 10,000, so bound it here with
// a clear message rather than letting a typo'd env var surface as an opaque
// RPC error on the first poll.
const MAX_EVENTS_LIMIT = 10_000;

/** Exported for unit testing. */
export function parseEventsLimit(raw: string | undefined): number {
  const n = parsePositiveIntEnv("EVENTS_LIMIT", raw, 100);
  if (n > MAX_EVENTS_LIMIT) {
    throw new Error(
      `[circleup-indexer] EVENTS_LIMIT must be at most ${MAX_EVENTS_LIMIT}, got: "${raw}"`,
    );
  }
  return n;
}

assertEnvVars();

export const DATABASE_URL = process.env.DATABASE_URL!;
export const STELLAR_RPC_URL = process.env.STELLAR_RPC_URL!;
export const CIRCLE_FACTORY_ADDRESS = process.env.CIRCLE_FACTORY_ADDRESS!;
export const REPUTATION_ADDRESS = process.env.REPUTATION_ADDRESS!;
export const USDC_ADDRESS = process.env.USDC_ADDRESS!;

export const PORT = parsePositiveIntEnv("PORT", process.env.PORT, 3001);
export const START_LEDGER = parseStartLedger(process.env.START_LEDGER);
export const POLL_INTERVAL_MS = parsePositiveIntEnv("POLL_INTERVAL_MS", process.env.POLL_INTERVAL_MS, 5_000);
export const EVENTS_LIMIT = parseEventsLimit(process.env.EVENTS_LIMIT);

// Maximum milliseconds to wait for in-flight work (poll cycle + HTTP drain +
// pool close) to finish before forcing a hard process.exit(1).  Keeping this
// bounded prevents a hung RPC call or a slow DB write from stalling a
// rolling deployment indefinitely.  Default: 30 s — long enough for a
// single Soroban RPC call with retries to complete.
export const SHUTDOWN_GRACE_PERIOD_MS = parsePositiveIntEnv(
  "SHUTDOWN_GRACE_PERIOD_MS",
  process.env.SHUTDOWN_GRACE_PERIOD_MS,
  30_000,
);

// ── DB pool startup retry ─────────────────────────────────────────────────────
// How many times connectWithRetry() will attempt to acquire the first
// Postgres connection before aborting boot.  Each retry uses exponential
// backoff starting at DB_CONNECT_BASE_DELAY_MS.
// Default: 5 attempts (delays: 1 s, 2 s, 4 s, 8 s → max ~15 s total wait).
export const DB_CONNECT_MAX_RETRIES = parseDbConnectMaxRetries(
  process.env.DB_CONNECT_MAX_RETRIES,
);

// Base delay in milliseconds for the first retry interval.  Each subsequent
// retry doubles this value (exponential backoff without jitter, since this
// is a single-instance startup probe rather than a distributed load-spread
// concern).  Default: 1000 ms.
export const DB_CONNECT_BASE_DELAY_MS = parseDbConnectBaseDelayMs(
  process.env.DB_CONNECT_BASE_DELAY_MS,
);
