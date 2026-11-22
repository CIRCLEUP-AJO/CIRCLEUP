"use client";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { parseContractError, userMessageForError, type ContractAppError } from "@/lib/contractErrors";
import { observeWalletChanges } from "@/lib/walletIdentity";
import { useAnnouncer, ANNOUNCEMENTS } from "@/lib/useAnnouncer";
import { useDeploymentVerified, deploymentVerified } from "@/lib/deploymentState";
import { CopyControl } from "@/components/CopyControl";
import { useState, useId, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CIRCLE_FACTORY_ADDRESS,
  usdcToStroops,
  shortAddress,
  daysToLedgers,
  getExplorerLink,
  ACTIVE_NETWORK,
  formatUsdc,
  formatPot,
} from "@/lib/config";
import { isStellarPublicKey, isValidStellarAccount } from "@/lib/address";
import { getWalletAddress, invokeContract, WalletError } from "@/lib/stellar";
import { buildCreateCircleArgs } from "@/lib/createCircleArgs";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Member count bounds for a new circle.
 *
 * MIN_MEMBERS matches the contracts exactly: circle_factory rejects fewer than
 * 2 members ("need at least 2 members") before deploying anything.
 * MAX_MEMBERS is a product limit, deliberately tighter than the contracts'
 * MAX_MEMBERS of 256: every member must contribute each round and the rotation
 * runs one round per member, so a 256-member circle would last 256 rounds.
 *
 * Enforced in three places that must agree: the row controls (no adding past
 * MAX_MEMBERS rows, no removing below MIN_MEMBERS rows), the live member-count
 * status beside the list, and validateCreateForm, the gate before any wallet
 * prompt. The last two both count members with getMemberCountStatus.
 */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 20;

/** Maximum USDC decimal places supported by the contract (stroops precision). */
export const MAX_USDC_DECIMALS = 7;

/** Maximum allowed circle name length. */
export const MAX_NAME_LENGTH = 64;

/** Minimum round amount in USDC (one stroop). */
export const MIN_AMOUNT_USDC = "0.0000001";

/** Maximum round amount in USDC (sanity cap to prevent accidental huge values). */
const MAX_ROUND_USDC = 1_000_000;

/** Maximum round duration in days (~10 years). */
export const MAX_ROUND_DAYS = 3650;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-field validation errors. */
export interface CreateFormErrors {
  name?: string;
  amount?: string;
  days?: string;
  /** Per-index member errors (indices that are undefined have no error). */
  members?: (string | undefined)[];
  /** List-level member error (count, duplicates). */
  membersGeneral?: string;
}

/**
 * Stable identifiers for every field that can carry a validation message.
 *
 * Member rows are keyed by their row index (`member:0`, `member:1`, …) so a
 * message can be tied to exactly one input and cleared independently when that
 * row is corrected. `members` is the list-level key (count/duplicates) and
 * `wallet` is deliberately *not* a form field: wallet and RPC failures live in
 * a separate channel so they are never mislabeled as local input errors.
 */
export type FieldKey =
  | "name"
  | "amount"
  | "days"
  | "members"
  | `member:${number}`;

/** A single structured validation issue tied to a field key. */
export interface FieldError {
  key: FieldKey;
  message: string;
}

/** DOM id for the inline error message belonging to a field key. */
export function fieldErrorId(formId: string, key: FieldKey): string {
  return `${formId}-${key.replace(":", "-")}-err`;
}

/**
 * Flatten a CreateFormErrors object into an ordered list of structured issues.
 *
 * Order matches the visual order of the form (name → amount → duration →
 * member rows → member list), which is also the order the error summary lists
 * them and the order focus moves through them.
 */
export function toFieldErrorList(errors: CreateFormErrors): FieldError[] {
  const list: FieldError[] = [];
  if (errors.name) list.push({ key: "name", message: errors.name });
  if (errors.amount) list.push({ key: "amount", message: errors.amount });
  if (errors.days) list.push({ key: "days", message: errors.days });
  errors.members?.forEach((message, i) => {
    if (message) list.push({ key: `member:${i}`, message });
  });
  if (errors.membersGeneral) list.push({ key: "members", message: errors.membersGeneral });
  return list;
}

/** Human-readable label for a field key, used in the error summary. */
export function fieldLabel(key: FieldKey): string {
  if (key === "name") return "Circle name";
  if (key === "amount") return "Contribution amount";
  if (key === "days") return "Round duration";
  if (key === "members") return "Members";
  const idx = Number(key.slice("member:".length));
  return `Member ${idx + 1}`;
}

/** The normalised values returned when validation passes. */
export interface ValidatedCreateForm {
  name: string;
  validMembers: string[];
  amountStroops: bigint;
  roundDays: number;
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Return trimmed non-empty member strings in order. */
export function getFilledMembers(members: string[]): string[] {
  return members.map((m) => m.trim()).filter((m) => m.length > 0);
}

/** Where a member count sits relative to [MIN_MEMBERS, MAX_MEMBERS]. */
export type MemberCountStatus = "too_few" | "ok" | "too_many";

export function getMemberCountStatus(count: number): MemberCountStatus {
  if (count < MIN_MEMBERS) return "too_few";
  if (count > MAX_MEMBERS) return "too_many";
  return "ok";
}

/** The member figures the create form displays, derived from the raw rows. */
export interface MemberRowSummary {
  /** Distinct filled addresses: the members that would actually be submitted. */
  count: number;
  /** Rows that are empty or whitespace-only. They are ignored, never counted. */
  blankRows: number;
  /** Filled rows that repeat an earlier address (submit is blocked until fixed). */
  duplicateRows: number;
  status: MemberCountStatus;
}

/**
 * Summarise member rows for the live counter and the summary card.
 *
 * Blank rows are the default state of the form (it opens with four empty
 * rows), so they must never inflate the member count, the pot, or the
 * collateral figures. Duplicates are not counted twice either: the contract
 * rejects them, so counting them would preview a pot that can never exist.
 */
export function summarizeMemberRows(values: string[]): MemberRowSummary {
  const filled = getFilledMembers(values);
  const distinct = new Set(filled.map((m) => m.toLowerCase())).size;
  return {
    count: distinct,
    blankRows: values.length - filled.length,
    duplicateRows: filled.length - distinct,
    status: getMemberCountStatus(distinct),
  };
}

/**
 * Find duplicate addresses using case-insensitive comparison.
 * Returns the first duplicate found, or null if all are unique.
 */
export function findDuplicateAddress(addresses: string[]): string | null {
  const seen = new Set<string>();
  for (const addr of addresses) {
    const lower = addr.toLowerCase();
    if (seen.has(lower)) return addr;
    seen.add(lower);
  }
  return null;
}

/**
 * Count the significant decimal places in a decimal string.
 * "100"      → 0
 * "1.5"      → 1
 * "1.5000"   → 1  (trailing zeros are not significant)
 * "0.0000001"→ 7
 */
export function countDecimalPlaces(value: string): number {
  const dot = value.indexOf(".");
  if (dot === -1) return 0;
  const frac = value.slice(dot + 1).replace(/0+$/, "");
  return frac.length;
}

/**
 * Validate a single member row on the create flow.
 *
 * Returns `undefined` when the row is blank (unused rows are allowed and are
 * filtered out before submission) or when the entry is a checksum-valid
 * Stellar account address.  Otherwise returns a row-specific message that
 * always starts with `Member N:` (1-based), so the form can render it
 * directly beneath the offending input.
 *
 * Every failure mode gets its own message instead of one generic error:
 *   1. blank row             → skipped
 *   2. lowercase input       → base32 is case-sensitive, say so explicitly
 *   3. C… / M… prefix        → name the namespace that was actually entered
 *   4. shape (prefix/length/alphabet) → generic shape message
 *   5. strkey checksum       → right shape, wrong checksum — the classic typo
 *
 * Check 5 is the one that matters: without it a mistyped address passes the
 * form and only fails later, inside transaction construction, as an opaque
 * SDK error — after the wallet prompt has already appeared.
 *
 * Pure (no I/O), exported for tests and reusable anywhere else the app
 * collects member addresses.
 */
export function validateMemberEntry(raw: string, index: number): string | undefined {
  const row = `Member ${index + 1}`;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const generic = `${row}: must be a G-prefixed 56-character Stellar address.`;
  const upper = trimmed.toUpperCase();

  // A lowercased address fails the shape test for a different reason than a
  // typo does — without this hint the user "fixes" it into another wrong value.
  if (trimmed !== upper && isStellarPublicKey(upper)) {
    return (
      `${row}: must be a G-prefixed 56-character Stellar address typed in ` +
      `uppercase (Stellar addresses are case-sensitive).`
    );
  }

  if (upper.charAt(0) === "C") {
    return (
      `${row}: must be a G-prefixed wallet address — contract (C…)` +
      ` addresses cannot be circle members.`
    );
  }
  if (upper.charAt(0) === "M") {
    return (
      `${row}: must be a G-prefixed 56-character Stellar address — muxed ` +
      `(M…) addresses are not supported.`
    );
  }

  if (!isStellarPublicKey(trimmed)) return generic;

  if (!isValidStellarAccount(trimmed)) {
    return `${row}: checksum failed — check for a typo or a truncated copy-paste.`;
  }

  return undefined;
}

/**
 * Validate and normalise all create-circle form fields.
 *
 * Returns either:
 *   `{ ok: true,  values: ValidatedCreateForm }`  — safe to submit
 *   `{ ok: false, errors: CreateFormErrors }`      — show errors, do not submit
 *
 * Pure: no I/O, no side effects. Safe to call in tests without a browser.
 */
export function validateCreateForm(
  name: string,
  members: string[],
  roundUSDC: string,
  roundDays: string,
): { ok: true; values: ValidatedCreateForm } | { ok: false; errors: CreateFormErrors } {
  const errors: CreateFormErrors = {};

  // ── Name ──────────────────────────────────────────────────────────────────
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    errors.name = "Circle name is required.";
  } else if (trimmedName.length > MAX_NAME_LENGTH) {
    errors.name = `Circle name must be ${MAX_NAME_LENGTH} characters or fewer (currently ${trimmedName.length}).`;
  }

  // ── Amount ────────────────────────────────────────────────────────────────
  const amountStr = roundUSDC.trim();
  let amountStroops: bigint | undefined;

  if (amountStr === "" || amountStr === ".") {
    errors.amount = "Contribution amount is required.";
  } else {
    const amountNum = Number(amountStr);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      errors.amount = "Enter a valid positive amount.";
    } else if (amountNum === 0) {
      errors.amount = "Contribution amount must be greater than zero.";
    } else if (amountNum > MAX_ROUND_USDC) {
      errors.amount =
        `Round amount of $${amountNum.toLocaleString()} exceeds the maximum of ` +
        `$${MAX_ROUND_USDC.toLocaleString()} USDC.`;
    } else if (countDecimalPlaces(amountStr) > MAX_USDC_DECIMALS) {
      errors.amount =
        `USDC supports at most ${MAX_USDC_DECIMALS} decimal places. ` +
        `"${amountStr}" has ${countDecimalPlaces(amountStr)}.`;
    } else {
      // usdcToStroops is safe here — we've already checked the decimal count
      try {
        amountStroops = usdcToStroops(amountStr);
        if (amountStroops <= 0n) {
          errors.amount = "Contribution amount must be greater than zero.";
          amountStroops = undefined;
        }
      } catch (err) {
        errors.amount = err instanceof Error ? err.message : "Invalid amount.";
      }
    }
  }

  // ── Round duration ────────────────────────────────────────────────────────
  const daysStr = roundDays.trim();
  let daysNum: number | undefined;

  if (daysStr === "") {
    errors.days = "Round duration is required.";
  } else {
    // Reject any fractional input — ledger math only makes sense for whole days
    if (daysStr.includes(".")) {
      errors.days = "Round duration must be a whole number of days.";
    } else {
      const parsed = parseInt(daysStr, 10);
      if (isNaN(parsed) || parsed < 1) {
        errors.days = "Round duration must be at least 1 day.";
      } else if (parsed > MAX_ROUND_DAYS) {
        errors.days = `Round duration cannot exceed ${MAX_ROUND_DAYS} days (≈10 years).`;
      } else {
        daysNum = parsed;
      }
    }
  }

  // ── Members — per-field ───────────────────────────────────────────────────
  // Every filled row is validated on its own, so one bad entry names itself
  // (`Member 3: …`) instead of the whole list failing later at encoding time.
  const memberErrors: (string | undefined)[] = members.map((raw, i) =>
    validateMemberEntry(raw, i),
  );

  const hasPerMemberErrors = memberErrors.some((e) => e !== undefined);
  if (hasPerMemberErrors) {
    errors.members = memberErrors;
  }

  // ── Members — list-level ──────────────────────────────────────────────────
  //
  // `validMembers` is the set that will actually reach the contract: filled,
  // trimmed, and address-validated (no blank rows, no bad checksums, no
  // contract-prefix entries).  It must exclude every row that already failed
  // validateMemberEntry so that:
  //
  //   a) membersGeneral count messages reflect only submittable addresses.
  //      A form like [A, "bad"] has 1 submittable member, not 2.
  //
  //   b) the `values.validMembers` returned on ok:true never contains an
  //      address that failed per-field validation — closing the gap where
  //      the contract call could receive an invalid payload.
  //
  // Both `getFilledMembers` (blank filter) and the per-field error check run
  // on the same `members` array in the same iteration, so the two lists stay
  // in sync without a second pass.
  const validMembers = members
    .map((raw, i) => ({ trimmed: raw.trim(), error: memberErrors[i] }))
    .filter(({ trimmed, error }) => trimmed.length > 0 && error === undefined)
    .map(({ trimmed }) => trimmed);

  const countStatus = getMemberCountStatus(validMembers.length);

  if (countStatus === "too_few") {
    errors.membersGeneral =
      `At least ${MIN_MEMBERS} members are required. ` +
      (validMembers.length === 0
        ? "Add member addresses below."
        : `You have ${validMembers.length}.`);
  } else if (countStatus === "too_many") {
    errors.membersGeneral =
      `A circle cannot have more than ${MAX_MEMBERS} members. ` +
      `You have ${validMembers.length}; remove ${validMembers.length - MAX_MEMBERS}.`;
  } else {
    const dup = findDuplicateAddress(validMembers);
    if (dup) {
      errors.membersGeneral =
        `Duplicate address: ${shortAddress(dup)}. Each member must appear exactly once.`;
    }
  }

  // ── Return ────────────────────────────────────────────────────────────────
  const hasErrors =
    errors.name !== undefined ||
    errors.amount !== undefined ||
    errors.days !== undefined ||
    hasPerMemberErrors ||
    errors.membersGeneral !== undefined;

  if (hasErrors || amountStroops === undefined || daysNum === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    values: {
      name: trimmedName,
      validMembers,
      amountStroops,
      roundDays: daysNum,
    },
  };
}

// ─── FieldError ───────────────────────────────────────────────────────────────
//
// Defined outside the component so React never treats it as a new component
// type on re-render, which would cause unnecessary unmount/remount cycles and
// break the live-region semantics of role="alert".

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600 flex items-center gap-1">
      <span aria-hidden="true">⚠</span> {message}
    </p>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreateClient() {
  // ── Accessible live-region announcer ────────────────────────────────────────
  //
  // Provides polite/assertive announcements for circle creation lifecycle
  // events (submitting, success, failure) and wallet errors.  The
  // AnnouncerPortal is rendered once at the root of this component.
  const { announce, AnnouncerPortal } = useAnnouncer();

  const actionAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const stop = observeWalletChanges(() => { actionAbortRef.current?.abort(); });
    return () => { stop(); actionAbortRef.current?.abort(); };
  }, []);
  const router = useRouter();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>(["", "", "", ""]);
  const [roundUSDC, setRoundUSDC] = useState("100");
  const [roundDays, setRoundDays] = useState("30");

  // ── Submission state ───────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  // Wallet / RPC / contract failures. Kept separate from `fieldErrors` so a
  // wallet or network problem is never rendered as a local input error.
  const [submitError, setSubmitError] = useState("");
  const [supportError, setSupportError] = useState<ContractAppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<CreateFormErrors>({});
  const [txHash, setTxHash] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  // Verified circle address derived from the factory event / transaction
  // result. Only set when the data is trustworthy; never guessed.
  const [circleAddress, setCircleAddress] = useState("");
  // Whether the user has opted to stay on the receipt instead of navigating.
  const [stayOnReceipt, setStayOnReceipt] = useState(false);

  // Whether validation has been attempted — controls when inline errors appear.
  // Before first submit, per-field errors are hidden so the form isn't
  // immediately hostile. After first submit they stay visible on every change.
  const [validated, setValidated] = useState(false);

  // Guards against concurrent submissions (rapid double-click, etc.)
  const submittingRef = useRef(false);

  // Owned timer for the post-success redirect. Stored in a ref so it can be
  // cleared on unmount, on user navigation, or when the user chooses to stay.
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRedirectTimer = useCallback(() => {
    if (redirectTimerRef.current !== null) {
      clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
  }, []);

  // Always clear any pending redirect when the component unmounts.
  useEffect(() => clearRedirectTimer, [clearRedirectTimer]);

  // ── Stable IDs ─────────────────────────────────────────────────────────────
  const formId        = useId();
  const nameId        = useId();
  const amountId      = useId();
  const amountHintId  = useId();
  const daysId        = useId();
  const membersHintId = useId();
  const submitErrId   = useId();
  const successId     = useId();
  const summaryId     = useId();

  // ── Focus management ────────────────────────────────────────────────────────
  const submitErrorRef = useRef<HTMLDivElement>(null);
  const successRef     = useRef<HTMLDivElement>(null);
  const summaryRef     = useRef<HTMLDivElement>(null);
  // One ref per member row for focusing the first invalid field
  const memberRefs     = useRef<(HTMLInputElement | null)[]>([]);
  const nameRef        = useRef<HTMLInputElement>(null);
  const amountRef      = useRef<HTMLInputElement>(null);
  const daysRef        = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (submitError && submitErrorRef.current) submitErrorRef.current.focus();
  }, [submitError]);

  useEffect(() => {
    if (txHash && successRef.current) successRef.current.focus();
  }, [txHash]);

  // Lifecycle-aware success redirect: only schedule when the transaction is
  // confirmed AND a verified circle address exists. The timer is owned by this
  // effect and cleared on cleanup (unmount, dependency change, or user opting
  // to stay), so it can never fire against an unmounted or navigated page.
  useEffect(() => {
    if (!confirmed || !circleAddress || stayOnReceipt) return;
    redirectTimerRef.current = setTimeout(() => {
      redirectTimerRef.current = null;
      router.push(`/circles/${circleAddress}`);
    }, 5000);
    return () => clearRedirectTimer();
  }, [confirmed, circleAddress, stayOnReceipt, router, clearRedirectTimer]);

  // ── Derived values ──────────────────────────────────────────────────────────
  // Distinct filled addresses only: blank rows and repeated addresses never
  // reach the contract, so they must not inflate the counter, pot, or summary.
  const memberSummary = summarizeMemberRows(members);
  const filledCount = memberSummary.count;

  // Stroops for the currently-typed amount. `usdcToStroops` throws on invalid
  // input; during typing we just want a displayable (possibly zero) figure, so
  // fall back to 0n. All pot/collateral figures derive from this integer, never
  // from floating point, so the create page shows the same 2-dp formatUsdc /
  // formatPot values as the rest of the app (issue #493).
  const roundStroops = (() => {
    try {
      return usdcToStroops(roundUSDC || "0");
    } catch {
      return 0n;
    }
  })();

  const potDisplay = formatPot(roundStroops, filledCount);
  const memberAmountDisplay = formatUsdc(roundStroops);

  // Live-validate after first submit attempt so errors update as user types.
  // Only the fields that actually changed are re-evaluated, so correcting one
  // input clears its own message without touching unrelated ones.
  useEffect(() => {
    if (!validated) return;
    const result = validateCreateForm(name, members, roundUSDC, roundDays);
    setFieldErrors(result.ok ? {} : result.errors);
  }, [validated, name, members, roundUSDC, roundDays]);

  // Structured, ordered list of issues for the summary and focus management.
  const fieldErrorList = toFieldErrorList(fieldErrors);
  const hasFieldErrors = fieldErrorList.length > 0;

  // ── Member helpers ──────────────────────────────────────────────────────────

  function updateMember(i: number, val: string) {
    setMembers((prev) => prev.map((m, idx) => (idx === i ? val : m)));
  }

  function addMember() {
    setMembers((prev) => (prev.length >= MAX_MEMBERS ? prev : [...prev, ""]));
  }

  function removeMember(i: number) {
    if (members.length <= MIN_MEMBERS) return;
    setMembers((prev) => prev.filter((_, idx) => idx !== i));
    // Shrink the refs array to stay in sync
    memberRefs.current = memberRefs.current.filter((_, idx) => idx !== i);
  }


  // ── Focus first error ────────────────────────────────────────────────────────
  //
  // Moves focus to the first invalid input (in visual order). When the only
  // issue is list-level (member count/duplicates) there is no single offending
  // input, so focus the error summary instead — it is focusable and links to
  // each affected field.
  function focusFirstError(errors: CreateFormErrors) {
    const first = toFieldErrorList(errors)[0];
    if (!first) return;
    switch (first.key) {
      case "name":
        nameRef.current?.focus();
        return;
      case "amount":
        amountRef.current?.focus();
        return;
      case "days":
        daysRef.current?.focus();
        return;
      case "members":
        summaryRef.current?.focus();
        return;
      default: {
        const idx = Number(first.key.slice("member:".length));
        memberRefs.current[idx]?.focus();
        return;
      }
    }
  }

  /** Move focus to the input (or summary) for a field key from the summary. */
  function focusField(key: FieldKey) {
    switch (key) {
      case "name":
        nameRef.current?.focus();
        return;
      case "amount":
        amountRef.current?.focus();
        return;
      case "days":
        daysRef.current?.focus();
        return;
      case "members":
        membersHintId && document.getElementById(membersHintId)?.focus();
        return;
      default: {
        const idx = Number(key.slice("member:".length));
        memberRefs.current[idx]?.focus();
        return;
      }
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!deploymentVerified()) { setSubmitError("Verify deployment before submitting."); return; }

    // Prevent concurrent submissions (rapid double-click guard). Armed before
    // the first await so a second click during the wallet prompt is dropped,
    // and disarmed in `finally` (every path, success or failure, passes
    // through it).
    if (submittingRef.current) return;
    submittingRef.current = true;
    const actionCtrl = new AbortController();
    actionAbortRef.current = actionCtrl;

    try {
      clearRedirectTimer();
      setSubmitError("");
      setSupportError(null);
      setTxHash("");
      setConfirmed(false);
      setCircleAddress("");
      setStayOnReceipt(false);
      setValidated(true);

      // ── Step 1: field validation ──────────────────────────────────────────
      const validation = validateCreateForm(name, members, roundUSDC, roundDays);
      if (!validation.ok) {
        setFieldErrors(validation.errors);
        focusFirstError(validation.errors);
        return; // never reach wallet
      }
      setFieldErrors({});
      // Local input is valid — clear any stale wallet/RPC message so it is not
      // mistaken for a form error on this attempt.
      setSubmitError("");

      const { validMembers, amountStroops, roundDays: days } = validation.values;

      // ── Step 2: wallet check ──────────────────────────────────────────────
      let walletAddress: string | null;
      try {
        walletAddress = await getWalletAddress();
      } catch (err) {
        if (err instanceof WalletError && err.reason === "not_installed") {
          const msg =
            "Freighter wallet extension is not installed. Visit https://freighter.app to install it.";
          setSubmitError(msg);
          const a = ANNOUNCEMENTS.walletError(msg);
          announce(a.message, a.politeness);
        } else {
          const msg = "Unable to access your wallet. Unlock Freighter and reconnect.";
          setSubmitError(msg);
          const a = ANNOUNCEMENTS.walletError(msg);
          announce(a.message, a.politeness);
        }
        return;
      }

      if (!walletAddress) {
        const msg = "Connect your Freighter wallet using the button in the top-right corner.";
        setSubmitError(msg);
        const a = ANNOUNCEMENTS.walletError(msg);
        announce(a.message, a.politeness);
        return;
      }

      // Creator participation (#873): the factory never adds the creator as a
      // member. A creator who wants to take part lists their own address, in
      // the rotation slot they want; omitting it creates a circle they only
      // organise.

      // ── Step 3: factory address guard ─────────────────────────────────────
      if (!CIRCLE_FACTORY_ADDRESS) {
        setSubmitError("Factory contract not configured. Deploy contracts first.");
        return;
      }

      // ── Step 4: submit ────────────────────────────────────────────────────
      setLoading(true);
      announce(ANNOUNCEMENTS.txSubmitting.message, ANNOUNCEMENTS.txSubmitting.politeness);
      // Exactly the factory's `create_circle(creator, members, round_amount,
      // round_deadline_ledgers)`. Members keep the order shown in the form —
      // that order is the payout rotation. The circle name is display-only
      // and is not an on-chain argument.
      const result = await invokeContract(
        CIRCLE_FACTORY_ADDRESS,
        "create_circle",
        buildCreateCircleArgs({
          creator: walletAddress,
          members: validMembers,
          amountStroops,
          deadlineLedgers: daysToLedgers(days),
        }),
        walletAddress,
        actionCtrl.signal,
      );
      if (actionCtrl.signal.aborted) return;

      if (!result.success) {
        setSupportError(result.typedError ?? parseContractError(result.error));
        if (result.txHash) setTxHash(result.txHash);
        const errMsg = userMessageForError(result.typedError ?? parseContractError(result.error));
        setSubmitError(errMsg);
        const fa = ANNOUNCEMENTS.circleCreateFailed(errMsg);
        announce(fa.message, fa.politeness);
        return;
      }

      setConfirmed(true);
      setTxHash(result.txHash ?? "");
      // Only trust a circle address that the factory/transaction result
      // actually returned. If it is absent, the receipt is shown without a
      // detail link and no redirect is scheduled.
      setCircleAddress(result.circleAddress ?? "");
      announce(ANNOUNCEMENTS.circleCreated.message, ANNOUNCEMENTS.circleCreated.politeness);
    } catch (err: unknown) {
      if (actionCtrl.signal.aborted) return;
      const safeError = parseContractError(err instanceof Error ? err.message : "");
      setSupportError(safeError);
      const errMsg = userMessageForError(safeError);
      setSubmitError(errMsg);
      const fa = ANNOUNCEMENTS.circleCreateFailed(errMsg);
      announce(fa.message, fa.politeness);
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }

  const explorerTxUrl = txHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", txHash)
    : null;

  const deploymentReady = useDeploymentVerified();
  const submitBlocked = !deploymentReady || loading || !!txHash;

  const submitDescribedBy = [
    submitError ? submitErrId : null,
    txHash      ? successId   : null,
  ].filter(Boolean).join(" ") || undefined;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto px-2 sm:px-0">
      {/*
        Accessible live-region portal — visually hidden, always in the DOM.
        Screen readers watch this for state-change announcements from the
        create-circle flow (submitting, success, error).
      */}
      <AnnouncerPortal />
      <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mb-2">
        Create a Circle
      </h1>
      <p className="text-slate-500 text-sm mb-8">
        Set up the members, contribution amount, and schedule. Every member
        contributes every round; the payout rotation follows the member list
        exactly as entered — the first address receives round 1&apos;s pot, the
        second round 2&apos;s, and so on. Addresses are not sorted. You are not
        added automatically: include your own address if you want to take part.
      </p>

      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-6"
        aria-describedby={submitDescribedBy}
        noValidate
      >

        {/* ── Error summary ────────────────────────────────────────────────────
            Rendered only for local input errors. Wallet/RPC failures use the
            separate submit-level region below and never appear here. */}
        {hasFieldErrors && (
          <div
            id={summaryId}
            ref={summaryRef}
            role="alert"
            tabIndex={-1}
            aria-labelledby={`${summaryId}-title`}
            className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            <p id={`${summaryId}-title`} className="font-semibold mb-1">
              Please fix {fieldErrorList.length} issue
              {fieldErrorList.length === 1 ? "" : "s"} before creating the circle:
            </p>
            <ul className="list-disc pl-5 space-y-0.5">
              {fieldErrorList.map((err) => (
                <li key={err.key}>
                  <button
                    type="button"
                    onClick={() => focusField(err.key)}
                    className="underline text-left hover:text-red-900"
                  >
                    {fieldLabel(err.key)}: {err.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Circle name ──────────────────────────────────────────────────── */}
        <div>
          <label
            htmlFor={nameId}
            className="block text-sm font-medium text-slate-700 mb-1"
          >
            Circle name <span aria-hidden="true" className="text-red-500">*</span>
          </label>
          <input
            id={nameId}
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH + 1} // +1 so user can see they've gone over
            placeholder="e.g. Family savings circle"
            className={`w-full border rounded-lg px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
              fieldErrors.name ? "border-red-400 focus:ring-red-400" : "border-slate-300"
            }`}
            aria-required="true"
            aria-invalid={fieldErrors.name ? "true" : undefined}
            aria-describedby={
              fieldErrors.name ? fieldErrorId(formId, "name") : undefined
            }
            autoComplete="off"
          />
          <FieldError
            id={fieldErrorId(formId, "name")}
            message={fieldErrors.name}
          />
          <p className="mt-1 text-xs text-slate-400">
            {name.trim().length}/{MAX_NAME_LENGTH} characters
          </p>
        </div>

        {/* ── Contribution amount + round duration ────────────────────────────
            Grouped on desktop (form-row → 2 columns ≥ sm), stacked on mobile. */}
        <div className="form-row">
          <div>
            <label
              htmlFor={amountId}
              className="block text-sm font-medium text-slate-700 mb-1"
            >
              Contribution per member / round (USDC){" "}
              <span aria-hidden="true" className="text-red-500">*</span>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-lg" aria-hidden="true">$</span>
              <input
                id={amountId}
                ref={amountRef}
                type="number"
                min={MIN_AMOUNT_USDC}
                step="0.0000001"
                value={roundUSDC}
                onChange={(e) => setRoundUSDC(e.target.value)}
                className={`flex-1 min-w-0 border rounded-lg px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                  fieldErrors.amount ? "border-red-400 focus:ring-red-400" : "border-slate-300"
                }`}
                aria-required="true"
                aria-invalid={fieldErrors.amount ? "true" : undefined}
                aria-describedby={[
                  amountHintId,
                  fieldErrors.amount ? fieldErrorId(formId, "amount") : null,
                ].filter(Boolean).join(" ")}
                aria-label="Contribution amount in USDC"
              />
              <span className="text-slate-500 text-sm shrink-0">USDC</span>
            </div>
            <p id={amountHintId} className="text-xs text-slate-400 mt-1">
              Pot per round = ${memberAmountDisplay} ×{" "}
              {filledCount > 0 ? filledCount : "…"} member
              {filledCount !== 1 ? "s" : ""} = ${potDisplay}
            </p>
            <FieldError
              id={fieldErrorId(formId, "amount")}
              message={fieldErrors.amount}
            />
          </div>

          <div>
            <label
              htmlFor={daysId}
              className="block text-sm font-medium text-slate-700 mb-1"
            >
              Round duration (days){" "}
              <span aria-hidden="true" className="text-red-500">*</span>
            </label>
            <input
              id={daysId}
              ref={daysRef}
              type="number"
              min="1"
              max={MAX_ROUND_DAYS}
              step="1"
              value={roundDays}
              onChange={(e) => setRoundDays(e.target.value)}
              className={`w-full border rounded-lg px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                fieldErrors.days ? "border-red-400 focus:ring-red-400" : "border-slate-300"
              }`}
              aria-required="true"
              aria-invalid={fieldErrors.days ? "true" : undefined}
              aria-describedby={
                fieldErrors.days ? fieldErrorId(formId, "days") : undefined
              }
              aria-label="Round duration in days"
            />
            <FieldError
              id={fieldErrorId(formId, "days")}
              message={fieldErrors.days}
            />
          </div>
        </div>

        {/* ── Members ───────────────────────────────────────────────────────── */}
        <fieldset>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
            <legend className="text-sm font-medium text-slate-700">
              Members (Stellar addresses){" "}
              <span aria-hidden="true" className="text-red-500">*</span>{" "}
              <span className="font-normal text-slate-500">— payout order top → bottom</span>
            </legend>
            {/* Counts filled, distinct addresses, not rows: a blank row is not a member. */}
            <span
              className={`text-xs font-medium ${
                memberSummary.status === "ok" ? "text-slate-500" : "text-amber-600"
              }`}
            >
              {filledCount} / {MAX_MEMBERS} members
            </span>
          </div>

          <ol
            className="space-y-2"
            aria-label="Member list — payout rotation order"
            aria-describedby={membersHintId}
          >
            {members.map((m, i) => {
              const fieldErr = fieldErrors.members?.[i];
              const inputId  = `member-${i}`;
              const errId    = fieldErrorId(formId, `member:${i}`);
              const atMin    = members.length <= MIN_MEMBERS;
              return (
                <li key={i} className="flex flex-col gap-0.5">
                  {/* On narrow viewports the row stacks so a 56-character Stellar
                      address stays fully legible instead of being clipped inside
                      a shrunken input. Address entry needs the user's full
                      attention, so the input stays wide and readable.        */}
                  <div className="flex gap-2 sm:flex-row flex-col items-start sm:items-center">
                    <span
                      className="text-xs text-slate-400 w-5 shrink-0 text-right select-none self-start sm:self-center"
                      aria-hidden="true"
                    >
                      {i + 1}.
                    </span>
                    <input
                      id={inputId}
                      ref={(el) => { memberRefs.current[i] = el; }}
                      type="text"
                      placeholder={`G… (member ${i + 1})`}
                      value={m}
                      onChange={(e) => updateMember(i, e.target.value)}
                      className={`w-full sm:flex-1 min-w-0 border rounded-lg px-3 py-2.5 text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                        fieldErr ? "border-red-400 focus:ring-red-400" : "border-slate-300"
                      }`}
                      aria-label={`Member ${i + 1} of ${members.length} — Stellar address (payout position ${i + 1})`}
                      aria-invalid={fieldErr ? "true" : undefined}
                      aria-describedby={fieldErr ? errId : undefined}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => !atMin && removeMember(i)}
                      aria-label={
                        atMin
                          ? `Cannot remove member ${i + 1} — circle needs at least ${MIN_MEMBERS} members`
                          : `Remove member ${i + 1}`
                      }
                      aria-disabled={atMin ? "true" : undefined}
                      className={`p-2 -m-1 text-lg leading-none shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors ${
                        atMin
                          ? "text-slate-200 cursor-not-allowed"
                          : "text-slate-400 hover:text-red-500"
                      }`}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>

                  {fieldErr && (
                    <p
                      id={errId}
                      role="alert"
                      className="mt-0.5 ml-7 text-xs text-red-600 flex items-center gap-1"
                    >
                      <span aria-hidden="true">⚠</span> {fieldErr}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>

          {/* List-level member error (count, duplicates) */}
          {fieldErrors.membersGeneral && (
            <p
              id={fieldErrorId(formId, "members")}
              role="alert"
              className="mt-2 text-xs text-red-600 flex items-center gap-1"
            >
              <span aria-hidden="true">⚠</span> {fieldErrors.membersGeneral}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={addMember}
              disabled={members.length >= MAX_MEMBERS}
              className="text-sm text-brand-600 hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline touch-target"
              aria-disabled={members.length >= MAX_MEMBERS}
            >
              + Add member
            </button>
            {members.length >= MAX_MEMBERS && (
              <span className="text-xs text-amber-600" role="status" aria-live="polite">
                Maximum of {MAX_MEMBERS} members reached.
              </span>
            )}
          </div>

          {/* Live count status, so the bounds are visible before the first submit. */}
          <p
            id={membersHintId}
            tabIndex={-1}
            className={`text-xs mt-1 focus:outline-none focus:ring-2 focus:ring-brand-500 rounded ${
              memberSummary.status === "ok" ? "text-slate-400" : "text-amber-700"
            }`}
            aria-live="polite"
            aria-atomic="true"
          >
            {memberSummary.status === "too_few"
              ? `Add ${MIN_MEMBERS - filledCount} more address${
                  MIN_MEMBERS - filledCount === 1 ? "" : "es"
                }. A circle needs ${MIN_MEMBERS} to ${MAX_MEMBERS} members.`
              : memberSummary.status === "too_many"
              ? `Remove ${filledCount - MAX_MEMBERS} address${
                  filledCount - MAX_MEMBERS === 1 ? "" : "es"
                }. A circle can have at most ${MAX_MEMBERS} members.`
              : `A circle needs ${MIN_MEMBERS} to ${MAX_MEMBERS} members. Empty rows are ignored.`}
          </p>
        </fieldset>

        {/* ── Summary card ──────────────────────────────────────────────────── */}
        <div
          className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-slate-700"
          aria-label="Circle summary"
        >
          <p className="font-semibold text-brand-800 mb-1">Circle summary</p>
          <ul className="space-y-0.5 text-slate-600" aria-live="polite" aria-atomic="true">
            {name.trim() && <li>📛 {name.trim()}</li>}
            <li>
              <span>
                👥 {filledCount} member{filledCount !== 1 ? "s" : ""}
                {memberSummary.status === "too_few" && ` (at least ${MIN_MEMBERS} needed)`}
              </span>
              {memberSummary.duplicateRows > 0 && (
                <span className="text-amber-700">
                  {` · ${memberSummary.duplicateRows} duplicate${memberSummary.duplicateRows !== 1 ? "s" : ""} not counted`}
                </span>
              )}
            </li>
            <li>💰 ${memberAmountDisplay} USDC / member / round</li>
            <li>🎯 Pot per round: ${potDisplay}</li>
            <li>📅 Round duration: {roundDays} days</li>
            <li>
              🔒 Collateral required: ${memberAmountDisplay} per member (1× round amount)
            </li>
          </ul>
        </div>

        {/* ── Submit-level error (wallet / RPC / contract) ─────────────────────
            Separate channel from field errors: these are never local input
            problems, so they are not listed in the error summary above. */}
        {submitError && (
          <div
            id={submitErrId}
            ref={submitErrorRef}
            role="alert"
            tabIndex={-1}
            className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            {submitError}
          </div>
        )}

        {/* ── Success ───────────────────────────────────────────────────────── */}
        {txHash && (
          <div
            id={successId}
            ref={successRef}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={-1}
            className="bg-brand-50 border border-brand-200 rounded-lg p-4 text-sm text-brand-700 space-y-3 focus:outline-none"
          >
            <p className="font-semibold text-brand-800 flex items-center gap-1.5 break-words">
              <span aria-hidden="true">{confirmed ? "✅" : "ℹ"}</span> {confirmed ? "Circle created successfully!" : "Transaction receipt — check status before another write"}
            </p>
            <a href="/transactions" className="underline break-words">Reopen transaction status</a>
            <div>
              <p
                className="text-xs text-brand-600 mb-1 font-medium"
                id={`${successId}-hash-label`}
              >
                Transaction hash
              </p>
              <CopyControl
                value={txHash}
                label="Transaction hash"
                labelledBy={`${successId}-hash-label`}
                className="bg-white border border-brand-200 rounded-lg px-3 py-2"
              />
            </div>
            {explorerTxUrl && (
              <a
                href={explorerTxUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 underline hover:text-brand-900 break-all"
              >
                View on Stellar Expert ↗
              </a>
            )}
            {/* Explicit navigation actions — the user stays in control. */}
            <div className="flex flex-wrap items-center gap-2">
              {confirmed && circleAddress && (
                <button
                  type="button"
                  onClick={() => {
                    clearRedirectTimer();
                    router.push(`/circles/${circleAddress}`);
                  }}
                  className="inline-flex items-center justify-center bg-brand-600 text-white text-xs font-semibold px-3 py-2 rounded-lg hover:bg-brand-700 min-h-[44px]"
                >
                  View circle
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  clearRedirectTimer();
                  setStayOnReceipt(true);
                }}
                className="inline-flex items-center justify-center border border-brand-300 text-brand-700 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-brand-100 min-h-[44px]"
              >
                Stay on receipt
              </button>
            </div>
            <p className="text-xs text-slate-500 break-words" aria-live="polite" aria-atomic="true">
              {confirmed && circleAddress && !stayOnReceipt
                ? "Redirecting to your new circle in a few seconds…"
                : confirmed && circleAddress
                ? "You chose to stay on this receipt. Use View circle when ready."
                : confirmed
                ? "Circle created. The circle address was not returned, so no detail link is available — keep this transaction hash."
                : "Confirmation was not established. Open Recent transactions to check this hash."}
            </p>
          </div>
        )}

        {submitError && <DiagnosticsPanel operation="create_circle" typedError={supportError ?? parseContractError(submitError)} txHash={txHash} />}

        {/* Pending state announcement */}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {loading
            ? "Creating circle, please wait and approve the transaction in Freighter."
            : ""}
        </p>

        <button
          type="submit"
          disabled={submitBlocked}
          aria-busy={loading}
          aria-describedby={submitDescribedBy}
          className="w-full bg-brand-600 text-white py-3 rounded-xl font-semibold hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg min-h-[48px] break-words"
        >
          {loading ? "Creating circle…" : "Create Circle"}
        </button>
      </form>
    </div>
  );
}