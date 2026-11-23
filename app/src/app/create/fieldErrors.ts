/**
 * Structured field-error layer for the create-circle form.
 *
 * This module extracts the field-error types, stable key constants, and
 * helpers that back the form's inline messages, error summary, aria wiring,
 * and focus management. Keeping them here — separate from the component state
 * and the pure validation logic in CreateClient — lets tests import the
 * helpers without mounting React.
 *
 * Relationships:
 *   • `CreateFormErrors` (CreateClient.tsx)   — raw per-field string errors
 *   • `FieldError` (this file)                — structured, keyed, sourced
 *   • `buildFieldErrors`                      — maps the former to the latter
 *   • `FIELD_KEYS`                            — stable string constants
 *   • `fieldErrorId` / `fieldInputId`         — deterministic DOM ids
 *   • `describeField`                         — aria-describedby value
 *   • `firstInvalidField`                     — focus target after submit
 *   • `isWalletOrRpcError`                    — separates wallet/RPC from input
 */

import type { CreateFormErrors } from "./CreateClient";

// ─── Field key constants ──────────────────────────────────────────────────────

/**
 * Stable string identifiers for every field that can carry a validation
 * message. Prefer these over raw string literals in tests and render code so
 * a rename in validation logic surfaces as a type error rather than a silent
 * drift.
 *
 * Member rows are keyed by index (`"member:0"`, `"member:1"`, …) rather than
 * through this object because the count is dynamic. `membersGeneral` is the
 * list-level key (count / duplicates) distinct from any individual row.
 */
export const FIELD_KEYS = {
  name: "name",
  amount: "amount",
  days: "days",
  /** List-level members key (count constraints, duplicates). */
  membersGeneral: "members",
} as const;

/** All possible field key shapes, including per-row member keys. */
export type FieldKey = "name" | "amount" | "days" | "members" | `member:${number}`;

// ─── Structured field error ───────────────────────────────────────────────────

/**
 * A single validation issue tied to one field.
 *
 * `source` distinguishes local input errors from wallet / RPC failures so
 * they can be rendered in separate channels. Only `"input"` values are
 * included in the inline error summary; `"wallet"` and `"rpc"` values live in
 * the submit-level error region.
 */
export interface FieldError {
  key: FieldKey;
  message: string;
  /** Where the error originates — determines which UI region shows it. */
  source: "input" | "wallet" | "rpc";
}

// ─── DOM id helpers ───────────────────────────────────────────────────────────

/**
 * Stable, unique DOM id for the inline error message belonging to a field key.
 *
 * The id is derived deterministically from the key so it never depends on
 * React's `useId` and can be computed in tests and in aria-describedby
 * expressions outside the component.
 *
 * @example
 * fieldErrorId("amount")   → "create-field-amount-err"
 * fieldErrorId("member:2") → "create-field-member-2-err"
 */
export function fieldErrorId(key: FieldKey): string {
  return `create-field-${key.replace(":", "-")}-err`;
}

/**
 * Stable DOM id for the input element of a field key.
 *
 * Distinct from `fieldErrorId` so the two never collide, and so
 * `aria-labelledby` and `aria-describedby` can each reference the right node.
 *
 * @example
 * fieldInputId("name")     → "create-input-name"
 * fieldInputId("member:0") → "create-input-member-0"
 */
export function fieldInputId(key: FieldKey): string {
  return `create-input-${key.replace(":", "-")}`;
}

// ─── aria-describedby helper ──────────────────────────────────────────────────

/**
 * Build the `aria-describedby` value for a form input.
 *
 * Returns a space-separated string of ids (the field's own error message, and
 * any other hint ids the caller passes) when the field has an error, or
 * `undefined` when it is clean — `undefined` causes React to omit the
 * attribute entirely, which is the correct behaviour for a valid field.
 *
 * @example
 * describeField("amount", errors, [amountHintId])
 *   // when amount has an error: "create-field-amount-err hint-id"
 *   // when amount is clean:     undefined
 */
export function describeField(
  key: FieldKey,
  errors: FieldError[],
  extraIds: string[] = [],
): string | undefined {
  const hasError = errors.some((e) => e.key === key);
  const ids = [
    ...extraIds,
    hasError ? fieldErrorId(key) : null,
  ].filter(Boolean) as string[];
  return ids.length > 0 ? ids.join(" ") : undefined;
}

// ─── Focus management ────────────────────────────────────────────────────────

/** Document-order priority for each field key (lower = earlier in the form). */
function documentOrderPriority(key: FieldKey): number {
  if (key === "name") return 0;
  if (key === "amount") return 1;
  if (key === "days") return 2;
  if (key.startsWith("member:")) {
    const idx = parseInt(key.slice("member:".length), 10);
    return 10 + (Number.isFinite(idx) ? idx : 999);
  }
  // "members" (list-level) comes after all member rows
  return 1000;
}

/**
 * Return the key of the first field that has an error, in document / visual
 * order (name → amount → days → member rows in index order → membersGeneral).
 *
 * This is independent of the order the errors appear in the input array —
 * it always uses the form's visual order so focus moves predictably.
 *
 * Returns `null` when there are no errors, so the caller can skip focus
 * management entirely in the happy path.
 */
export function firstInvalidField(errors: FieldError[]): FieldKey | null {
  if (errors.length === 0) return null;
  const sorted = [...errors].sort(
    (a, b) => documentOrderPriority(a.key) - documentOrderPriority(b.key),
  );
  return sorted[0].key;
}

// ─── Wallet / RPC vs. input classification ───────────────────────────────────

/** Keywords that indicate a wallet or RPC failure rather than a form input error. */
const WALLET_RPC_KEYWORDS = [
  "wallet",
  "freighter",
  "rpc",
  "transaction",
  "submission",
  "rejected",
  "timed out",
  "timeout",
  "network",
  "contract",
];

/**
 * Returns `true` when a message string originates from a wallet or RPC failure
 * rather than a local form input error.
 *
 * Used to ensure wallet / RPC messages never leak into the inline error
 * summary and are always shown in the separate submit-error region.
 */
export function isWalletOrRpcError(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return WALLET_RPC_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── buildFieldErrors ─────────────────────────────────────────────────────────

/**
 * Map a `CreateFormErrors` result (or the `ok:true` / `ok:false` discriminated
 * union returned by `validateCreateForm`) to an ordered list of structured
 * `FieldError` entries.
 *
 * The list is sorted by field key so the order is deterministic and matches
 * the alphabetical key order used in the error summary and tests.
 *
 * Returns an empty array when the form result is `ok:true` or when no errors
 * are present.
 *
 * All entries carry `source: "input"` because `buildFieldErrors` only maps
 * local validation errors — wallet / RPC failures are handled by a separate
 * channel and must never appear here.
 */
export function buildFieldErrors(
  result:
    | { ok: true }
    | { ok: false; errors: CreateFormErrors }
    | CreateFormErrors,
): FieldError[] {
  // Accept either the full discriminated union or a raw errors object.
  let errors: CreateFormErrors;
  if ("ok" in result) {
    if (result.ok) return [];
    errors = (result as { ok: false; errors: CreateFormErrors }).errors;
  } else {
    errors = result as CreateFormErrors;
  }

  const list: FieldError[] = [];

  if (errors.name) {
    list.push({ key: "name", message: errors.name, source: "input" });
  }
  if (errors.amount) {
    list.push({ key: "amount", message: errors.amount, source: "input" });
  }
  if (errors.days) {
    list.push({ key: "days", message: errors.days, source: "input" });
  }
  errors.members?.forEach((message, i) => {
    if (message) {
      list.push({ key: `member:${i}` as FieldKey, message, source: "input" });
    }
  });
  if (errors.membersGeneral) {
    list.push({ key: "members", message: errors.membersGeneral, source: "input" });
  }

  // Sort by key for deterministic, alphabetical rendering order.
  list.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  return list;
}
