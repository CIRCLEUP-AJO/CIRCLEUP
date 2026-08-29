"use client";
import { useState, useId, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  CIRCLE_FACTORY_ADDRESS,
  usdcToStroops,
  shortAddress,
  daysToLedgers,
  getExplorerLink,
  ACTIVE_NETWORK,
} from "@/lib/config";
import { isStellarPublicKey } from "@/lib/address";
import { getWalletAddress, invokeContract, WalletError } from "@/lib/stellar";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum and maximum number of members allowed by the contract. */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 20;

/** Minimum contribution per round — 1 stroop = $0.0000001 USDC. */
export const MIN_AMOUNT_USDC = 0.0000001;

/** Maximum USDC decimal places supported by the Stellar USDC token (7 dp). */
export const MAX_USDC_DECIMALS = 7;

/** Maximum round duration in days (≈10 years in ledgers stays within u32). */
export const MAX_ROUND_DAYS = 3650;

/** Maximum characters in a circle name. */
export const MAX_NAME_LENGTH = 64;

// ─── Validation types ─────────────────────────────────────────────────────────

/**
 * Per-field error map returned by {@link validateCreateForm}.
 * A field is error-free when its key is absent or the value is `undefined`.
 */
export interface CreateFormErrors {
  name?: string;
  amount?: string;
  days?: string;
  /** Index-keyed member errors: errors[i] is the error for members[i]. */
  members?: (string | undefined)[];
  /** Cross-field or list-level member errors (duplicate, count). */
  membersGeneral?: string;
}

/**
 * Validated, normalised form values ready for contract submission.
 * Only produced when {@link validateCreateForm} returns no errors.
 */
export interface ValidatedCreateForm {
  name: string;
  validMembers: string[];
  amountStroops: bigint;
  roundDays: number;
}

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

/** Return trimmed non-empty member strings in order. */
export function getFilledMembers(members: string[]): string[] {
  return members.map((m) => m.trim()).filter((m) => m.length > 0);
}

/** Return the first duplicate address, or null if all are unique. */
export function findDuplicateAddress(addresses: string[]): string | null {
  const seen = new Set<string>();
  for (const addr of addresses) {
    if (seen.has(addr)) return addr;
    seen.add(addr);
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
 * Validate and normalise all create-circle form fields.
 *
 * Returns either:
 *   `{ ok: true,  values: ValidatedCreateForm }`  — safe to submit
 *   `{ ok: false, errors: CreateFormErrors }`      — show errors, do not submit
 *
 * This is the single authoritative gate that `handleSubmit` calls. The function
 * is pure (no I/O, no side effects) so it can be tested exhaustively without a
 * browser environment.
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
    } else if (countDecimalPlaces(amountStr) > MAX_USDC_DECIMALS) {
      errors.amount = `USDC supports at most ${MAX_USDC_DECIMALS} decimal places. ` +
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
  const memberErrors: (string | undefined)[] = members.map((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined; // blank rows are ignored
    if (!isStellarPublicKey(trimmed)) {
      return `Member ${i + 1}: must be a G-prefixed 56-character Stellar address.`;
    }
    return undefined;
  });

  const hasPerMemberErrors = memberErrors.some((e) => e !== undefined);
  if (hasPerMemberErrors) {
    errors.members = memberErrors;
  }

  // ── Members — list-level ──────────────────────────────────────────────────
  const validMembers = getFilledMembers(members);

  if (validMembers.length < MIN_MEMBERS) {
    errors.membersGeneral =
      `At least ${MIN_MEMBERS} members are required. ` +
      `${validMembers.length === 0 ? "Add member addresses below." : `You have ${validMembers.length}.`}`;
  } else if (validMembers.length > MAX_MEMBERS) {
    errors.membersGeneral = `A circle cannot have more than ${MAX_MEMBERS} members.`;
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
  const router = useRouter();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [name,      setName]      = useState("");
  const [members,   setMembers]   = useState<string[]>(["", "", "", ""]);
  const [roundUSDC, setRoundUSDC] = useState("100");
  const [roundDays, setRoundDays] = useState("30");

  // ── Submission state ───────────────────────────────────────────────────────
  const [loading,      setLoading]      = useState(false);
  const [submitError,  setSubmitError]  = useState("");
  const [fieldErrors,  setFieldErrors]  = useState<CreateFormErrors>({});
  const [txHash,       setTxHash]       = useState("");
  const [copied,       setCopied]       = useState(false);
  const [validated,    setValidated]    = useState(false);

  // ── Timeout reconciliation state ───────────────────────────────────────────
  //
  // When invokeContract times out, the tx was already broadcast to the network
  // and may still confirm. We preserve the hash so the user can check the
  // explorer rather than blindly resubmitting and creating a duplicate circle.
  //
  // timedOutTxHash — the broadcast hash from a timed-out submission.
  // isTimedOut     — true when the last attempt ended in NETWORK_TIMEOUT with
  //                  a hash we can offer for reconciliation.
  const [timedOutTxHash, setTimedOutTxHash] = useState<string>("");
  const [isTimedOut,     setIsTimedOut]     = useState(false);

  // ── In-flight guard ────────────────────────────────────────────────────────
  //
  // A useRef is used as a synchronous lock in addition to the `loading` state.
  // React batches state updates, so `setLoading(true)` is not visible to the
  // next event handler invocation until after the current render — meaning two
  // rapid clicks can both enter handleSubmit before loading flips to true.
  // The ref is read and written synchronously on the same JS tick, so it
  // reliably blocks concurrent submissions.
  const submittingRef = useRef(false);

  // ── Stable IDs ─────────────────────────────────────────────────────────────
  const formId        = useId();
  const nameId        = useId();
  const amountId      = useId();
  const amountHintId  = useId();
  const daysId        = useId();
  const membersHintId = useId();
  const submitErrId   = useId();
  const successId     = useId();
  const timeoutId     = useId();

  // ── Focus management ────────────────────────────────────────────────────────
  const submitErrorRef = useRef<HTMLDivElement>(null);
  const successRef     = useRef<HTMLDivElement>(null);
  const timeoutRef     = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (isTimedOut && timeoutRef.current) timeoutRef.current.focus();
  }, [isTimedOut]);

  // ── Derived values ──────────────────────────────────────────────────────────
  const filledCount    = getFilledMembers(members).length;
  const roundAmountNum = parseFloat(roundUSDC || "0");
  const potPerRound    = Number.isFinite(roundAmountNum) ? roundAmountNum * filledCount : 0;

  // Live-validate after first submit attempt so errors update as user types
  useEffect(() => {
    if (!validated) return;
    const result = validateCreateForm(name, members, roundUSDC, roundDays);
    setFieldErrors(result.ok ? {} : result.errors);
  }, [validated, name, members, roundUSDC, roundDays]);

  // ── Member helpers ──────────────────────────────────────────────────────────
  function updateMember(i: number, val: string) {
    setMembers((prev) => {
      const next = [...prev];
      next[i] = val;
      return next;
    });
  }

  function addMember() {
    if (members.length >= MAX_MEMBERS) return;
    setMembers((prev) => [...prev, ""]);
  }

  function removeMember(i: number) {
    if (members.length <= MIN_MEMBERS) return;
    setMembers((prev) => prev.filter((_, idx) => idx !== i));
    // Shrink the refs array to stay in sync
    memberRefs.current = memberRefs.current.filter((_, idx) => idx !== i);
  }

  // ── Copy helper ─────────────────────────────────────────────────────────────
  async function copyTxHash() {
    const hash = txHash || timedOutTxHash;
    if (!hash) return;
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — silently skip
    }
  }

  // ── Focus first error ────────────────────────────────────────────────────────
  function focusFirstError(errors: CreateFormErrors) {
    if (errors.name) { nameRef.current?.focus(); return; }
    if (errors.amount) { amountRef.current?.focus(); return; }
    if (errors.days) { daysRef.current?.focus(); return; }
    if (errors.members) {
      const firstIdx = errors.members.findIndex((e) => e !== undefined);
      if (firstIdx !== -1) { memberRefs.current[firstIdx]?.focus(); return; }
    }
    // membersGeneral — focus the first empty member slot if it exists
    const firstEmpty = members.findIndex((m) => m.trim() === "");
    if (firstEmpty !== -1) { memberRefs.current[firstEmpty]?.focus(); }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // ── Synchronous in-flight guard ───────────────────────────────────────────
    if (submittingRef.current) return;
    submittingRef.current = true;

    // ── Reset submission state ────────────────────────────────────────────────
    setSubmitError("");
    setTxHash("");
    setCopied(false);
    setTimedOutTxHash("");
    setIsTimedOut(false);
    setValidated(true);

    // Track whether this attempt ended in a timeout needing reconciliation.
    let pendingTimeout = false;

    try {
      // ── Step 1: pre-flight field validation ────────────────────────────────
      const validation = validateCreateForm(name, members, roundUSDC, roundDays);
      if (!validation.ok) {
        setFieldErrors(validation.errors);
        focusFirstError(validation.errors);
        return;
      }
      setFieldErrors({});

      const { name: circleName, validMembers, amountStroops, roundDays: days } = validation.values;

      // ── Step 2: wallet check ────────────────────────────────────────────────
      let walletAddress: string | null;
      try {
        walletAddress = await getWalletAddress();
      } catch (err) {
        if (err instanceof WalletError && err.reason === "not_installed") {
          setSubmitError(
            "Freighter wallet extension is not installed. Visit https://freighter.app to install it.",
          );
        } else {
          setSubmitError(err instanceof Error ? err.message : "Failed to access wallet.");
        }
        return;
      }
      if (!walletAddress) {
        setSubmitError("Connect your Freighter wallet first.");
        return;
      }

      // ── Step 3: factory address guard ──────────────────────────────────────
      if (!CIRCLE_FACTORY_ADDRESS) {
        setSubmitError("Factory contract not configured. Deploy contracts first.");
        return;
      }

      // ── Step 4: submit ──────────────────────────────────────────────────────
      setLoading(true);
      try {
        const membersVec = xdr.ScVal.scvVec(
          validMembers.map((m) => new Address(m).toScVal()),
        );

        const result = await invokeContract(
          CIRCLE_FACTORY_ADDRESS,
          "create_circle",
          [
            new Address(walletAddress).toScVal(),
            nativeToScVal(circleName, { type: "string" }),
            membersVec,
            nativeToScVal(amountStroops, { type: "i128" }),
            nativeToScVal(daysToLedgers(days), { type: "u32" }),
          ],
          walletAddress,
        );

        if (result.success) {
          // Navigate only on confirmed success — never on timeout or failure.
          setTxHash(result.txHash ?? "");
          setTimeout(() => router.push("/"), 5000);
          return;
        }

        const errorCode = result.typedError?.code;

        if (errorCode === "NETWORK_TIMEOUT" && result.txHash) {
          // Transaction broadcast but confirmation timed out. The tx may still
          // confirm — preserve the hash for reconciliation and hold the lock.
          pendingTimeout = true;
          setTimedOutTxHash(result.txHash);
          setIsTimedOut(true);
          return;
        }

        if (errorCode === "WALLET_REJECTED" || result.typedError?.kind === "wallet") {
          setSubmitError(
            result.typedError?.message ||
            "Transaction cancelled. You can try again when ready.",
          );
          return;
        }

        setSubmitError(
          result.typedError?.message || result.error || "Transaction failed.",
        );
      } finally {
        setLoading(false);
      }
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      // Release the lock on every path except confirmed timeout, where the user
      // must explicitly acknowledge via resetAfterTimeout() before retrying.
      if (!pendingTimeout) {
        submittingRef.current = false;
      }
    }
  }

  // ── Timeout reset ───────────────────────────────────────────────────────────
  function resetAfterTimeout() {
    setTimedOutTxHash("");
    setIsTimedOut(false);
    setSubmitError("");
    submittingRef.current = false;
  }

  const timedOutExplorerUrl = timedOutTxHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", timedOutTxHash)
    : null;

  const explorerTxUrl = txHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", txHash)
    : null;

  const submitBlocked = loading || !!txHash || isTimedOut;

  const submitDescribedBy = [
    submitError ? submitErrId : null,
    txHash      ? successId   : null,
    isTimedOut  ? timeoutId   : null,
  ].filter(Boolean).join(" ") || undefined;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto px-2 sm:px-0">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Create a Circle</h1>
      <p className="text-slate-500 text-sm mb-8">
        Set up the members, contribution amount, and schedule. The rotation order
        is the same as the member list.
      </p>

      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-6"
        aria-describedby={submitDescribedBy}
        noValidate
      >

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
            aria-describedby={fieldErrors.name ? `${nameId}-err` : undefined}
            autoComplete="off"
          />
          <FieldError id={`${nameId}-err`} message={fieldErrors.name} />
          <p className="mt-1 text-xs text-slate-400">
            {name.trim().length}/{MAX_NAME_LENGTH} characters
          </p>
        </div>

        {/* ── Contribution amount ───────────────────────────────────────────── */}
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
                fieldErrors.amount ? `${amountId}-err` : null,
              ].filter(Boolean).join(" ")}
              aria-label="Contribution amount in USDC"
            />
            <span className="text-slate-500 text-sm shrink-0">USDC</span>
          </div>
          <p id={amountHintId} className="text-xs text-slate-400 mt-1">
            Pot per round = ${roundUSDC || "0"} ×{" "}
            {filledCount > 0 ? filledCount : "…"} members = ${potPerRound.toFixed(7).replace(/\.?0+$/, "") || "0"}
          </p>
          <FieldError id={`${amountId}-err`} message={fieldErrors.amount} />
        </div>

        {/* ── Round duration ────────────────────────────────────────────────── */}
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
            aria-describedby={fieldErrors.days ? `${daysId}-err` : undefined}
            aria-label="Round duration in days"
          />
          <FieldError id={`${daysId}-err`} message={fieldErrors.days} />
        </div>

        {/* ── Members ───────────────────────────────────────────────────────── */}
        <fieldset>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
            <legend className="text-sm font-medium text-slate-700">
              Members (Stellar addresses){" "}
              <span aria-hidden="true" className="text-red-500">*</span>{" "}
              <span className="font-normal text-slate-500">— payout order top → bottom</span>
            </legend>
            <span
              className={`text-xs font-medium ${
                members.length >= MAX_MEMBERS ? "text-amber-600" : "text-slate-400"
              }`}
              aria-live="polite"
              aria-atomic="true"
            >
              {members.length} / {MAX_MEMBERS}
            </span>
          </div>

          <div className="space-y-2" aria-describedby={membersHintId}>
            {members.map((m, i) => {
              const fieldErr = fieldErrors.members?.[i];
              const inputId  = `member-${i}`;
              const errId    = `member-${i}-err`;
              return (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs text-slate-400 w-5 shrink-0 text-right"
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
                      className={`flex-1 min-w-0 border rounded-lg px-3 py-2.5 text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                        fieldErr ? "border-red-400 focus:ring-red-400" : "border-slate-300"
                      }`}
                      aria-label={`Member ${i + 1} Stellar address`}
                      aria-invalid={fieldErr ? "true" : undefined}
                      aria-describedby={fieldErr ? errId : undefined}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {members.length > MIN_MEMBERS && (
                      <button
                        type="button"
                        onClick={() => removeMember(i)}
                        className="p-2 -m-1 text-slate-400 hover:text-red-500 text-lg leading-none shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center"
                        aria-label={`Remove member ${i + 1}`}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    )}
                  </div>
                  {fieldErr && (
                    <p
                      id={errId}
                      role="alert"
                      className="mt-1 ml-7 text-xs text-red-600 flex items-center gap-1"
                    >
                      <span aria-hidden="true">⚠</span> {fieldErr}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* List-level member error (count, duplicates) */}
          {fieldErrors.membersGeneral && (
            <p
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
              className="text-sm text-brand-600 hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
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
          <p id={membersHintId} className="text-xs text-slate-400 mt-1">
            Minimum {MIN_MEMBERS} · maximum {MAX_MEMBERS} members. At least {MIN_MEMBERS} addresses required.
          </p>
        </fieldset>

        {/* ── Summary card ──────────────────────────────────────────────────── */}
        <div
          className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-slate-700"
          aria-label="Circle summary"
        >
          <p className="font-semibold text-brand-800 mb-1">Circle summary</p>
          <ul className="space-y-0.5 text-slate-600" aria-live="polite" aria-atomic="true">
            {name.trim() && (
              <li>📛 {name.trim()}</li>
            )}
            <li>👥 {filledCount} member{filledCount !== 1 ? "s" : ""}</li>
            <li>💰 ${roundUSDC} USDC / member / round</li>
            <li>🎯 Pot per round: ${potPerRound.toFixed(7).replace(/\.?0+$/, "") || "0"}</li>
            <li>📅 Round duration: {roundDays} days</li>
            <li>🔒 Collateral required: ${roundUSDC} per member (1× round amount)</li>
          </ul>
        </div>

        {/* ── Timeout reconciliation panel ──────────────────────────────────── */}
        {isTimedOut && timedOutTxHash && (
          <div
            id={timeoutId}
            ref={timeoutRef}
            role="alert"
            tabIndex={-1}
            className="bg-amber-50 border border-amber-300 rounded-lg p-4 text-sm text-amber-800 space-y-3 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            <p className="font-semibold flex items-center gap-1.5">
              <span aria-hidden="true">⏱️</span> Transaction submitted — confirmation timed out
            </p>
            <p className="text-amber-700">
              Your transaction was sent to the network but we stopped waiting for
              confirmation after the timeout window. It may still confirm — check
              the explorer before retrying to avoid creating a duplicate circle.
            </p>
            <div>
              <p className="text-xs font-medium text-amber-700 mb-1">Transaction hash</p>
              <div className="flex items-center gap-2 bg-white border border-amber-200 rounded-lg px-3 py-2">
                <span className="font-mono text-xs text-slate-700 flex-1 break-all select-all min-w-0">
                  {timedOutTxHash}
                </span>
                <button
                  type="button"
                  onClick={copyTxHash}
                  className="text-amber-700 hover:text-amber-900 text-xs font-medium shrink-0 min-h-[44px] px-2"
                  aria-label={copied ? "Transaction hash copied" : "Copy transaction hash"}
                  aria-pressed={copied}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>
            {timedOutExplorerUrl && (
              <a
                href={timedOutExplorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 underline hover:text-amber-900"
              >
                Check on Stellar Expert ↗
              </a>
            )}
            <div className="border-t border-amber-200 pt-3 space-y-2">
              <p className="text-xs text-amber-700 font-medium">What would you like to do?</p>
              <div className="flex flex-wrap gap-2">
                {timedOutExplorerUrl && (
                  <a
                    href={timedOutExplorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-2 text-xs font-medium rounded-lg border border-amber-400 text-amber-800 hover:bg-amber-100 transition-colors"
                  >
                    Check explorer first ↗
                  </a>
                )}
                <button
                  type="button"
                  onClick={resetAfterTimeout}
                  className="px-3 py-2 text-xs font-medium rounded-lg border border-amber-400 text-amber-800 hover:bg-amber-100 transition-colors"
                >
                  I&apos;ve checked — it did not confirm, let me retry
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Submit-level error ────────────────────────────────────────────── */}
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
            <p className="font-semibold text-brand-800 flex items-center gap-1.5">
              <span aria-hidden="true">✅</span> Circle created successfully!
            </p>
            <div>
              <p className="text-xs text-brand-600 mb-1 font-medium" id={`${successId}-hash-label`}>
                Transaction hash
              </p>
              <div className="flex items-center gap-2 bg-white border border-brand-200 rounded-lg px-3 py-2">
                <span
                  className="font-mono text-xs text-slate-700 flex-1 break-all select-all min-w-0"
                  aria-labelledby={`${successId}-hash-label`}
                >
                  {txHash}
                </span>
                <button
                  type="button"
                  onClick={copyTxHash}
                  className="text-brand-600 hover:text-brand-800 text-xs font-medium shrink-0 min-h-[44px] px-2"
                  aria-label={copied ? "Transaction hash copied" : "Copy transaction hash"}
                  aria-pressed={copied}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>
            {explorerTxUrl && (
              <a
                href={explorerTxUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 underline hover:text-brand-900"
              >
                View on Stellar Expert ↗
              </a>
            )}
            <p className="text-xs text-slate-500">
              Redirecting to circles list in a few seconds…
            </p>
          </div>
        )}

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
          className="w-full bg-brand-600 text-white py-3 rounded-xl font-semibold hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg min-h-[48px]"
        >
          {loading ? "Creating circle…" : "Create Circle"}
        </button>

        {isTimedOut && (
          <p className="text-xs text-center text-amber-700" role="status">
            Submit is locked until you have checked the explorer and confirmed the original transaction did not go through.
          </p>
        )}
      </form>
    </div>
  );
}
