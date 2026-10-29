"use client";

// WalletLoadState mirrors the type in CircleDetailClient.tsx.
// Kept here to avoid a circular import; both must be kept in sync.
type WalletLoadState = "loading" | "connected" | "disconnected" | "not_installed";

interface WorkflowBannerProps {
  status: string;
  isMember: boolean;
  walletLoadState: WalletLoadState;
  walletAddress: string | null;
  alreadyContributed: boolean;
  currentRound: number;
  totalRounds: number;
}

export function WorkflowBanner({
  status,
  isMember,
  walletLoadState,
  walletAddress,
  alreadyContributed,
  currentRound,
  totalRounds,
}: WorkflowBannerProps) {
  if (status === "Completed" || status === "Cancelled") return null;

  // Don't show a "connect your wallet" banner while still loading — it would
  // flash and disappear once the wallet check resolves.
  if (walletLoadState === "loading") return null;

  if (!walletAddress) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">ℹ️</span>
        <div>
          <p className="font-semibold mb-1">Connect your wallet to interact</p>
          <p>
            Use the <strong>Connect Wallet</strong> button in the top-right
            corner to link your Freighter wallet. Once connected, you can join
            this circle (if it is still Pending) or contribute to the current
            round (if it is Active).
          </p>
        </div>
      </div>
    );
  }

  if (status === "Pending" && !isMember) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">🔆</span>
        <div>
          <p className="font-semibold mb-1">How joining works</p>
          <ol className="list-decimal list-inside space-y-1 mt-1">
            <li>
              Click <strong>"Lock Collateral &amp; Join"</strong> below. Your
              Freighter wallet will ask you to sign the transaction.
            </li>
            <li>
              The contract locks{" "}
              <strong>1× the round contribution</strong> from your wallet as
              collateral. This secures your spot in the rotation and covers any
              penalty if you miss a round.
            </li>
            <li>
              Your payout order is recorded on-chain at join time and cannot be
              changed later. The circle starts automatically once{" "}
              <strong>all members have joined</strong>.
            </li>
          </ol>
          <p className="mt-2 text-blue-700 text-xs">
            ⚠️ Make sure your wallet has enough USDC to cover the collateral
            before joining.
          </p>
        </div>
      </div>
    );
  }

  if (status === "Active" && isMember && !alreadyContributed) {
    const isLastRound = currentRound === totalRounds - 1;
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">💰</span>
        <div>
          <p className="font-semibold mb-1">Your contribution is due</p>
          <p>
            This is round <strong>{currentRound + 1}</strong> of{" "}
            <strong>{totalRounds}</strong>. Click <strong>"Contribute"</strong>{" "}
            below to add your share to the pot for this round. The pot is paid
            out automatically once every member has contributed.
          </p>
          {isLastRound && (
            <p className="mt-2 text-green-700 text-xs font-medium">
              🎉 This is the final round! Once everyone contributes and payout
              triggers, the circle completes and collateral is released.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (status === "Active" && isMember && alreadyContributed) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-700 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">✅</span>
        <div>
          <p className="font-semibold mb-1">Contribution received</p>
          <p>
            You&apos;ve contributed to round <strong>{currentRound + 1}</strong>.
            The payout will trigger automatically once all members have
            contributed.
          </p>
        </div>
      </div>
    );
  }

  return null;
}
