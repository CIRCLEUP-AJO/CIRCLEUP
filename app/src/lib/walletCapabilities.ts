/**
 * Wallet capability detection for the CircleUp app.
 *
 * Wallet providers differ in what they support: some can sign but not report
 * the active network; some expose no account-change listener. Before the UI
 * offers an action that would fail mid-flow (e.g. prompting a signature a
 * provider cannot produce), it should ask this module what the connected
 * provider can actually do and explain any gap up front.
 *
 * Design notes:
 *  - **SSR-safe.** Every entry point tolerates `window` being undefined and
 *    returns an all-unsupported result instead of throwing, so it is safe to
 *    call during server rendering. (Acceptance: wallet absence never crashes
 *    server rendering.)
 *  - **Provider-driven, not import-driven.** Capabilities are derived by
 *    inspecting the injected Freighter provider object rather than the
 *    `@stellar/freighter-api` wrappers, so the result reflects the actual
 *    extension present and the module is trivially mockable in tests.
 *  - **No sensitive data.** Detection reads only the *shape* of the provider
 *    (which members are functions); it never reads keys, addresses, or network
 *    details, so results and any derived diagnostics are safe to log.
 *
 * This module intentionally has no imports so it stays cheap to load on the
 * server and easy to unit-test in isolation.
 */

// ─── Capability result ─────────────────────────────────────────────────────

/** The capabilities the app checks before starting a wallet action. */
export interface WalletCapabilities {
  /** A wallet provider is injected in this environment. */
  readonly installed: boolean;
  /** Provider can establish a connection / return a public key. */
  readonly canConnect: boolean;
  /** Provider can sign a transaction. */
  readonly canSignTransaction: boolean;
  /** Provider can report the active network (for network-mismatch checks). */
  readonly canGetNetwork: boolean;
  /** Provider can notify the app when the account or network changes. */
  readonly canWatchChanges: boolean;
}

/** All-unsupported result — used for SSR and when no provider is present. */
const NO_CAPABILITIES: WalletCapabilities = {
  installed: false,
  canConnect: false,
  canSignTransaction: false,
  canGetNetwork: false,
  canWatchChanges: false,
};

// ─── Provider probing ──────────────────────────────────────────────────────

/**
 * Shape of the injected provider we probe. Every member is optional because
 * providers differ; the presence of a *function* is what a capability means.
 */
interface InjectedProvider {
  isConnected?: unknown;
  requestAccess?: unknown;
  getPublicKey?: unknown;
  getAddress?: unknown;
  signTransaction?: unknown;
  getNetwork?: unknown;
  getNetworkDetails?: unknown;
  addEventListener?: unknown;
  watchWalletChanges?: unknown;
}

/** Minimal window shape carrying the injected provider globals. */
type WindowLike = { freighter?: unknown; freighterApi?: unknown };

function isFn(v: unknown): boolean {
  return typeof v === "function";
}

function defaultWindow(): WindowLike | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as unknown as WindowLike);
}

/**
 * Returns the injected Freighter provider object, or `null` when none is
 * present or when called outside a browser (SSR).
 *
 * @param win Window-like object to probe. Defaults to the real `window`
 *            (or `undefined` on the server). Inject a fake in tests.
 */
export function getInjectedProvider(
  win: WindowLike | undefined = defaultWindow(),
): InjectedProvider | null {
  if (!win) return null;
  // Freighter v2 injects `window.freighter`; earlier builds inject `freighterApi`.
  const provider = win.freighter ?? win.freighterApi;
  if (!provider || typeof provider !== "object") return null;
  return provider as InjectedProvider;
}

/**
 * Detect what the currently-injected wallet provider can do.
 *
 * Always safe to call — returns an all-unsupported {@link WalletCapabilities}
 * during SSR or when no provider is injected, and never throws.
 *
 * @param win Window-like object to probe. Defaults to the real `window`.
 */
export function detectWalletCapabilities(win?: WindowLike): WalletCapabilities {
  const provider = getInjectedProvider(win);
  if (!provider) return NO_CAPABILITIES;
  return {
    installed: true,
    canConnect: isFn(provider.requestAccess) || isFn(provider.isConnected),
    canSignTransaction: isFn(provider.signTransaction),
    canGetNetwork: isFn(provider.getNetwork) || isFn(provider.getNetworkDetails),
    canWatchChanges:
      isFn(provider.addEventListener) || isFn(provider.watchWalletChanges),
  };
}

// ─── Action gating ─────────────────────────────────────────────────────────

/** A user-facing action that depends on a specific wallet capability. */
export type WalletAction = "connect" | "sign" | "detectNetwork" | "watchChanges";

const ACTION_REQUIREMENTS: Record<
  WalletAction,
  { readonly capability: keyof WalletCapabilities; readonly label: string }
> = {
  connect: { capability: "canConnect", label: "connect your wallet" },
  sign: { capability: "canSignTransaction", label: "sign this transaction" },
  detectNetwork: { capability: "canGetNetwork", label: "verify the active network" },
  watchChanges: {
    capability: "canWatchChanges",
    label: "detect wallet account changes",
  },
};

/**
 * Returns a user-facing explanation of why `action` cannot proceed with the
 * given capabilities, or `null` when the action is supported.
 *
 * Call this before starting the action (e.g. before prompting a signature) so
 * the user is told about an unsupported provider up front rather than after a
 * failed attempt. (Acceptance: unsupported actions are explained before signing.)
 */
export function explainUnsupportedAction(
  action: WalletAction,
  caps: WalletCapabilities,
): string | null {
  if (!caps.installed) {
    return "No Stellar wallet detected. Install the Freighter extension (https://freighter.app) to continue.";
  }
  const req = ACTION_REQUIREMENTS[action];
  if (!caps[req.capability]) {
    return `Your wallet does not support the ability to ${req.label}. Update Freighter, or switch to a wallet that supports it.`;
  }
  return null;
}
