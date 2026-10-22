/**
 * DashboardClient component tests.
 *
 * Acceptance criteria:
 *   - wallet not_installed, disconnected, loading states show correct UI.
 *   - Connected wallet with no memberships shows empty state (distinct from error).
 *   - Connected wallet with memberships shows circle cards.
 *   - Indexer unavailable shows error, not empty state.
 *   - Switching/disconnecting wallet clears previous member's records.
 *   - Indexed data is labelled; wallet address is advisory only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import React from "react";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/stellar", () => ({
  getWalletAddress: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) =>
    addr && addr.length >= 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr,
  formatUsdc: (n: bigint) => (Number(n) / 10_000_000).toFixed(2),
  getExplorerLink: () => null,
  ACTIVE_NETWORK: "testnet",
  INDEXER_TIMEOUT_MS: 5000,
  indexerEndpoint: (segs: string[]) => `http://localhost:3001/${segs.join("/")}`,
}));

vi.mock("@/lib/address", () => ({
  isCanonicalStellarAddress: (addr: string) =>
    typeof addr === "string" && addr.startsWith("G") && addr.length === 56,
}));

import { DashboardClient } from "@/app/dashboard/DashboardClient";
import * as stellar from "@/lib/stellar";

const mockGetWallet = stellar.getWalletAddress as ReturnType<typeof vi.fn>;

const VALID_ADDRESS = "G" + "A".repeat(55);
const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function makeCircleRow(address = CONTRACT_A) {
  return {
    address,
    creator: VALID_ADDRESS,
    round_amount: "10000000",
    member_count: 4,
    status: "Active",
    current_round: 1,
    total_rounds: 4,
    created_ledger: 100,
    updated_at: "2024-01-01T00:00:00Z",
    deadline_ledger: null,
  };
}

const originalFetch = global.fetch;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

// ─── Wallet not installed ─────────────────────────────────────────────────────

describe("DashboardClient — wallet not installed", () => {
  it("shows install guidance when wallet throws not_installed", async () => {
    mockGetWallet.mockRejectedValue(new Error("not_installed"));
    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByText(/freighter not installed/i)).toBeInTheDocument();
    });
  });

  it("shows freighter.app link when not installed", async () => {
    mockGetWallet.mockRejectedValue(new Error("not_installed"));
    render(<DashboardClient />);
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /freighter wallet/i });
      expect(link).toHaveAttribute("href", "https://freighter.app");
    });
  });
});

// ─── Wallet disconnected ──────────────────────────────────────────────────────

describe("DashboardClient — wallet disconnected", () => {
  it("shows connect wallet prompt when getWalletAddress returns null", async () => {
    mockGetWallet.mockResolvedValue(null);
    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByText(/connect your wallet/i)).toBeInTheDocument();
    });
  });

  it("mentions address is session-only (no retention)", async () => {
    mockGetWallet.mockResolvedValue(null);
    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByText(/not stored/i)).toBeInTheDocument();
    });
  });
});

// ─── No memberships ───────────────────────────────────────────────────────────

describe("DashboardClient — connected, no memberships", () => {
  it("shows empty state (not error) for empty circles array", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    mockFetch(200, { circles: [], pagination: { total: 0, page: 1, totalPages: 1 } });

    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByText(/no circles found/i)).toBeInTheDocument();
    });
  });

  it("empty state links to browse all circles", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    mockFetch(200, { circles: [], pagination: { total: 0, page: 1, totalPages: 1 } });

    render(<DashboardClient />);
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /browse all circles/i });
      expect(link).toHaveAttribute("href", "/");
    });
  });
});

// ─── Many memberships ─────────────────────────────────────────────────────────

describe("DashboardClient — connected, with memberships", () => {
  it("shows circle cards for each circle", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    mockFetch(200, {
      circles: [makeCircleRow()],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });

    render(<DashboardClient />);
    await waitFor(() => {
      // The card links to the circle detail page
      const link = screen.getByRole("link", { name: /circle/i });
      expect(link).toHaveAttribute("href", `/circles/${CONTRACT_A}`);
    });
  });

  it("shows total count", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    mockFetch(200, {
      circles: [makeCircleRow()],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });

    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByText(/1 circle/i)).toBeInTheDocument();
    });
  });

  it("shows indexed data freshness label", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    mockFetch(200, {
      circles: [makeCircleRow()],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });

    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByText(/indexed/i)).toBeInTheDocument();
    });
  });
});

// ─── Indexer unavailable ──────────────────────────────────────────────────────

describe("DashboardClient — indexer unavailable", () => {
  it("shows error banner (not empty state) when indexer returns 503", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    mockFetch(503, {});

    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    // Must NOT show "no circles found" for an outage
    expect(screen.queryByText(/no circles found/i)).not.toBeInTheDocument();
  });

  it("shows network error when fetch throws", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));

    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("shows try again button in error state", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    mockFetch(503, {});

    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    });
  });
});

// ─── Wallet account change ────────────────────────────────────────────────────

describe("DashboardClient — wallet account change", () => {
  it("clears previous member data on account change event", async () => {
    const addr1 = VALID_ADDRESS;
    mockGetWallet
      .mockResolvedValueOnce(addr1)
      .mockResolvedValueOnce(null);

    mockFetch(200, {
      circles: [makeCircleRow()],
      pagination: { total: 1, page: 1, totalPages: 1 },
    });

    let accountChangedCb: (() => void) | null = null;
    const provider = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "accountChanged") accountChangedCb = cb;
      }),
      removeEventListener: vi.fn(),
    };
    (window as unknown as Record<string, unknown>).freighter = provider;

    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.queryByText(/no circles found/i) ?? screen.queryByRole("link", { name: /circle/i })).toBeTruthy();
    });

    // Simulate account change to disconnected
    await act(async () => {
      accountChangedCb?.();
    });

    // Should show connect wallet prompt, not previous member's data
    await waitFor(() => {
      expect(screen.getByText(/connect your wallet/i)).toBeInTheDocument();
    });

    try {
      delete (window as unknown as Record<string, unknown>).freighter;
    } catch { /* jsdom cleanup */ }
  });
});

// ─── Freshness advisory ───────────────────────────────────────────────────────

describe("DashboardClient — freshness advisory", () => {
  it("shows indexed data advisory note regardless of state", async () => {
    mockGetWallet.mockResolvedValue(VALID_ADDRESS);
    mockFetch(200, { circles: [], pagination: { total: 0, page: 1, totalPages: 1 } });

    render(<DashboardClient />);
    await waitFor(() => {
      expect(screen.getByRole("note")).toBeInTheDocument();
    });
  });
});
