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
 *    call during server rendering.
 *  - **Provider-driven, not import-driven.** Capabilities are derived by
 *    inspecting the injected Freighter provider object rather than the
 *    `@stellar/freighter-api` wrappers, so the result reflects the actual
 *    extension present and the module is trivially mockable in tests.
 *  - **No sensitive data.** Detection reads only the *shape* of the provider
 *    (which members are functions); it never reads keys, addresses, or network
 *    details, so results and any derived diagnostics are safe to log.
 *  - **Network mismatch detection.** `getProviderNetwork` fetches the active
 *    passphrase from the provider and `checkNetworkMismatch` compares it to
 *    the app-configured passphrase.  A mismatch means every write transaction
 *    will be rejected on-chain; write actions must be disabled until resolved.
 *
 * This module has no imports so it stays cheap to load on the server and easy
 * to unit-test in isolation.  The one exception is the optional `configuredPassphrase`
 * parameter that callers supply — the module never imports from `config.ts`
 * directly to keep the dependency graph clean and testable.
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

// ─── Network mismatch ──────────────────────────────────────────────────────

/**
 * The result of comparing the provider's active network passphrase to the
 * app-configured passphrase.
 *
 * | `kind`               | Meaning |
 * |----------------------|---------|
 * | `match`              | Passphrases are identical — writes are safe. |
 * | `mismatch`           | Passphrases differ — writes will be rejected on-chain. |
 * | `unknown`            | Provider supports network queries but the call failed. |
 * | `unsupported`        | Provider cannot report the active network. |
 * | `provider_error`     | The network query threw an unexpected error. |
 *
 * The `detectedPassphrase` field is present for `mismatch` and `match` kinds
 * so the UI can display "expected X, got Y" without a second round-trip.
 */
export type NetworkMismatchResult =
  | { readonly kind: "match";          readonly detectedPassphrase: string }
  | { readonly kind: "mismatch";       readonly detectedPassphrase: string; readonly configuredPassphrase: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "provider_error"; readonly error: string };

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

// ─── Network query ─────────────────────────────────────────────────────────

/**
 * Ask the injected provider for the currently active network passphrase.
 *
 * Returns `null` when:
 *  - Called during SSR (`window` is undefined).
 *  - No provider is injected.
 *  - The provider does not implement `getNetwork` or `getNetworkDetails`.
 *  - The provider call throws or returns an empty value.
 *
 * This function is async because Freighter's network query is async (it
 * communicates with the extension background page).
 *
 * @param win  Window-like to probe. Defaults to the real `window`.
 */
export async function getProviderNetwork(
  win?: WindowLike,
): Promise<string | null> {
  const provider = getInjectedProvider(win);
  if (!provider) return null;

  // Prefer getNetworkDetails (Freighter v2) which returns an object with a
  // `networkPassphrase` field.  Fall back to getNetwork which may return the
  // passphrase string directly on older builds.
  if (isFn(provider.getNetworkDetails)) {
    try {
      const details = await (provider.getNetworkDetails as () => Promise<unknown>)();
      if (details && typeof details === "object") {
        const passphrase = (details as Record<string, unknown>).networkPassphrase;
        if (typeof passphrase === "string" && passphrase.trim() !== "") {
          return passphrase.trim();
        }
      }
    } catch {
      // Fall through to getNetwork
    }
  }

  if (isFn(provider.getNetwork)) {
    try {
      const result = await (provider.getNetwork as () => Promise<unknown>)();
      if (typeof result === "string" && result.trim() !== "") {
        return result.trim();
      }
      // Some builds return { network: string, networkPassphrase: string }
      if (result && typeof result === "object") {
        const passphrase = (result as Record<string, unknown>).networkPassphrase;
        if (typeof passphrase === "string" && passphrase.trim() !== "") {
          return passphrase.trim();
        }
      }
    } catch {
      // Provider error — handled by caller
    }
  }

  return null;
}

/**
 * Compare the provider's active network to the app-configured passphrase.
 *
 * This is the primary entry point for network-mismatch detection.  Call it
 * after the wallet connects (and again when the provider fires a network-change
 * event) to determine whether write actions should be enabled.
 *
 * A {@link NetworkMismatchResult} with `kind === "mismatch"` means the user's
 * wallet is on a different network from the one the app was built for; every
 * write transaction will be rejected on-chain and the UI should block writes
 * and show the expected vs detected network to the user.
 *
 * @param configuredPassphrase  The passphrase the app was built for
 *                              (i.e. `NETWORK_PASSPHRASE` from `config.ts`).
 * @param win                   Window-like to probe. Defaults to the real `window`.
 *
 * @example
 * const result = await checkNetworkMismatch(NETWORK_PASSPHRASE);
 * if (result.kind === "mismatch") {
 *   setNetworkError(`Wrong network: expected ${result.configuredPassphrase}, got ${result.detectedPassphrase}`);
 * }
 */
export async function checkNetworkMismatch(
  configuredPassphrase: string,
  win?: WindowLike,
): Promise<NetworkMismatchResult> {
  const provider = getInjectedProvider(win);

  if (!provider) {
    return { kind: "unsupported" };
  }

  const caps = detectWalletCapabilities(win);
  if (!caps.canGetNetwork) {
    return { kind: "unsupported" };
  }

  let detectedPassphrase: string | null;
  try {
    detectedPassphrase = await getProviderNetwork(win);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "provider_error", error: message };
  }

  if (detectedPassphrase === null) {
    return { kind: "unknown" };
  }

  if (detectedPassphrase === configuredPassphrase) {
    return { kind: "match", detectedPassphrase };
  }

  return {
    kind: "mismatch",
    detectedPassphrase,
    configuredPassphrase,
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
 * failed attempt.
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

/**
 * Build a human-readable description of a {@link NetworkMismatchResult} for
 * display in a UI warning banner or tooltip.
 *
 * Returns `null` when the result does not represent an actionable problem
 * (i.e. `kind === "match"`).
 */
export function describeNetworkMismatch(
  result: NetworkMismatchResult,
): string | null {
  switch (result.kind) {
    case "match":
      return null;
    case "mismatch":
      return (
        `Your wallet is connected to a different network than this app expects. ` +
        `Expected: "${result.configuredPassphrase}". ` +
        `Detected: "${result.detectedPassphrase}". ` +
        `Switch your wallet to the correct network to enable write actions.`
      );
    case "unknown":
      return (
        "Could not determine the active network from your wallet. " +
        "Verify your wallet is connected to the correct network before submitting transactions."
      );
    case "unsupported":
      return (
        "Your wallet cannot report the active network. " +
        "Verify it is connected to the correct network before submitting transactions."
      );
    case "provider_error":
      return (
        "An error occurred while checking your wallet's active network. " +
        "Verify your wallet is connected and try again."
      );
  }
}
