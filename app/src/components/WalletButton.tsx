"use client";
import { useState, useEffect } from "react";
import { getWalletAddress } from "@/lib/stellar";
import { shortAddress } from "@/lib/config";
import { isConnected, requestAccess, getPublicKey } from "@stellar/freighter-api";

export function WalletButton() {
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getWalletAddress().then(setAddress);
  }, []);

  async function connect() {
    setLoading(true);
    try {
      // requestAccess returns the public key string directly in v2
      const pk = await requestAccess();
      setAddress(pk || null);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  if (address) {
    return (
      <div className="flex items-center gap-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2 text-sm">
        <span className="w-2 h-2 rounded-full bg-brand-500 inline-block" />
        <span className="font-mono text-brand-700">{shortAddress(address)}</span>
      </div>
    );
  }

  return (
    <button
      onClick={connect}
      disabled={loading}
      className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-50"
    >
      {loading ? "Connecting…" : "Connect Freighter"}
    </button>
  );
}
