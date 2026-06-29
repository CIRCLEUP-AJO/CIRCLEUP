"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CIRCLE_FACTORY_ADDRESS,
  NETWORK_PASSPHRASE,
  usdcToStroops,
  shortAddress,
} from "@/lib/config";
import { getWalletAddress, invokeContract } from "@/lib/stellar";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

const DAYS_TO_LEDGERS = (d: number) => Math.round((d * 24 * 60 * 60) / 5);

export default function CreatePage() {
  const router = useRouter();
  const [members, setMembers] = useState<string[]>(["", "", "", ""]);
  const [roundUSDC, setRoundUSDC] = useState("100");
  const [roundDays, setRoundDays] = useState("30");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState("");

  function updateMember(i: number, val: string) {
    setMembers((prev) => {
      const next = [...prev];
      next[i] = val;
      return next;
    });
  }

  function addMember() {
    setMembers((prev) => [...prev, ""]);
  }

  function removeMember(i: number) {
    if (members.length <= 2) return;
    setMembers((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setTxHash("");

    const walletAddress = await getWalletAddress();
    if (!walletAddress) {
      setError("Connect your Freighter wallet first.");
      return;
    }

    const validMembers = members.filter((m) => m.trim().length > 0);
    if (validMembers.length < 2) {
      setError("Need at least 2 members.");
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
          nativeToScVal(DAYS_TO_LEDGERS(days), { type: "u32" }),
        ],
        walletAddress,
      );

      if (!result.success) {
        setError(result.error || "Transaction failed");
        return;
      }

      setTxHash(result.txHash);
      setTimeout(() => router.push("/"), 3000);
    } catch (err: any) {
      setError(err.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

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
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Contribution per member / round (USDC)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-lg">$</span>
            <input
              type="number"
              min="1"
              step="1"
              value={roundUSDC}
              onChange={(e) => setRoundUSDC(e.target.value)}
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
              required
            />
            <span className="text-slate-500 text-sm">USDC</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            The full pot per round = ${roundUSDC || 0} × {members.filter((m) => m).length || members.length} members
          </p>
        </div>

        {/* Round duration */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Round duration (days)
          </label>
          <input
            type="number"
            min="1"
            value={roundDays}
            onChange={(e) => setRoundDays(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
            required
          />
        </div>

        {/* Members */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">
            Members (Stellar addresses) — payout order top → bottom
          </label>
          <div className="space-y-2">
            {members.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-slate-400 w-5 text-right">{i + 1}.</span>
                <input
                  type="text"
                  placeholder={`G... (member ${i + 1})`}
                  value={m}
                  onChange={(e) => updateMember(i, e.target.value)}
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                {members.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeMember(i)}
                    className="text-slate-400 hover:text-red-500 text-lg leading-none"
                    aria-label="Remove member"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addMember}
            className="mt-2 text-sm text-brand-600 hover:underline"
          >
            + Add member
          </button>
        </div>

        {/* Summary */}
        <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-slate-700">
          <p className="font-semibold text-brand-800 mb-1">Circle summary</p>
          <ul className="space-y-0.5 text-slate-600">
            <li>👥 {members.filter((m) => m.trim()).length} members</li>
            <li>💰 ${roundUSDC} USDC / member / round</li>
            <li>🎯 Pot per round: ${(parseFloat(roundUSDC || "0") * members.filter((m) => m.trim()).length).toFixed(0)}</li>
            <li>📅 Round duration: {roundDays} days</li>
            <li>🔒 Collateral required: ${roundUSDC} per member (1× round amount)</li>
          </ul>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {txHash && (
          <div className="bg-brand-50 border border-brand-200 rounded-lg p-3 text-sm text-brand-700">
            ✅ Circle created! Tx:{" "}
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono underline"
            >
              {shortAddress(txHash)}
            </a>
            <br />
            Redirecting to circles list…
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-brand-600 text-white py-3 rounded-xl font-semibold hover:bg-brand-700 transition-colors disabled:opacity-50 text-lg"
        >
          {loading ? "Creating circle…" : "Create Circle"}
        </button>
      </form>
    </div>
  );
}
