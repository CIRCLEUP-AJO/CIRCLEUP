import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock @/lib/stellar so no Freighter or Stellar-SDK is exercised
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

// Mock @/lib/config to avoid env-var assertions at import time
vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`,
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  CIRCLE_FACTORY_ADDRESS: "",
  REPUTATION_ADDRESS: "",
  USDC_ADDRESS: "",
  INDEXER_URL: "http://localhost:3001",
}));

import { WalletButton } from "@/components/WalletButton";
import * as stellar from "@/lib/stellar";

const mockStellar = stellar as {
  isFreighterInstalled: ReturnType<typeof vi.fn>;
  getWalletAddress: ReturnType<typeof vi.fn>;
  connectWallet: ReturnType<typeof vi.fn>;
  WalletError: new (reason: string, msg: string) => Error & { reason: string };
};

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("WalletButton — connected state", () => {
  it("shows shortened address without a button", async () => {
    // 56-char G-address: G + 55 A's. shortAddress = "GAAA…AAAA"
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GAAA…AAAA")).toBeInTheDocument()
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

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
});

describe("WalletButton — connecting flow", () => {
  it("shows connecting spinner then connected address on success", async () => {
    // 56-char G-address: G + 55 B's. shortAddress = "GBBB…BBBB"
    const addr = "G" + "B".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockResolvedValue(addr);

    render(<WalletButton />);

    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await act(async () => {
      await userEvent.click(btn);
    });

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
    await act(async () => {
      await userEvent.click(btn);
    });

    await waitFor(() =>
      expect(screen.getByText(/wallet access was denied/i)).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /retry connection/i })).toBeInTheDocument();
  });
});

describe("WalletButton — accessibility", () => {
  it("button carries aria-busy during connecting", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    // Never resolves — keeps connecting state visible
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockReturnValue(new Promise(() => {}));

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });

    await act(async () => {
      await userEvent.click(btn);
    });

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
    await act(async () => {
      await userEvent.click(btn);
    });

    await waitFor(() => {
      const live = document.querySelector("[aria-live='polite']");
      expect(live).toBeInTheDocument();
    });
  });
});
