import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
// Note: @testing-library/user-event is NOT imported here because user-event v14
// calls `new Pointer(document)` at module evaluation time, which throws
// `Cannot read properties of undefined (reading 'on')` under Node 24 / jsdom
// before the pointer API is shimmed.  We use fireEvent for click simulation
// instead — it's synchronous, has no DOM bootstrapping side-effects, and is
// the correct choice for testing button click handlers (not pointer events).

// ─── Mock @/lib/stellar ───────────────────────────────────────────────────────

vi.mock("@/lib/stellar", () => {
  class WalletError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
      this.name = "WalletError";
    }
  }
  return {
    WalletError,
    isFreighterInstalled: vi.fn(),
    getWalletAddress: vi.fn(),
    connectWallet: vi.fn(),
  };
});

// ─── Mock @/lib/config ────────────────────────────────────────────────────────

vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`,
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  CIRCLE_FACTORY_ADDRESS: "",
  REPUTATION_ADDRESS: "",
  USDC_ADDRESS: "",
  INDEXER_URL: "http://localhost:3001",
}));

// ─── Mock @/lib/walletCapabilities ────────────────────────────────────────────
//
// Default: canGetNetwork=false so the network-check path is a no-op in tests
// that don't care about it.  Individual tests override as needed.

vi.mock("@/lib/walletCapabilities", () => ({
  detectWalletCapabilities: vi.fn(() => ({
    installed: true,
    canConnect: true,
    canSignTransaction: true,
    canGetNetwork: false,
    canWatchChanges: false,
  })),
  checkNetworkMismatch: vi.fn(async () => ({ kind: "unsupported" })),
  describeNetworkMismatch: vi.fn(() => null),
}));

import { WalletButton } from "@/components/WalletButton";
import * as stellar from "@/lib/stellar";
import * as walletCaps from "@/lib/walletCapabilities";

const mockStellar = stellar as {
  isFreighterInstalled: ReturnType<typeof vi.fn>;
  getWalletAddress: ReturnType<typeof vi.fn>;
  connectWallet: ReturnType<typeof vi.fn>;
  WalletError: new (reason: string, msg: string) => Error & { reason: string };
};

const mockCaps = walletCaps as {
  detectWalletCapabilities: ReturnType<typeof vi.fn>;
  checkNetworkMismatch: ReturnType<typeof vi.fn>;
  describeNetworkMismatch: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCaps.detectWalletCapabilities.mockReturnValue({
    installed: true,
    canConnect: true,
    canSignTransaction: true,
    canGetNetwork: false,
    canWatchChanges: false,
  });
  mockCaps.checkNetworkMismatch.mockResolvedValue({ kind: "unsupported" });
  mockCaps.describeNetworkMismatch.mockReturnValue(null);
});

// helper: click a button and flush effects
async function click(el: HTMLElement) {
  await act(async () => { fireEvent.click(el); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle state
// ─────────────────────────────────────────────────────────────────────────────

describe("WalletButton — idle state (Freighter installed, not connected)", () => {
  it("renders Connect Freighter button", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /connect freighter/i })).toBeInTheDocument()
    );
  });

  it("button is not disabled in idle state", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    render(<WalletButton />);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /connect freighter/i });
      expect(btn).not.toBeDisabled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connected state
// ─────────────────────────────────────────────────────────────────────────────

describe("WalletButton — connected state", () => {
  it("shows shortened address without a connect button", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GAAA…AAAA")).toBeInTheDocument()
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not show a network warning when mismatch check returns null description", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);
    mockCaps.describeNetworkMismatch.mockReturnValue(null);

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GAAA…AAAA")).toBeInTheDocument()
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows network mismatch warning when mismatch is detected", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);
    mockCaps.detectWalletCapabilities.mockReturnValue({
      installed: true, canConnect: true, canSignTransaction: true,
      canGetNetwork: true, canWatchChanges: false,
    });
    mockCaps.checkNetworkMismatch.mockResolvedValue({
      kind: "mismatch",
      detectedPassphrase: "Public Global Stellar Network ; September 2015",
      configuredPassphrase: "Test SDF Network ; September 2015",
    });
    mockCaps.describeNetworkMismatch.mockReturnValue(
      "Your wallet is connected to a different network."
    );

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument()
    );
    expect(screen.getByText(/different network/i)).toBeInTheDocument();
  });

  it("network mismatch alert has aria-live polite", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);
    mockCaps.detectWalletCapabilities.mockReturnValue({
      installed: true, canConnect: true, canSignTransaction: true,
      canGetNetwork: true, canWatchChanges: false,
    });
    mockCaps.checkNetworkMismatch.mockResolvedValue({
      kind: "mismatch",
      detectedPassphrase: "Public Global Stellar Network ; September 2015",
      configuredPassphrase: "Test SDF Network ; September 2015",
    });
    mockCaps.describeNetworkMismatch.mockReturnValue("Wrong network detected.");

    render(<WalletButton />);
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("aria-live", "polite");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Not-installed state
// ─────────────────────────────────────────────────────────────────────────────

describe("WalletButton — not_installed state", () => {
  it("renders install link pointing to freighter.app", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(false);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    render(<WalletButton />);
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /install freighter/i });
      expect(link).toHaveAttribute("href", "https://freighter.app");
    });
  });

  it("install link opens in a new tab with noopener", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(false);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    render(<WalletButton />);
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /install freighter/i });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connecting flow
// ─────────────────────────────────────────────────────────────────────────────

describe("WalletButton — connecting flow", () => {
  it("shows connecting spinner then connected address on success", async () => {
    const addr = "G" + "B".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockResolvedValue(addr);

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(screen.getByText("GBBB…BBBB")).toBeInTheDocument()
    );
  });

  it("shows error message when permission denied", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("permission_denied", "Wallet access was denied.")
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(screen.getByText(/wallet access was denied/i)).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /retry connection/i })).toBeInTheDocument();
  });

  it("transitions to not_installed when connect throws not_installed", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("not_installed", "Freighter not installed.")
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /install freighter/i })).toBeInTheDocument()
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Account change / disconnect (provider events)
// ─────────────────────────────────────────────────────────────────────────────

describe("WalletButton — account change and disconnect", () => {
  it("re-resolves to idle when account changes and wallet is disconnected", async () => {
    const addr = "G" + "C".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress
      .mockResolvedValueOnce(addr)
      .mockResolvedValueOnce(null);

    let accountChangedCallback: (() => void) | null = null;
    const providerMock = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "accountChanged") accountChangedCallback = cb;
      }),
      removeEventListener: vi.fn(),
    };
    (window as any).freighter = providerMock;

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GCCC…CCCC")).toBeInTheDocument()
    );

    await act(async () => { accountChangedCallback?.(); });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /connect freighter/i })).toBeInTheDocument()
    );
    delete (window as any).freighter;
  });

  it("re-resolves to new address when account switches", async () => {
    const addr1 = "G" + "D".repeat(55);
    const addr2 = "G" + "E".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress
      .mockResolvedValueOnce(addr1)
      .mockResolvedValueOnce(addr2);

    let accountChangedCallback: (() => void) | null = null;
    const providerMock = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "accountChanged") accountChangedCallback = cb;
      }),
      removeEventListener: vi.fn(),
    };
    (window as any).freighter = providerMock;

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GDDD…DDDD")).toBeInTheDocument()
    );

    await act(async () => { accountChangedCallback?.(); });

    await waitFor(() =>
      expect(screen.getByText("GEEE…EEEE")).toBeInTheDocument()
    );
    delete (window as any).freighter;
  });

  it("removes event listeners on unmount", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    const removeEventListener = vi.fn();
    const providerMock = { addEventListener: vi.fn(), removeEventListener };
    (window as any).freighter = providerMock;

    const { unmount } = render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /connect freighter/i })).toBeInTheDocument()
    );

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith("accountChanged", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("networkChanged", expect.any(Function));
    delete (window as any).freighter;
  });

  it("does not update state after unmount when probe resolves late", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockReturnValue(new Promise(() => {}));

    const { unmount } = render(<WalletButton />);
    unmount(); // no error expected
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Changing state
// ─────────────────────────────────────────────────────────────────────────────

describe("WalletButton — changing state", () => {
  it("shows Updating spinner during the changing transition", async () => {
    const addr = "G" + "F".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress
      .mockResolvedValueOnce(addr)
      .mockReturnValueOnce(new Promise(() => {}));

    let accountChangedCallback: (() => void) | null = null;
    const providerMock = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "accountChanged") accountChangedCallback = cb;
      }),
      removeEventListener: vi.fn(),
    };
    (window as any).freighter = providerMock;

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GFFF…FFFF")).toBeInTheDocument()
    );

    act(() => { accountChangedCallback?.(); });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /updating/i })).toBeInTheDocument()
    );
    delete (window as any).freighter;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Accessibility
// ─────────────────────────────────────────────────────────────────────────────

describe("WalletButton — accessibility", () => {
  it("button carries aria-busy=true during connecting", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockReturnValue(new Promise(() => {}));

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /connecting/i })).toHaveAttribute("aria-busy", "true")
    );
  });

  it("error message has aria-live polite region", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("unknown", "Unexpected failure")
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() => {
      const live = document.querySelector("[aria-live='polite']");
      expect(live).toBeInTheDocument();
    });
  });

  it("retry button has a visible focus ring class", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("permission_denied", "Denied.")
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() => {
      const retryBtn = screen.getByRole("button", { name: /retry connection/i });
      expect(retryBtn.className).toMatch(/focus-visible/);
    });
  });
});
