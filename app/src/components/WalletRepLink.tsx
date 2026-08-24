"use client";

/**
 * WalletRepLink — navigation link to the connected wallet's reputation page.
 *
 * Rendered in the root layout's nav bar. When the user's Freighter wallet is
 * connected the link resolves to /reputation/<address>. While the wallet
 * address is not yet known (page first load, or wallet disconnected) it falls
 * back to a plain "My Reputation" label so the nav item is still visible and
 * legible.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { getWalletAddress } from "@/lib/stellar";

export function WalletRepLink() {
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    getWalletAddress()
      .then(setAddress)
      .catch(() => setAddress(null));
  }, []);

  if (!address) {
    // Wallet not connected yet — render a disabled-looking link so the nav
    // slot stays the same size and doesn't shift when the address loads.
    return (
      <span
        className="text-slate-400 cursor-default select-none"
        title="Connect your wallet to view your reputation"
        aria-label="My Reputation — connect wallet to view"
      >
        My Reputation
      </span>
    );
  }

  return (
    <Link
      href={`/reputation/${address}`}
      className="text-slate-600 hover:text-brand-600 transition-colors"
      aria-label="My Reputation"
    >
      My Reputation
    </Link>
  );
}
