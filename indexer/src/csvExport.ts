/**
 * Safe CSV export of a circle's indexed activity (Issue #696).
 *
 * GET /circles/:address/export.csv returns one row per public record —
 * member, contribution, default, payout — for a single circle.  The output is:
 *
 *   Deterministic  fixed column set and order; rows grouped by record type in
 *                  a fixed order and sorted inside each group by stable keys
 *                  (compared by code unit, never by locale), so the same
 *                  indexed data always yields byte-identical output.
 *   Bounded        at most CSV_EXPORT_MAX_ROWS data rows.  A larger export is
 *                  refused (HTTP 413) rather than silently truncated.
 *   Exact          amounts come from Postgres NUMERIC as decimal strings and
 *                  are formatted with integer arithmetic only: amount_stroops
 *                  is the raw integer, amount_usdc the same value with exactly
 *                  7 decimal places.  Floating point is never involved.
 *   Inert          every field is protected against spreadsheet formula
 *                  injection (leading = + - @ TAB CR are neutralised with a
 *                  leading apostrophe) and RFC 4180-quoted when it contains a
 *                  comma, quote, or line break.
 *
 * Network context: every row carries the network name derived from
 * STELLAR_RPC_URL, so exports from testnet and mainnet cannot be confused.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard cap on data rows in one export (members + contributions + defaults + payouts). */
export const CSV_EXPORT_MAX_ROWS = 10_000;

/** USDC on Stellar uses 7 decimal places (1 USDC = 10^7 stroops). */
export const USDC_DECIMALS = 7;

/** Stable column order. Never reorder; append new columns at the end. */
export const CSV_COLUMNS = [
  "network",
  "circle_address",
  "record_type",
  "round_index",
  "member_address",
  "payout_order",
  "join_order",
  "defaults_count",
  "amount_stroops",
  "amount_usdc",
  "exceptional",
  "ledger",
  "tx_hash",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** Record groups, in output order. */
export const CSV_RECORD_TYPES = ["member", "contribution", "default", "payout"] as const;
export type CsvRecordType = (typeof CSV_RECORD_TYPES)[number];

// ─── Typed input rows (as read from Postgres) ────────────────────────────────

export interface ExportMemberRow {
  member_address: string;
  payout_order: number;
  join_order: number | null;
  defaults: number;
  /** NUMERIC as text. */
  collateral: string;
}

export interface ExportContributionRow {
  member_address: string;
  round_index: number;
  amount: string;
  ledger: string;
  tx_hash: string;
}

export interface ExportDefaultRow {
  member_address: string;
  round_index: number;
  penalty: string;
  ledger: string;
  tx_hash: string;
}

export interface ExportPayoutRow {
  recipient: string;
  round_index: number;
  amount: string;
  is_exceptional: boolean | null;
  ledger: string;
  tx_hash: string;
}

export interface CircleActivity {
  network: string;
  circleAddress: string;
  members: ExportMemberRow[];
  contributions: ExportContributionRow[];
  defaults: ExportDefaultRow[];
  payouts: ExportPayoutRow[];
}

export class CsvExportTooLargeError extends Error {
  constructor(readonly rowCount: number, readonly maxRows: number) {
    super(`export has ${rowCount} rows, more than the maximum of ${maxRows}`);
    this.name = "CsvExportTooLargeError";
  }
}

// ─── Monetary formatting ─────────────────────────────────────────────────────

const INTEGER_RE = /^-?\d+$/;

/**
 * Normalise an integer stroop amount (string from NUMERIC, or bigint) to its
 * canonical decimal-integer string.  Throws on anything that is not an exact
 * integer, so a corrupt value can never be exported as a plausible number.
 */
export function formatStroops(value: string | bigint): string {
  if (typeof value === "bigint") return value.toString();
  const trimmed = value.trim();
  if (!INTEGER_RE.test(trimmed)) {
    throw new Error(`amount is not an integer number of stroops: ${JSON.stringify(value)}`);
  }
  return BigInt(trimmed).toString();
}

/** Exact USDC decimal with USDC_DECIMALS places, e.g. "100000001" → "10.0000001". */
export function formatUsdc(value: string | bigint): string {
  const stroops = BigInt(formatStroops(value));
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(USDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

// ─── Field escaping ──────────────────────────────────────────────────────────

/**
 * Characters that make Excel, LibreOffice and Google Sheets treat a cell as a
 * formula (or, for TAB/CR, let one be smuggled past a naive check), plus their
 * full-width Unicode forms (＝ ＋ － ＠), which some spreadsheet locales
 * normalise to the ASCII trigger.
 */
const FORMULA_LEADING_RE = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;

/** Neutralise formula injection: prefix a leading trigger with an apostrophe. */
export function neutralizeFormula(value: string): string {
  return FORMULA_LEADING_RE.test(value) ? `'${value}` : value;
}

/**
 * Encode one CSV field: neutralise formulas, then quote per RFC 4180 when the
 * value contains a delimiter, quote, or line break (embedded quotes doubled).
 */
export function escapeCsvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeFormula(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ─── Row building ────────────────────────────────────────────────────────────

type CsvRecord = Partial<Record<CsvColumn, string | number | boolean | null>>;

/** Code-unit comparison: identical on every machine regardless of locale. */
function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byKeys<T>(...keys: Array<(row: T) => string | number>) {
  return (a: T, b: T): number => {
    for (const key of keys) {
      const c = cmp(key(a), key(b));
      if (c !== 0) return c;
    }
    return 0;
  };
}

/** Numeric ledger as a sortable number (ledgers fit comfortably in a double). */
const ledgerKey = (row: { ledger: string }) => Number(row.ledger);

function amountColumns(value: string): CsvRecord {
  return { amount_stroops: formatStroops(value), amount_usdc: formatUsdc(value) };
}

/** Total data rows an activity export would contain. */
export function countActivityRows(activity: Omit<CircleActivity, "network" | "circleAddress">): number {
  return (
    activity.members.length +
    activity.contributions.length +
    activity.defaults.length +
    activity.payouts.length
  );
}

/**
 * Build the CSV document.  Output starts with a UTF-8 BOM (so spreadsheet
 * apps detect the encoding of non-ASCII text) and uses CRLF line endings.
 *
 * @throws CsvExportTooLargeError when the activity exceeds `maxRows`.
 */
export function buildCircleActivityCsv(
  activity: CircleActivity,
  maxRows: number = CSV_EXPORT_MAX_ROWS,
): string {
  const total = countActivityRows(activity);
  if (total > maxRows) throw new CsvExportTooLargeError(total, maxRows);

  const base: CsvRecord = { network: activity.network, circle_address: activity.circleAddress };
  const records: CsvRecord[] = [];

  for (const m of [...activity.members].sort(
    byKeys<ExportMemberRow>((r) => r.payout_order, (r) => r.member_address),
  )) {
    records.push({
      ...base,
      record_type: "member",
      member_address: m.member_address,
      payout_order: m.payout_order,
      join_order: m.join_order,
      defaults_count: m.defaults,
      ...amountColumns(m.collateral),
    });
  }

  for (const c of [...activity.contributions].sort(
    byKeys<ExportContributionRow>((r) => r.round_index, ledgerKey, (r) => r.member_address, (r) => r.tx_hash),
  )) {
    records.push({
      ...base,
      record_type: "contribution",
      round_index: c.round_index,
      member_address: c.member_address,
      ...amountColumns(c.amount),
      ledger: c.ledger,
      tx_hash: c.tx_hash,
    });
  }

  for (const d of [...activity.defaults].sort(
    byKeys<ExportDefaultRow>((r) => r.round_index, ledgerKey, (r) => r.member_address, (r) => r.tx_hash),
  )) {
    records.push({
      ...base,
      record_type: "default",
      round_index: d.round_index,
      member_address: d.member_address,
      ...amountColumns(d.penalty),
      ledger: d.ledger,
      tx_hash: d.tx_hash,
    });
  }

  for (const p of [...activity.payouts].sort(
    byKeys<ExportPayoutRow>((r) => r.round_index, ledgerKey, (r) => r.tx_hash),
  )) {
    records.push({
      ...base,
      record_type: "payout",
      round_index: p.round_index,
      member_address: p.recipient,
      ...amountColumns(p.amount),
      exceptional: p.is_exceptional === true,
      ledger: p.ledger,
      tx_hash: p.tx_hash,
    });
  }

  const lines = [CSV_COLUMNS.join(",")];
  for (const record of records) {
    lines.push(CSV_COLUMNS.map((col) => escapeCsvField(record[col])).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ─── Network context ─────────────────────────────────────────────────────────

/**
 * Network name for the export, derived from the RPC URL the indexer reads
 * from.  Returns "unknown" rather than guessing for custom endpoints.
 */
export function resolveNetworkName(rpcUrl: string | undefined): string {
  let host = "";
  try {
    host = new URL(rpcUrl ?? "").hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host.includes("futurenet")) return "futurenet";
  if (host.includes("testnet")) return "testnet";
  if (host.includes("mainnet") || host.includes("pubnet")) return "mainnet";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "local";
  return "unknown";
}

/** Download filename for a circle export (address is a validated C… id). */
export function exportFilename(circleAddress: string): string {
  return `circle-${circleAddress}-activity.csv`;
}
