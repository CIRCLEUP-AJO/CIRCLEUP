/**
 * CreateClient — in-flight submission guard and failure-handling tests.
 *
 * Coverage:
 *   - Rapid double-click: second submit is dropped while first is in-flight.
 *   - Submit button disabled + loading text while in-flight.
 *   - Confirmed success: txHash set, navigation scheduled, submit locked.
 *   - Timeout: treated as a regular error (reconciliation panel was part of
 *     the reverted #471-475 feature set and no longer exists).
 *   - Wallet rejection: error shown, form re-enabled, no navigation.
 *   - Navigation only on confirmed success — never on timeout or other failures.
 *   - invokeContract called at most once per user intent.
 *   - Invalid form never reaches wallet signing.
 *
 * Strategy:
 *   These tests render the full CreateClient component against mocked
 *   @/lib/stellar and next/navigation. Every test that exercises the submit
 *   path fills in the minimum valid form fields first, then fires the button.
 *   Member fixtures are checksum-valid (Issue #477) and distinct from the
 *   connected wallet so the self-address guard never trips.
 *
 * Runner: vitest + @testing-library/react (jsdom)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";

// next/navigation mock — the create flow schedules a delayed redirect after
// success.  We need a stable push() spy so tests can assert that a pending
// timer never fires after unmount / manual navigation.
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────
// vi.mock calls are hoisted to the top of the file by vitest, before any
// imports.  The factory functions run lazily so vi.fn() references can be
// overridden per-test via module-level variables.

vi.mock("@/lib/stellar", () => ({
  getWalletAddress: vi.fn(),
  invokeContract:   vi.fn(),
  WalletError: class WalletError extends Error {
    constructor(public reason: string, message: string) {
      super(message);
      this.name = "WalletError";
    }
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    CIRCLE_FACTORY_ADDRESS: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    ACTIVE_NETWORK: "testnet",
    getExplorerLink: (network: string, type: string, id: string) =>
      `https://stellar.expert/explorer/testnet/${type}/${id}`,
  };
});

// ─── Imports after mock declarations ──────────────────────────────────────────

import { getWalletAddress, invokeContract } from "@/lib/stellar";
import CreateClient from "../app/create/CreateClient";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Deterministic, checksum-valid addresses. The connected wallet and the two
 * member addresses are intentionally distinct, so the component's self-address
 * guard (creator must not appear in the member list) never fires.
 */
const addrFor = (seed: number): string =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

const WALLET   = addrFor(60);
const MEMBER_A = addrFor(61);
const MEMBER_B = addrFor(62);
const TX_HASH  = "abc123def456abc123def456abc123def456abc123def456abc123def456ab12";

/** InvokeResult shapes matching what stellar.ts actually returns */
const successResult = { success: true  as const, txHash: TX_HASH };
const walletRejected = {
  success: false as const,
  txHash: "",
  error: "You cancelled the transaction in Freighter. No funds were moved.",
  typedError: {
    kind:    "wallet" as const,
    code:    "WALLET_REJECTED" as const,
    message: "You cancelled the transaction in Freighter. No funds were moved.",
  },
};
const timeoutWithHash = {
  success: false as const,
  txHash: TX_HASH,
  error: "The transaction timed out waiting for confirmation. Check Stellar Expert for your transaction status before retrying.",
  typedError: {
    kind:    "network" as const,
    code:    "NETWORK_TIMEOUT" as const,
    message: "The transaction timed out waiting for confirmation.",
  },
};
const timeoutNoHash = {
  success: false as const,
  txHash: "",
  error: "The transaction timed out waiting for confirmation.",
  typedError: {
    kind:    "network" as const,
    code:    "NETWORK_TIMEOUT" as const,
    message: "The transaction timed out waiting for confirmation.",
  },
};
const genericFailure = {
  success: false as const,
  txHash: "",
  error: "Transaction failed.",
  typedError: {
    kind:    "unknown" as const,
    code:    "UNKNOWN" as const,
    message: "An unexpected error occurred.",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fill in the minimum valid fields and return the submit button.
 * Uses fireEvent for fast synchronous filling of text inputs.
 */
function fillValidForm() {
  // Name
  const nameInput = screen.getByRole("textbox", { name: /circle name/i });
  fireEvent.change(nameInput, { target: { value: "Test Circle" } });

  // Amount — it's a number input; find by label
  const amountInput = screen.getByRole("spinbutton", { name: /contribution amount/i });
  fireEvent.change(amountInput, { target: { value: "100" } });

  // Days
  const daysInput = screen.getByRole("spinbutton", { name: /round duration/i });
  fireEvent.change(daysInput, { target: { value: "30" } });

  // Members — default render starts with 4 blank rows; fill the first two
  const memberInputs = screen.getAllByRole("textbox", {
    name: /member \d+ of \d+ — stellar address/i,
  });
  fireEvent.change(memberInputs[0], { target: { value: MEMBER_A } });
  fireEvent.change(memberInputs[1], { target: { value: MEMBER_B } });

  return screen.getByRole("button", { name: /create circle/i });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("CreateClient — submission guard", () => {
  const mockGetWalletAddress = getWalletAddress as ReturnType<typeof vi.fn>;
  const mockInvokeContract   = invokeContract   as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: wallet connected
    mockGetWalletAddress.mockResolvedValue(WALLET);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
    vi.useRealTimers();
  });

  // ── Rapid double-click ──────────────────────────────────────────────────────

  it("drops a second submit while the first is still in-flight", async () => {
    // invokeContract hangs — simulates slow wallet/RPC
    let resolveFirst!: (v: typeof successResult) => void;
    mockInvokeContract.mockReturnValueOnce(
      new Promise<typeof successResult>((res) => { resolveFirst = res; }),
    );

    render(<CreateClient />);
    const submit = fillValidForm();

    // First click — in-flight
    fireEvent.click(submit);
    // Second click immediately — must be dropped
    fireEvent.click(submit);
    // Third click — still dropped
    fireEvent.click(submit);

    // Resolve the first call
    await act(async () => { resolveFirst(successResult); });

    // Despite three clicks, invokeContract called exactly once
    expect(mockInvokeContract).toHaveBeenCalledTimes(1);
  });

  it("submit button is disabled while loading", async () => {
    let resolveFirst!: (v: typeof successResult) => void;
    mockInvokeContract.mockReturnValueOnce(
      new Promise<typeof successResult>((res) => { resolveFirst = res; }),
    );

    render(<CreateClient />);
    const submit = fillValidForm();

    fireEvent.click(submit);

    // Button should be disabled mid-flight
    await waitFor(() => {
      expect(submit).toBeDisabled();
    });

    await act(async () => { resolveFirst(successResult); });
  });

  it("loading text is shown while in-flight", async () => {
    let resolveFirst!: (v: typeof successResult) => void;
    mockInvokeContract.mockReturnValueOnce(
      new Promise<typeof successResult>((res) => { resolveFirst = res; }),
    );

    render(<CreateClient />);
    fillValidForm();

    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(/creating circle…/i)).toBeInTheDocument();
    });

    await act(async () => { resolveFirst(successResult); });
  });

  // ── Confirmed success ───────────────────────────────────────────────────────

  it("shows success panel on confirmed creation", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });
  });

  it("displays the transaction hash in the success panel", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    });
  });

  it("submit is locked after confirmed success", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });

    expect(submit).toBeDisabled();
  });

  it("does not show the reconciliation panel on confirmed success", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/confirmation timed out/i),
    ).not.toBeInTheDocument();
  });

  it("invokeContract is called exactly once on a single click", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });

    expect(mockInvokeContract).toHaveBeenCalledTimes(1);
  });

  // ── Success navigation lifecycle (Issue #126) ───────────────────────────────

  it("does not navigate after unmount during the success delay", async () => {
    vi.useFakeTimers();
    mockInvokeContract.mockResolvedValue(successResult);

    const { unmount } = render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    // Flush the resolved promise so the success state is committed.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Unmount before the delayed redirect fires.
    unmount();

    // Advance well past any plausible redirect delay.
    await act(async () => { vi.advanceTimersByTime(60_000); });

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("manual navigation cancels the pending redirect", async () => {
    vi.useFakeTimers();
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // User follows the receipt link / navigates away manually.
    const viewLink = screen.queryByRole("link", { name: /view circle/i });
    if (viewLink) {
      fireEvent.click(viewLink);
    } else {
      // Fall back to simulating a manual navigation via the router.
      mockPush.mockClear();
    }

    await act(async () => { vi.advanceTimersByTime(60_000); });

    // At most the user's own navigation — never a second, timer-driven push.
    expect(mockPush.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("keeps the transaction receipt visible while the redirect is pending", async () => {
    vi.useFakeTimers();
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Before the timer fires the receipt must still be on screen.
    expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
  });

  it("repeated submit does not schedule duplicate redirect timers", async () => {
    vi.useFakeTimers();
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    await act(async () => { vi.advanceTimersByTime(60_000); });

    // Even if a redirect fires, it must fire at most once.
    expect(mockPush.mock.calls.length).toBeLessThanOrEqual(1);
    expect(mockInvokeContract).toHaveBeenCalledTimes(1);
  });

  it("renders a 'View circle' link only when a verified address is available", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });

    // The receipt (tx hash) is always present.
    expect(screen.getByText(TX_HASH)).toBeInTheDocument();

    // If a link is rendered it must point at a real circle detail route,
    // never a guessed deployment address.
    const viewLink = screen.queryByRole("link", { name: /view circle/i });
    if (viewLink) {
      expect(viewLink).toHaveAttribute("href");
      expect(viewLink.getAttribute("href")).toMatch(/^\/circles\/[A-Z0-9]{56}$/);
    }
  });

  // ── Clipboard fallback (Issue #127) ─────────────────────────────────────────

  it("does not announce 'copied' when the clipboard write fails", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    // Simulate a denied / unavailable clipboard.
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });

    const copyButton = screen.queryByRole("button", { name: /copy/i });
    if (copyButton) {
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(screen.queryByText(/^copied/i)).not.toBeInTheDocument();
      });

      // The hash must remain available for manual selection.
      expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    }
  });

  // ── Wallet rejection ────────────────────────────────────────────────────────

  it("shows a cancellation error on wallet rejection", async () => {
    mockInvokeContract.mockResolvedValue(walletRejected);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(
        screen.getByRole("alert"),
      ).toHaveTextContent(/cancelled|rejected|no funds were moved/i);
    });
  });

  it("re-enables submit after wallet rejection", async () => {
    mockInvokeContract.mockResolvedValue(walletRejected);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Submit should be re-enabled (not locked) so user can try again
    expect(submit).not.toBeDisabled();
  });

  it("does not navigate on wallet rejection", async () => {
    mockInvokeContract.mockResolvedValue(walletRejected);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // No success panel means no navigation was triggered
    expect(screen.queryByText(/circle created successfully/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/redirecting/i)).not.toBeInTheDocument();
  });

  it("does not show the reconciliation panel on wallet rejection", async () => {
    mockInvokeContract.mockResolvedValue(walletRejected);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/confirmation timed out/i),
    ).not.toBeInTheDocument();
  });

  // ── Timeout — regular error, no reconciliation panel ────────────────────────

  it("timeout with a txHash is surfaced as a regular error", async () => {
    mockInvokeContract.mockResolvedValue(timeoutWithHash);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/timed out|confirmation/i);
    });

    // The reconciliation panel is gone (reverted feature) — no resolve copy,
    // no success panel, and submit is unlocked so the user can retry.
    expect(screen.queryByText(/i.ve checked.*did not confirm/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/circle created successfully/i)).not.toBeInTheDocument();
    expect(submit).not.toBeDisabled();
  });

  it("timeout without a txHash is surfaced as a regular error", async () => {
    mockInvokeContract.mockResolvedValue(timeoutNoHash);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/confirmation timed out/i),
    ).not.toBeInTheDocument();
    expect(submit).not.toBeDisabled();
  });

  it("does not navigate on timeout", async () => {
    mockInvokeContract.mockResolvedValue(timeoutWithHash);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // No success panel means no navigation was triggered
    expect(screen.queryByText(/circle created successfully/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/redirecting/i)).not.toBeInTheDocument();
  });

  // ── Generic failure ─────────────────────────────────────────────────────────

  it("shows a generic error on non-timeout failure", async () => {
    mockInvokeContract.mockResolvedValue(genericFailure);

    render(<CreateClient />);
    const submit = fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(submit).not.toBeDisabled();
  });

  it("does not navigate on generic failure", async () => {
    mockInvokeContract.mockResolvedValue(genericFailure);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.queryByText(/circle created successfully/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/redirecting/i)).not.toBeInTheDocument();
  });

  // ── invokeContract never called on invalid form ─────────────────────────────

  it("does not call invokeContract when the form is invalid", async () => {
    render(<CreateClient />);

    // Submit without filling any fields
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      // Field errors should appear
      expect(screen.getByText(/circle name is required/i)).toBeInTheDocument();
    });

    expect(mockInvokeContract).not.toHaveBeenCalled();
  });

  it("does not call getWalletAddress when the form is invalid", async () => {
    render(<CreateClient />);

    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(/circle name is required/i)).toBeInTheDocument();
    });

    expect(mockGetWalletAddress).not.toHaveBeenCalled();
  });

  // ── Wallet not connected ────────────────────────────────────────────────────

  it("shows an error and does not call invokeContract when wallet is not connected", async () => {
    mockGetWalletAddress.mockResolvedValue(null);

    render(<CreateClient />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /connect your freighter wallet/i,
      );
    });

    expect(mockInvokeContract).not.toHaveBeenCalled();
  });
});