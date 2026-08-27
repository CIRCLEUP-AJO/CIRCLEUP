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
import { getWalletAddress, invokeContract, WalletError } from "@/lib/stellar";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/** Minimum and maximum number of members allowed by the contract. */
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 20;

function getFilledMembers(members: string[]): string[] {
  return members.map((m) => m.trim()).filter((m) => m.length > 0);
}

function findDuplicateAddress(addresses: string[]): string | null {
  const seen = new Set<string>();
  for (const addr of addresses) {
    if (seen.has(addr)) return addr;
    seen.add(addr);
  }
  return null;
}

/** Validates that a string is a Stellar public key (G... with 56 base32 chars). */
function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}

export default function CreateClient() {
  const router = useRouter();
  const [members, setMembers] = useState<string[]>(["", "", "", ""]);
  const [roundUSDC, setRoundUSDC] = useState("100");
  const [roundDays, setRoundDays] = useState("30");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState("");
  const [copied, setCopied] = useState(false);

  // Stable IDs for aria-describedby associations
  const errorId = useId();
  const successId = useId();
  const amountHintId = useId();
  const membersHintId = useId();

  // Focus management: move focus to the error region when a submission error appears
  const errorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.focus();
    }
  }, [error]);

  useEffect(() => {
    if (txHash && successRef.current) {
      successRef.current.focus();
    }
  }, [txHash]);

  // ── Derived summary values ───────────────────────────────────────────────────

  const filledCount = getFilledMembers(members).length;
  const roundAmountNum = parseFloat(roundUSDC || "0");
  const potPerRound = Number.isFinite(roundAmountNum)
    ? roundAmountNum * filledCount
    : 0;

  // ── Member mutation helpers ──────────────────────────────────────────────────

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
  }

  async function copyTxHash() {
    if (!txHash) return;
    try {
      await navigator.clipboard.writeText(txHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — silently skip
    }
  }

  // ── Submit ───────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setTxHash("");
    setCopied(false);

    let walletAddress: string | null;
    try {
      walletAddress = await getWalletAddress();
    } catch (err) {
      if (err instanceof WalletError && err.reason === "not_installed") {
        setError(
          "Freighter wallet extension is not installed. Visit https://freighter.app to install it.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Failed to access wallet.");
      }
      return;
    }
    if (!walletAddress) {
      setError("Connect your Freighter wallet first.");
      return;
    }

    const validMembers = getFilledMembers(members);
    if (validMembers.length < MIN_MEMBERS) {
      setError(`A circle needs at least ${MIN_MEMBERS} members.`);
      return;
    }
    if (validMembers.length > MAX_MEMBERS) {
      setError(`A circle cannot have more than ${MAX_MEMBERS} members.`);
      return;
    }

    const duplicate = findDuplicateAddress(validMembers);
    if (duplicate) {
      setError(
        `Duplicate address detected: ${shortAddress(duplicate)}. Each member must be unique.`,
      );
      return;
    }

    const invalidAddr = validMembers.find((m) => !isValidStellarAddress(m));
    if (invalidAddr) {
      setError(
        `Invalid Stellar address: "${shortAddress(invalidAddr)}". Each address must start with G and be 56 characters long.`,
      );
      return;
    }

    const amount = parseFloat(roundUSDC);
    if (isNaN(amount) || amount <= 0) {
      setError("Enter a valid round amount.");
      return;
    }

    const days = parseInt(roundDays, 10);
    if (isNaN(days) || days < 1) {
      setError("Enter a valid round duration.");
      return;
    }

    if (!CIRCLE_FACTORY_ADDRESS) {
      setError("Factory contract not configured. Deploy contracts first.");
      return;
    }

    setLoading(true);
    try {
      const membersVal = xdr.ScVal.scvVec(
        validMembers.map((m) => new Address(m).toScVal()),
      );

      const result = await invokeContract(
        CIRCLE_FACTORY_ADDRESS,
        "create_circle",
        [
          new Address(walletAddress).toScVal(),
          membersVal,
          nativeToScVal(usdcToStroops(amount), { type: "i128" }),
          nativeToScVal(daysToLedgers(days), { type: "u32" }),
        ],
        walletAddress,
      );

      if (!result.success) {
        setError(result.error || "Transaction failed");
        return;
      }

      setTxHash(result.txHash);
      setTimeout(() => router.push("/"), 5000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const explorerTxUrl = txHash ? getExplorerLink(ACTIVE_NETWORK, "tx", txHash) : null;

  // Determine which aria-describedby tokens apply to the submit button
  const submitDescribedBy = [
    error ? errorId : null,
    txHash ? successId : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <div className="max-w-xl mx-auto px-2 sm:px-0">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Create a Circle</h1>
      <p className="text-slate-500 text-sm mb-8">
        Set up the members, contribution amount, and schedule. The rotation order
        is the same as the member list.
      </p>

      {/*
        Live region: always present in the DOM from first render so screen
        readers register it before content changes.  Errors use role="alert"
        (assertive) so they interrupt immediately; the success panel uses
        aria-live="polite" so it doesn't cut off ongoing announcements.
      */}

      <form
        onSubmit={handleSubmit}
        className="space-y-6"
        aria-describedby={submitDescribedBy}
        noValidate
      >
        {/* Round amount */}
        <div>
          <label
            htmlFor="round-usdc"
            className="block text-sm font-medium text-slate-700 mb-1"
          >
            Contribution per member / round (USDC)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-lg" aria-hidden="true">$</span>
            <input
              id="round-usdc"
              type="number"
              min="1"
              step="1"
              value={roundUSDC}
              onChange={(e) => setRoundUSDC(e.target.value)}
              className="flex-1 min-w-0 border border-slate-300 rounded-lg px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
              required
              aria-describedby={amountHintId}
              aria-label="Contribution amount in USDC"
            />
            <span className="text-slate-500 text-sm shrink-0">USDC</span>
          </div>
          <p id={amountHintId} className="text-xs text-slate-400 mt-1">
            The full pot per round = ${roundUSDC || 0} ×{" "}
            {filledCount > 0 ? filledCount : "…"} members
          </p>
        </div>

        {/* Round duration */}
        <div>
          <label
            htmlFor="round-days"
            className="block text-sm font-medium text-slate-700 mb-1"
          >
            Round duration (days)
          </label>
          <input
            id="round-days"
            type="number"
            min="1"
            value={roundDays}
            onChange={(e) => setRoundDays(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
            required
            aria-label="Round duration in days"
          />
        </div>

        {/* Members */}
        <fieldset>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
            <legend className="text-sm font-medium text-slate-700">
              Members (Stellar addresses) — payout order top → bottom
            </legend>
            <span
              className={`text-xs font-medium ${
                members.length >= MAX_MEMBERS
                  ? "text-amber-600"
                  : "text-slate-400"
              }`}
              aria-live="polite"
              aria-atomic="true"
            >
              {members.length} / {MAX_MEMBERS}
            </span>
          </div>
          <div className="space-y-2" aria-describedby={membersHintId}>
            {members.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-slate-400 w-5 shrink-0 text-right" aria-hidden="true">
                  {i + 1}.
                </span>
                <input
                  id={`member-${i}`}
                  type="text"
                  placeholder={`G… (member ${i + 1})`}
                  value={m}
                  onChange={(e) => updateMember(i, e.target.value)}
                  className="flex-1 min-w-0 border border-slate-300 rounded-lg px-3 py-2.5 text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  aria-label={`Member ${i + 1} Stellar address`}
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
            ))}
          </div>
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
              <span
                className="text-xs text-amber-600"
                role="status"
                aria-live="polite"
              >
                Maximum of {MAX_MEMBERS} members reached.
              </span>
            )}
          </div>
          <p id={membersHintId} className="text-xs text-slate-400 mt-1">
            Minimum {MIN_MEMBERS} members · maximum {MAX_MEMBERS} members.
          </p>
        </fieldset>

        {/* Summary card */}
        <div
          className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-slate-700"
          aria-label="Circle summary"
        >
          <p className="font-semibold text-brand-800 mb-1">Circle summary</p>
          <ul className="space-y-0.5 text-slate-600" aria-live="polite" aria-atomic="true">
            <li>👥 {filledCount} member{filledCount !== 1 ? "s" : ""}</li>
            <li>💰 ${roundUSDC} USDC / member / round</li>
            <li>🎯 Pot per round: ${potPerRound.toFixed(0)}</li>
            <li>📅 Round duration: {roundDays} days</li>
            <li>🔒 Collateral required: ${roundUSDC} per member (1× round amount)</li>
          </ul>
        </div>

        {/*
          Error region — role="alert" for immediate announcement.
          tabIndex={-1} allows programmatic focus via errorRef.current.focus()
          so keyboard users are moved to the message after submission failure.
        */}
        {error && (
          <div
            id={errorId}
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            {error}
          </div>
        )}

        {/*
          Success region — aria-live="polite" so it announces once without
          interrupting.  tabIndex={-1} allows programmatic focus after the
          action completes so keyboard users land on the confirmation.
        */}
        {txHash && (
          <div
            id={successId}
            ref={successRef}
            className="bg-brand-50 border border-brand-200 rounded-lg p-4 text-sm text-brand-700 space-y-3 focus:outline-none"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={-1}
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

        {/*
          Pending state announcement — always in the DOM so the live region is
          registered before the state changes.  When loading=true, the message
          is set; otherwise it is an empty string so nothing is announced.
        */}
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {loading ? "Creating circle, please wait and approve the transaction in Freighter." : ""}
        </p>

        <button
          type="submit"
          disabled={loading || !!txHash}
          aria-busy={loading}
          aria-describedby={submitDescribedBy}
          className="w-full bg-brand-600 text-white py-3 rounded-xl font-semibold hover:bg-brand-700 transition-colors disabled:opacity-50 text-lg min-h-[48px]"
        >
          {loading ? "Creating circle…" : "Create Circle"}
        </button>
      </form>
    </div>
  );
}
