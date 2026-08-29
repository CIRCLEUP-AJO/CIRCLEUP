"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  getWalletAddress,
  connectWallet,
  isFreighterInstalled,
  WalletError,
} from "@/lib/stellar";
import { shortAddress, NETWORK_PASSPHRASE } from "@/lib/config";
import {
  detectWalletCapabilities,
  checkNetworkMismatch,
  describeNetworkMismatch,
  type NetworkMismatchResult,
} from "@/lib/walletCapabilities";

// ─── State machine ────────────────────────────────────────────────────────────
//
// Every lifecycle transition the component can be in, as a discriminated union.
// The full set covers:
//
//   checking      — mount-time silent probe (getWalletAddress)
//   idle          — Freighter installed, no active account
//   not_installed — Freighter extension absent
//   connecting    — user clicked "Connect", waiting for requestAccess
//   connected     — active account known, writes may or may not be safe
//   changing      — account or network change detected mid-session
//   error         — connection rejected or unexpected failure
//
// The `connected` state carries the active address plus the result of the
// most recent network-mismatch check.  A `mismatch` result means write
// actions in the app should be disabled; the component shows a warning banner.
//
// `changing` is a transient state entered when a provider event fires
// (accountChanged / networkChanged).  It triggers a fresh getWalletAddress +
// network check cycle and transitions to `connected`, `idle`, or `error`.

type ConnectionState =
  | { status: "checking" }
  | { status: "idle" }
  | { status: "not_installed" }
  | { status: "connecting" }
  | { status: "connected"; address: string; networkMismatch: NetworkMismatchResult | null }
  | { status: "changing" }
  | { status: "error"; message: string };

// ─── Provider event shape ─────────────────────────────────────────────────────
//
// Freighter v2 exposes addEventListener on the injected provider for two
// events: "accountChanged" and "networkChanged".  The callback receives an
// object with the new address / network details.  We only need to know
// *that* a change happened, not the new value — we always re-probe via
// getWalletAddress so we get the authoritative state rather than trusting
// the event payload.

type FreighterEventType = "accountChanged" | "networkChanged";

interface FreighterProvider {
  addEventListener?: (
    event: FreighterEventType,
    callback: (detail?: unknown) => void,
  ) => void;
  removeEventListener?: (
    event: FreighterEventType,
    callback: (detail?: unknown) => void,
  ) => void;
}

function getProvider(): FreighterProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { freighter?: unknown; freighterApi?: unknown };
  const p = w.freighter ?? w.freighterApi;
  if (!p || typeof p !== "object") return null;
  return p as FreighterProvider;
}

// ─── Network check helper ─────────────────────────────────────────────────────

async function runNetworkCheck(): Promise<NetworkMismatchResult | null> {
  const caps = detectWalletCapabilities();
  if (!caps.canGetNetwork) return null;
  try {
    return await checkNetworkMismatch(NETWORK_PASSPHRASE);
  } catch {
    return null;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WalletButton() {
  const [state, setState] = useState<ConnectionState>({ status: "checking" });

  // Tracks whether the component is still mounted so async callbacks never
  // call setState after unmount (avoids React memory-leak warnings and
  // prevents stale state from appearing after navigation).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Resolve the active account and network check ────────────────────────
  //
  // Called on mount, after connect(), and whenever a provider change event
  // fires.  Always transitions to a stable state (connected / idle / error).
  const resolveAccount = useCallback(async () => {
    if (!mountedRef.current) return;

    let address: string | null = null;
    try {
      address = await getWalletAddress();
    } catch (err) {
      // getWalletAddress throws WalletError("not_installed") when Freighter
      // is absent — we handle that as the not_installed state rather than error.
      if (err instanceof WalletError && err.reason === "not_installed") {
        if (mountedRef.current) setState({ status: "not_installed" });
        return;
      }
      // Any other error during the probe → return to idle so the user can retry
      if (mountedRef.current) setState({ status: "idle" });
      return;
    }

    if (!mountedRef.current) return;

    if (!address) {
      // No account connected — check installed status to show the right UI
      if (!isFreighterInstalled()) {
        setState({ status: "not_installed" });
      } else {
        setState({ status: "idle" });
      }
      return;
    }

    // Account is connected — run the network check before settling the state
    const networkMismatch = await runNetworkCheck();
    if (!mountedRef.current) return;

    setState({ status: "connected", address, networkMismatch });
  }, []);

  // ── Mount: silent probe ─────────────────────────────────────────────────
  useEffect(() => {
    resolveAccount();
  }, [resolveAccount]);

  // ── Provider change listeners ───────────────────────────────────────────
  //
  // Freighter fires "accountChanged" when the user switches accounts in the
  // extension, and "networkChanged" when they switch networks.  Both events
  // invalidate the current state, so we enter `changing` and re-probe.
  //
  // Cleanup: removeEventListener is called on unmount so the callbacks are
  // never fired after the component has been removed from the tree.
  useEffect(() => {
    const provider = getProvider();
    if (!provider || typeof provider.addEventListener !== "function") return;

    const handleChange = () => {
      if (!mountedRef.current) return;
      setState({ status: "changing" });
      resolveAccount();
    };

    provider.addEventListener("accountChanged", handleChange);
    provider.addEventListener("networkChanged", handleChange);

    return () => {
      if (typeof provider.removeEventListener === "function") {
        provider.removeEventListener("accountChanged", handleChange);
        provider.removeEventListener("networkChanged", handleChange);
      }
    };
  }, [resolveAccount]);

  // ── Connect handler ─────────────────────────────────────────────────────
  async function connect() {
    setState({ status: "connecting" });
    try {
      const address = await connectWallet();
      if (!mountedRef.current) return;
      const networkMismatch = await runNetworkCheck();
      if (!mountedRef.current) return;
      setState({ status: "connected", address, networkMismatch });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof WalletError) {
        if (err.reason === "not_installed") {
          setState({ status: "not_installed" });
        } else {
          // permission_denied or unknown — show the message but stay actionable
          setState({ status: "error", message: err.message });
        }
      } else {
        setState({
          status: "error",
          message: (err as Error)?.message || "Failed to connect wallet.",
        });
      }
    }
  }

  // ── Render: connected ───────────────────────────────────────────────────
  if (state.status === "connected") {
    const mismatchMessage =
      state.networkMismatch && state.networkMismatch.kind !== "match"
        ? describeNetworkMismatch(state.networkMismatch)
        : null;

    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2 text-sm">
          <span className="w-2 h-2 rounded-full bg-brand-500 inline-block flex-shrink-0" aria-hidden="true" />
          <span className="font-mono text-brand-700 truncate" title={state.address}>
            {shortAddress(state.address)}
          </span>
        </div>

        {/* Network mismatch warning — shown below the address pill when detected.
            Read-only pages remain functional; only write actions are blocked
            (enforced by gating.ts checkNetworkGate). The banner is dismissible
            per session by the user, but re-appears after a network-change event. */}
        {mismatchMessage && (
          <div
            role="alert"
            aria-live="polite"
            className="flex items-start gap-1.5 bg-amber-50 border border-amber-300 text-amber-800 rounded-lg px-3 py-2 text-xs"
          >
            <span className="flex-shrink-0 mt-0.5" aria-hidden="true">⚠️</span>
            <span>{mismatchMessage}</span>
          </div>
        )}
      </div>
    );
  }

  // ── Render: not installed ───────────────────────────────────────────────
  if (state.status === "not_installed") {
    return (
      <a
        href="https://freighter.app"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-amber-50 border border-amber-300 text-amber-800 px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
        title="Freighter wallet is required to use CircleUp"
      >
        <span aria-hidden="true">🔌</span>
        Install Freighter
      </a>
    );
  }

  // ── Render: error ───────────────────────────────────────────────────────
  if (state.status === "error") {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={connect}
          className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          title={state.message}
        >
          Retry Connection
        </button>
        <span
          className="text-xs text-red-600 max-w-[180px] truncate"
          title={state.message}
          aria-live="polite"
        >
          {state.message}
        </span>
      </div>
    );
  }

  // ── Render: checking / connecting / changing / idle ─────────────────────
  const isLoading =
    state.status === "checking" ||
    state.status === "connecting" ||
    state.status === "changing";

  const label =
    state.status === "connecting"
      ? "Connecting…"
      : state.status === "changing"
        ? "Updating…"
        : "Connect Freighter";

  return (
    <button
      onClick={connect}
      disabled={isLoading}
      className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
      aria-busy={isLoading}
    >
      {isLoading ? (
        <span className="flex items-center gap-1.5">
          <svg
            className="animate-spin h-3.5 w-3.5 text-white"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          {label}
        </span>
      ) : (
        label
      )}
    </button>
  );
}
