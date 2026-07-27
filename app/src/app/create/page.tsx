import type { Metadata } from "next";
import CreateClient from "./CreateClient";

export const metadata: Metadata = {
  title: "Create a Circle — CircleUp",
  description:
    "Set up a trustless savings circle on Stellar. Choose members, contribution amount, and round duration. The smart contract holds all funds.",
};

// ── Per-field validation errors ───────────────────────────────────────────────
//
// Keyed by field name so each input can show its own inline error below it
// rather than only surfacing problems in the top-level alert banner.
interface FieldErrors {
  roundUSDC?: string;
  roundDays?: string;
  /** member index → error message */
  members?: Record<number, string>;
}

export default function CreatePage() {
  const router = useRouter();
  const [members, setMembers] = useState<string[]>(["", "", "", ""]);
  const [roundUSDC, setRoundUSDC] = useState("100");
  const [roundDays, setRoundDays] = useState("30");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [txHash, setTxHash] = useState("");
  const [copied, setCopied] = useState(false);

  // ── Derived summary values ───────────────────────────────────────────────────
  //
  // Both the round-amount hint and the summary card derive from the same
  // filledCount so they are always consistent. Previously the hint used
  // members.length (counting blank rows) while the summary card used
  // members.filter(m=>m.trim()).length (correct) — now both use filledCount.

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
    setFieldErrors({});
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

    // ── Per-field validation ─────────────────────────────────────────────────
    // Collect all field-level errors before bailing out so the user sees every
    // problem at once instead of fixing one at a time.
    const nextFieldErrors: FieldErrors = {};
    let hasFieldError = false;

    const amount = parseFloat(roundUSDC);
    if (isNaN(amount) || amount <= 0) {
      nextFieldErrors.roundUSDC = "Enter a positive round amount.";
      hasFieldError = true;
    }

    const days = parseInt(roundDays, 10);
    if (isNaN(days) || days < 1) {
      nextFieldErrors.roundDays = "Enter a round duration of at least 1 day.";
      hasFieldError = true;
    }

    // Per-member address validation
    const memberErrors: Record<number, string> = {};
    members.forEach((m, i) => {
      const trimmed = m.trim();
      if (trimmed === "") return; // blank rows are filtered out later
      if (!isValidStellarAddress(trimmed)) {
        memberErrors[i] = "Must start with G and be exactly 56 characters.";
        hasFieldError = true;
      }
    });
    if (Object.keys(memberErrors).length > 0) {
      nextFieldErrors.members = memberErrors;
    }

    if (hasFieldError) {
      setFieldErrors(nextFieldErrors);
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

    // Duplicate-address check — the contract will reject duplicates on-chain,
    // but surfacing it here gives the user a clear, actionable message instead
    // of a cryptic contract error.
    const duplicate = findDuplicateAddress(validMembers);
    if (duplicate) {
      setError(
        `Duplicate address detected: ${shortAddress(duplicate)}. Each member must be unique.`,
      );
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
          nativeToScVal(DAYS_TO_LEDGERS(days), { type: "u32" }),
        ],
        walletAddress,
      );

      if (!result.success) {
        setError(result.error || "Transaction failed");
        return;
      }

      // Show the transaction hash before redirecting so the user can save it
      setTxHash(result.txHash);
      // Give the user 5 seconds to see and copy the hash before redirecting
      setTimeout(() => router.push("/"), 5000);
    } catch (err: unknown) {
      // err typed as unknown — extract message safely instead of casting to any
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Create a Circle</h1>
      <p className="text-slate-500 text-sm mb-8">
        Set up the members, contribution amount, and schedule. The rotation order
        is the same as the member list.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
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
              onChange={(e) => {
                setRoundUSDC(e.target.value);
                if (fieldErrors.roundUSDC) setFieldErrors((prev) => ({ ...prev, roundUSDC: undefined }));
              }}
              className={`flex-1 border rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${fieldErrors.roundUSDC ? "border-red-400" : "border-slate-300"}`}
              aria-describedby={fieldErrors.roundUSDC ? "round-usdc-error" : "round-usdc-hint"}
              aria-invalid={fieldErrors.roundUSDC ? "true" : "false"}
              required
            />
            <span className="text-slate-500 text-sm">USDC</span>
          </div>
          {fieldErrors.roundUSDC ? (
            <p id="round-usdc-error" role="alert" className="text-xs text-red-600 mt-1">
              {fieldErrors.roundUSDC}
            </p>
          ) : (
            /* Hint uses filledCount so blank rows are not counted */
            <p id="round-usdc-hint" className="text-xs text-slate-400 mt-1">
              The full pot per round = ${roundUSDC || 0} ×{" "}
              {filledCount > 0 ? filledCount : "…"} members
            </p>
          )}
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
            onChange={(e) => {
              setRoundDays(e.target.value);
              if (fieldErrors.roundDays) setFieldErrors((prev) => ({ ...prev, roundDays: undefined }));
            }}
            className={`w-full border rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${fieldErrors.roundDays ? "border-red-400" : "border-slate-300"}`}
            aria-describedby={fieldErrors.roundDays ? "round-days-error" : "round-days-hint"}
            aria-invalid={fieldErrors.roundDays ? "true" : "false"}
            required
          />
          {fieldErrors.roundDays ? (
            <p id="round-days-error" role="alert" className="text-xs text-red-600 mt-1">
              {fieldErrors.roundDays}
            </p>
          ) : (
            <p id="round-days-hint" className="text-xs text-slate-400 mt-1">
              Each round gives members {roundDays || "…"} day{roundDays === "1" ? "" : "s"} to contribute.
            </p>
          )}
        </div>

        {/* Members */}
        <fieldset>
          <div className="flex items-center justify-between mb-2">
            <legend className="block text-sm font-medium text-slate-700">
              Members (Stellar addresses) — payout order top → bottom
            </legend>
            <span
              className={`text-xs font-medium ${
                members.length >= MAX_MEMBERS
                  ? "text-amber-600"
                  : "text-slate-400"
              }`}
              aria-live="polite"
            >
              {members.length} / {MAX_MEMBERS}
            </span>
          </div>
          <div className="space-y-2">
            {members.map((m, i) => {
              const memberError = fieldErrors.members?.[i];
              const inputId = `member-${i}`;
              const errorId = `member-${i}-error`;
              return (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 w-5 text-right" aria-hidden="true">{i + 1}.</span>
                    <input
                      id={inputId}
                      type="text"
                      placeholder={`G… (member ${i + 1})`}
                      value={m}
                      onChange={(e) => {
                        updateMember(i, e.target.value);
                        if (fieldErrors.members?.[i]) {
                          setFieldErrors((prev) => {
                            const nextMembers = { ...(prev.members ?? {}) };
                            delete nextMembers[i];
                            return { ...prev, members: nextMembers };
                          });
                        }
                      }}
                      className={`flex-1 border rounded-lg px-3 py-2 text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${memberError ? "border-red-400" : "border-slate-300"}`}
                      aria-label={`Member ${i + 1} Stellar address`}
                      aria-describedby={memberError ? errorId : undefined}
                      aria-invalid={memberError ? "true" : "false"}
                    />
                    {members.length > MIN_MEMBERS && (
                      <button
                        type="button"
                        onClick={() => removeMember(i)}
                        className="text-slate-400 hover:text-red-500 text-lg leading-none"
                        aria-label={`Remove member ${i + 1}`}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {memberError && (
                    <p
                      id={errorId}
                      role="alert"
                      className="text-xs text-red-600 mt-0.5 ml-7"
                    >
                      {memberError}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={addMember}
              disabled={members.length >= MAX_MEMBERS}
              className="text-sm text-brand-600 hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
            >
              + Add member
            </button>
            {members.length >= MAX_MEMBERS && (
              <span className="text-xs text-amber-600">
                Maximum of {MAX_MEMBERS} members reached.
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Minimum {MIN_MEMBERS} members · maximum {MAX_MEMBERS} members.
          </p>
        </fieldset>

        {/* Summary card ─────────────────────────────────────────────────────── */}
        {/* All values derived from filledCount / potPerRound so blank rows     */}
        {/* are never included in any count or calculation shown here.           */}
        <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-slate-700">
          <p className="font-semibold text-brand-800 mb-1">Circle summary</p>
          <ul className="space-y-0.5 text-slate-600">
            <li>👥 {filledCount} member{filledCount !== 1 ? "s" : ""}</li>
            <li>💰 ${roundUSDC} USDC / member / round</li>
            <li>🎯 Pot per round: ${potPerRound.toFixed(0)}</li>
            <li>📅 Round duration: {roundDays} days</li>
            <li>🔒 Collateral required: ${roundUSDC} per member (1× round amount)</li>
          </ul>
        </div>

        {error && (
          <div
            className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700"
            role="alert"
          >
            {error}
          </div>
        )}

        {txHash && (
          <div
            className="bg-brand-50 border border-brand-200 rounded-lg p-4 text-sm text-brand-700 space-y-3"
            role="status"
            aria-live="polite"
          >
            <p className="font-semibold text-brand-800 flex items-center gap-1.5">
              ✅ Circle created successfully!
            </p>

            <div>
              <p className="text-xs text-brand-600 mb-1 font-medium">Transaction hash</p>
              <div className="flex items-center gap-2 bg-white border border-brand-200 rounded-lg px-3 py-2">
                <span className="font-mono text-xs text-slate-700 flex-1 break-all select-all">
                  {txHash}
                </span>
                <button
                  type="button"
                  onClick={copyTxHash}
                  className="text-brand-600 hover:text-brand-800 text-xs font-medium shrink-0"
                  aria-label="Copy transaction hash"
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>

            <a
              href={`${EXPLORER_BASE}/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 underline hover:text-brand-900"
            >
              View on Stellar Expert ↗
            </a>

            <p className="text-xs text-slate-500">
              Redirecting to circles list in a few seconds…
            </p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !!txHash}
          className="w-full bg-brand-600 text-white py-3 rounded-xl font-semibold hover:bg-brand-700 transition-colors disabled:opacity-50 text-lg"
        >
          {loading ? "Creating circle…" : "Create Circle"}
        </button>
      </form>
    </div>
  );
}
