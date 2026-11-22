/**
 * Tests for wallet change notification limitation detection and
 * pre-sign identity re-check behavior.
 *
 * Covers:
 *   - explainMonitoringLimitation: returns null when canWatchChanges is true,
 *     returns a non-null advisory when false, returns null when not installed
 *   - providerHasChangeListeners: absent provider, present provider
 *     with/without addEventListener, via canWatchChanges detection
 *   - submitContractTx pre-sign identity re-check when provider has no listeners:
 *     same account passes identity check, different account throws with explicit message
 *   - submitContractTx: AbortSignal fired before signing stops without wallet prompt
 *   - walletCapabilities: provider that starts reporting change listeners
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { explainMonitoringLimitation, detectWalletCapabilities } from "./walletCapabilities";

// ─── Mocks (must be hoisted before any import that transitively loads them) ───

const walletApi = vi.hoisted(() => ({
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  signTransaction: vi.fn(),
  requestAccess: vi.fn(),
}));

vi.mock("@stellar/freighter-api", () => walletApi);
vi.mock("./config", async () => {
  const fixtures = await import("../../../sdk/src/__tests__/fixtures");
  return {
    STELLAR_RPC_URL: fixtures.SDK_CONFIG.rpcUrl,
    NETWORK_PASSPHRASE: fixtures.SDK_CONFIG.networkPassphrase,
    CIRCLE_FACTORY_ADDRESS: fixtures.FACTORY_ADDR,
    REPUTATION_ADDRESS: fixtures.REPUTATION_ADDR,
    USDC_ADDRESS: fixtures.USDC_ADDR,
  };
});

import { submitContractTx } from "./stellar";
import { setDeploymentFacts } from "./deploymentState";
import { startTx } from "./telemetry";
import type { WalletAdapter } from "./walletAdapter";

// ─── Shared helpers ───────────────────────────────────────────────────────────

const noop = () => {};

const ACCOUNT = `G${"A".repeat(55)}`;
const OTHER_ACCOUNT = `G${"B".repeat(55)}`;

/** Build a minimal WalletAdapter with controllable getAddress behaviour. */
function makeAdapter(opts: {
  activeAddress?: string;
  canSign?: boolean;
  canWatchChanges?: boolean;
}): WalletAdapter {
  const { activeAddress = ACCOUNT, canSign = true, canWatchChanges = false } = opts;
  return {
    id: "test-adapter",
    capabilities: () => ({
      available: true,
      supports: {
        getAddress: true,
        getNetwork: false,
        signTransaction: canSign,
        watchChanges: canWatchChanges,
      },
    }),
    getAddress: vi.fn(async () =>
      activeAddress
        ? { ok: true as const, value: activeAddress }
        : { ok: false as const, reason: "not_connected" as const, message: "not connected" }
    ),
    getNetwork: vi.fn(async () => ({
      ok: false as const,
      reason: "unsupported_capability" as const,
      message: "n/a",
    })),
    signTransaction: vi.fn(async () => ({
      ok: false as const,
      reason: "user_rejected" as const,
      message: "rejected",
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// explainMonitoringLimitation
// ─────────────────────────────────────────────────────────────────────────────

describe("explainMonitoringLimitation", () => {
  it("returns null when no wallet is installed", () => {
    const caps = detectWalletCapabilities(undefined);
    expect(explainMonitoringLimitation(caps)).toBeNull();
  });

  it("returns null when canWatchChanges is true (continuous monitoring active)", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: noop, signTransaction: noop, addEventListener: noop },
    });
    expect(caps.canWatchChanges).toBe(true);
    expect(explainMonitoringLimitation(caps)).toBeNull();
  });

  it("returns a non-null advisory message when canWatchChanges is false", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: noop, signTransaction: noop },
    });
    expect(caps.canWatchChanges).toBe(false);
    const msg = explainMonitoringLimitation(caps);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/cannot notify/i);
  });

  it("advisory mentions identity will be verified before each transaction", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: noop, signTransaction: noop },
    });
    expect(explainMonitoringLimitation(caps)).toMatch(/verified/i);
  });

  it("advisory does not claim continuous monitoring is active", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: noop, signTransaction: noop },
    });
    const msg = explainMonitoringLimitation(caps);
    expect(msg).not.toMatch(/continuously monitor/i);
    expect(msg).not.toMatch(/real-time/i);
  });

  it("advisory mentions that read-only browsing is unaffected", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: noop, signTransaction: noop },
    });
    expect(explainMonitoringLimitation(caps)).toMatch(/read.only/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canWatchChanges detection (providerHasChangeListeners via capabilities)
// ─────────────────────────────────────────────────────────────────────────────

describe("canWatchChanges detection", () => {
  it("false when provider has no addEventListener", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: noop, signTransaction: noop, getNetworkDetails: noop },
    });
    expect(caps.canWatchChanges).toBe(false);
  });

  it("true when provider exposes addEventListener", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: noop, signTransaction: noop, addEventListener: noop },
    });
    expect(caps.canWatchChanges).toBe(true);
  });

  it("true when provider exposes watchWalletChanges (alternative API)", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: noop, signTransaction: noop, watchWalletChanges: noop },
    });
    expect(caps.canWatchChanges).toBe(true);
  });

  it("re-detecting reflects updated provider state", () => {
    const before = detectWalletCapabilities({ freighter: { signTransaction: noop } });
    const after  = detectWalletCapabilities({ freighter: { signTransaction: noop, addEventListener: noop } });
    expect(before.canWatchChanges).toBe(false);
    expect(after.canWatchChanges).toBe(true);
    expect(explainMonitoringLimitation(before)).not.toBeNull();
    expect(explainMonitoringLimitation(after)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitContractTx: pre-sign identity re-check without change listeners
// ─────────────────────────────────────────────────────────────────────────────

describe("submitContractTx — pre-sign identity re-check (no change listeners)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletApi.isConnected.mockResolvedValue(true);
    walletApi.getPublicKey.mockResolvedValue(ACCOUNT);
    setDeploymentFacts([{ name: "test evidence", status: "verified" }]);
    (window as unknown as { freighter?: unknown }).freighter = undefined;
  });

  afterEach(() => {
    (window as unknown as { freighter?: unknown }).freighter = undefined;
  });

  it("performs a live getAddress call before signing when no change listeners are available", async () => {
    // Active address matches prepared account → identity check passes → reaches signing step
    // (signing rejects with user_rejected — that's expected; we care getAddress was called)
    const wallet = makeAdapter({ activeAddress: ACCOUNT, canWatchChanges: false });
    try {
      await submitContractTx("prepared-xdr", ACCOUNT, startTx("join"), undefined, wallet);
    } catch { /* network/RPC errors expected in test env */ }
    expect(wallet.getAddress).toHaveBeenCalled();
  });

  it("throws with an explicit account-change message when the active address differs", async () => {
    // User switched accounts in Freighter; provider could not notify us.
    // App prepared tx for ACCOUNT but wallet is now on OTHER_ACCOUNT.
    const wallet = makeAdapter({ activeAddress: OTHER_ACCOUNT, canWatchChanges: false });
    await expect(
      submitContractTx("prepared-xdr", ACCOUNT, startTx("contribute"), undefined, wallet)
    ).rejects.toThrow(/account changed/i);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("produces a recoverable message mentioning review when account differs", async () => {
    const wallet = makeAdapter({ activeAddress: OTHER_ACCOUNT, canWatchChanges: false });
    let caught: Error | null = null;
    try {
      await submitContractTx("prepared-xdr", ACCOUNT, startTx("payout"), undefined, wallet);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // The message must tell the user to review — either "re-submit" (Freighter no-listener path)
    // or "Review the action" (revision-guard path for custom adapters).
    expect(caught!.message).toMatch(/review|re-submit/i);
  });

  it("never presents a signing prompt when the account has silently changed", async () => {
    const wallet = makeAdapter({ activeAddress: OTHER_ACCOUNT, canWatchChanges: false });
    try {
      await submitContractTx("prepared-xdr", ACCOUNT, startTx("close"), undefined, wallet);
    } catch { /* expected */ }
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitContractTx: AbortSignal arriving before signing
// ─────────────────────────────────────────────────────────────────────────────

describe("submitContractTx — AbortSignal fired before signing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletApi.isConnected.mockResolvedValue(true);
    walletApi.getPublicKey.mockResolvedValue(ACCOUNT);
    setDeploymentFacts([{ name: "test evidence", status: "verified" }]);
    (window as unknown as { freighter?: unknown }).freighter = undefined;
  });

  afterEach(() => {
    (window as unknown as { freighter?: unknown }).freighter = undefined;
  });

  it("stops submission without presenting a wallet prompt", async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // abort immediately — simulates wallet-change abort
    const wallet = makeAdapter({ activeAddress: ACCOUNT });
    await expect(
      submitContractTx("prepared-xdr", ACCOUNT, startTx("join"), ctrl.signal, wallet)
    ).rejects.toThrow();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("account mismatch combined with abort never reaches signing", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const wallet = makeAdapter({ activeAddress: OTHER_ACCOUNT });
    await expect(
      submitContractTx("prepared-xdr", ACCOUNT, startTx("close"), ctrl.signal, wallet)
    ).rejects.toThrow();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
});
