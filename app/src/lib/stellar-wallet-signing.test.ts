import { beforeEach, describe, expect, it, vi } from "vitest";

const walletApi = vi.hoisted(() => ({
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  signTransaction: vi.fn(),
  requestAccess: vi.fn(),
}));

vi.mock("@stellar/freighter-api", () => walletApi);
vi.mock("./walletCapabilities", () => ({
  detectWalletCapabilities: () => ({
    installed: true,
    canConnect: true,
    canSignTransaction: true,
    canGetNetwork: false,
    canWatchChanges: false,
  }),
  explainUnsupportedAction: () => null,
}));

import { signTransaction } from "@stellar/freighter-api";
import { startTx } from "./telemetry";
import { connectWallet, submitContractTx, WalletError } from "./stellar";

const account = `G${"A".repeat(55)}`;

describe("submitContractTx wallet signing boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { freighter: unknown }).freighter = undefined;
    walletApi.isConnected.mockResolvedValue(true);
    walletApi.getPublicKey.mockResolvedValue(account);
  });

  it("reports an unavailable wallet without requesting account access", async () => {
    await expect(connectWallet()).rejects.toMatchObject<Partial<WalletError>>({
      reason: "not_installed",
    });
    expect(walletApi.requestAccess).not.toHaveBeenCalled();
  });

  it("reports denied wallet permission as recoverable access denial", async () => {
    (window as unknown as { freighter: unknown }).freighter = {};
    walletApi.requestAccess.mockRejectedValue(new Error("User rejected request"));

    await expect(connectWallet()).rejects.toMatchObject<Partial<WalletError>>({
      reason: "permission_denied",
    });
    expect(walletApi.requestAccess).toHaveBeenCalledOnce();
  });

  it("returns the account granted by Freighter", async () => {
    (window as unknown as { freighter: unknown }).freighter = {};
    walletApi.requestAccess.mockResolvedValue(account);

    await expect(connectWallet()).resolves.toBe(account);
  });

  it("binds signing to the simulated member and configured network", async () => {
    vi.mocked(signTransaction).mockRejectedValue(new Error("User rejected"));

    const result = await submitContractTx("prepared-xdr", account, startTx("join"));

    expect(signTransaction).toHaveBeenCalledWith("prepared-xdr", {
      networkPassphrase: "Test SDF Network ; September 2015",
      accountToSign: account,
    });
    expect(result.success).toBe(false);
    expect(result.txHash).toBe("");
  });

  it("keeps the transaction unsubmitted when the wallet rejects signing", async () => {
    vi.mocked(signTransaction).mockRejectedValue(new Error("User rejected"));

    const result = await submitContractTx("prepared-xdr", account, startTx("contribute"));

    expect(result.success).toBe(false);
    expect(result.typedError).toBeDefined();
    expect(result.txHash).toBe("");
  });
});