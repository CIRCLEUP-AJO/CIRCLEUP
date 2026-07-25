"use client";
import { useState, useEffect } from "react";
import { getWalletAddress, connectWallet, isFreighterInstalled } from "@/lib/stellar";
import { shortAddress } from "@/lib/config";

/**
 * WalletButton — header wallet connector.
 *
 * States handled:
 *  1. SSR / hydrating           → renders the "Connect Freighter" button (no flash)
 *  2. Freighter not installed   → shows install prompt with link
 *  3. Not connected             → "Connect Freighter" button
 *  4. Connecting (in-flight)    → disabled spinner button
 *  5. User rejected popup       → transient "Cancelled" label, resets after 3 s
 *  6. Unexpected error          → inline error tooltip, resets after 5 s
 *  7. Connected                 → address pill
 */

type ConnectState = "idle" | "connecting" | "rejected" | "error";

export function WalletButton() {
  const [address, setAddress]         = useState<string | null>(null);
  const [connectState, setConnectState] = useState<ConnectState>("idle");
  const [errorMsg, setErrorMsg]       = useState<string>("");
  // Track whether Freighter is present (only knowable client-side)
  const [freighterPresent, setFreighterPresent] = useState<boolean | null>(null);

  // On mount: check extension presence + existing connection
  useEffect(() => {
    setFreighterPresent(isFreighterInstalled());
    getWalletAddress().then(setAddress);
  }, []);

  async function connect() {
    if (connectState === "connecting") return;

    // Re-check on click in case the extension was installed after page load
    const present = isFreighterInstalled();
    setFreighterPresent(present);

    if (!present) {
      // Let the render path show the install prompt — nothing more to do
      return;
    }

    setConnectState("connecting");
    setErrorMsg("");

    const result = await connectWallet();

    if (result.ok) {
      setAddress(result.address);
      setConnectState("idle");
      return;
    }

    if (result.reason === "not_installed") {
      setFreighterPresent(false);
      setConnectState("idle");
      return;
    }

    if (result.reason === "rejected") {
      setConnectState("rejected");
      // Auto-reset after 3 s so the button is usable again
      setTimeout(() => setConnectState("idle"), 3000);
      return;
    }

    // Unexpected error
    setErrorMsg(result.message ?? "An unexpected error occurred.");
    setConnectState("error");
    setTimeout(() => {
      setConnectState("idle");
      setErrorMsg("");
    }, 5000);
  }

  // ── Connected pill ───────────────────────────────────────────────────────────
  if (address) {
    return (
      <div
        className="flex items-center gap-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2 text-sm"
        title={address}
        aria-label={`Wallet connected: ${address}`}
      >
        <span className="w-2 h-2 rounded-full bg-brand-500 inline-block" aria-hidden="true" />
        <span className="font-mono text-brand-700">{shortAddress(address)}</span>
      </div>
    );
  }

  // ── Freighter not installed ──────────────────────────────────────────────────
  // freighterPresent === false means we've confirmed it's absent (client-side check done)
  if (freighterPresent === false) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">No wallet found.</span>
        <a
          href="https://freighter.app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-brand-600 hover:underline font-medium"
          aria-label="Install the Freighter wallet extension (opens in new tab)"
        >
          Install Freighter ↗
        </a>
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────────
  if (connectState === "error") {
    return (
      // aria-live on the wrapper so screen readers announce the error message
      <div className="flex flex-col items-end gap-1" role="alert" aria-live="assertive">
        <button
          disabled
          className="bg-red-100 text-red-700 border border-red-300 px-4 py-2 rounded-lg text-sm font-medium opacity-80 cursor-not-allowed"
        >
          ⚠ Connection failed
        </button>
        {errorMsg && (
          <p className="text-xs text-red-600 max-w-[200px] text-right leading-tight">
            {errorMsg}
          </p>
        )}
      </div>
    );
  }

  // ── Rejected state ───────────────────────────────────────────────────────────
  if (connectState === "rejected") {
    return (
      // aria-live on the wrapper; button itself is interactive so aria-live
      // belongs on a non-interactive ancestor
      <div role="status" aria-live="polite">
        <button
          onClick={connect}
          className="bg-amber-100 text-amber-800 border border-amber-300 px-4 py-2 rounded-lg text-sm font-medium"
        >
          Cancelled — try again
        </button>
      </div>
    );
  }

  // ── Default / connecting ─────────────────────────────────────────────────────
  return (
    <button
      onClick={connect}
      disabled={connectState === "connecting"}
      className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      aria-busy={connectState === "connecting"}
    >
      {connectState === "connecting" ? "Connecting…" : "Connect Freighter"}
    </button>
  );
}
