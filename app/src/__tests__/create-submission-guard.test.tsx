/**
 * CreateClient — in-flight submission guard and timeout reconciliation tests.
 *
 * Coverage:
 *   - Rapid double-click: second submit is dropped while first is in-flight.
 *   - Wallet rejection (WALLET_REJECTED): error shown, form re-enabled, no navigation.
 *   - Confirmed success: txHash set, navigation scheduled, submit locked.
 *   - Timeout with hash: reconciliation panel shown, submit locked, reset unlocks.
 *   - Timeout without hash: treated as a regular error (no reconciliation panel).
 *   - Navigation only on confirmed success — never on timeout or other failures.
 *   - invokeContract called at most once per user intent.
 *
 * Strategy:
 *   These tests render the full CreateClient component against mocked
 *   @/lib/stellar and next/navigation. Every test that exercises the submit
 *   path fills in the minimum valid form fields first, then fires the button.
 *
 * Runner: vitest + @testing-library/react (jsdom)
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

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

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MEMBER_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MEMBER_B = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPCIB";
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
async function fillValidForm() {
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
  const memberInputs = screen.getAllByRole("textbox", { name: /member \d+ of \d+ — stellar address/i });
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
  });

  // ── Rapid double-click ──────────────────────────────────────────────────────

  it("drops a second submit while the first is still in-flight", async () => {
    // invokeContract hangs — simulates slow wallet/RPC
    let resolveFirst!: (v: typeof successResult) => void;
    mockInvokeContract.mockReturnValueOnce(
      new Promise<typeof successResult>((res) => { resolveFirst = res; }),
    );

    render(<CreateClient />);
    const submit = await fillValidForm();

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
    const submit = await fillValidForm();

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
    await fillValidForm();

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
    const submit = await fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });
  });

  it("displays the transaction hash in the success panel", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    const submit = await fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    });
  });

  it("submit is locked after confirmed success", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    const submit = await fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });

    expect(submit).toBeDisabled();
  });

  it("does not show the reconciliation panel on confirmed success", async () => {
    mockInvokeContract.mockResolvedValue(successResult);

    render(<CreateClient />);
    await fillValidForm();
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
    const submit = await fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });

    expect(mockInvokeContract).toHaveBeenCalledTimes(1);
  });

  // ── Wallet rejection ────────────────────────────────────────────────────────

  it("shows a cancellation error on wallet rejection", async () => {
    mockInvokeContract.mockResolvedValue(walletRejected);

    render(<CreateClient />);
    const submit = await fillValidForm();
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
    const submit = await fillValidForm();
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
    await fillValidForm();
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
    await fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/confirmation timed out/i),
    ).not.toBeInTheDocument();
  });

  // ── Timeout with hash (reconciliation path) ─────────────────────────────────

  it("shows the reconciliation panel when timeout includes a txHash", async () => {
    mockInvokeContract.mockResolvedValue(timeoutWithHash);

    render(<CreateClient />);
    await fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(/confirmation timed out/i)).toBeInTheDocument();
    });
  });

  it("shows the timed-out txHash in the reconciliation panel", async () => {
    mockInvokeContract.mockResolvedValue(timeoutWithHash);

    render(<CreateClient />);
    await fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    });
  });

  it("submit is locked while reconciliation panel is visible", async () => {
    mockInvokeContract.mockResolvedValue(timeoutWithHash);

    render(<CreateClient />);
    const submit = await fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/confirmation timed out/i)).toBeInTheDocument();
    });

    expect(submit).toBeDisabled();
  });

  it("does not navigate on timeout", async () => {
    mockInvokeContract.mockResolvedValue(timeoutWithHash);

    render(<CreateClient />);
    await fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(/confirmation timed out/i)).toBeInTheDocument();
    });

    // No success panel means no navigation was triggered
    expect(screen.queryByText(/circle created successfully/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/redirecting/i)).not.toBeInTheDocument();
  });

  it("shows an explorer link in the reconciliation panel", async () => {
    mockInvokeContract.mockResolvedValue(timeoutWithHash);

    render(<CreateClient />);
    await fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByText(/confirmation timed out/i)).toBeInTheDocument();
    });

    const explorerLinks = screen.getAllByRole("link", { name: /stellar expert/i });
    expect(explorerLinks.length).toBeGreaterThanOrEqual(1);
    expect(explorerLinks[0]).toHaveAttribute(
      "href",
      expect.stringContaining(TX_HASH),
    );
  });

  it("reset button unlocks submit and clears reconciliation panel", async () => {
    mockInvokeContract.mockResolvedValue(timeoutWithHash);

    render(<CreateClient />);
    const submit = await fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/confirmation timed out/i)).toBeInTheDocument();
    });

    // Click the "I've checked" reset button
    const resetBtn = screen.getByRole("button", {
      name: /i.ve checked.*did not confirm/i,
    });
    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(
        screen.queryByText(/confirmation timed out/i),
      ).not.toBeInTheDocument();
    });

    // Submit should be re-enabled
    expect(submit).not.toBeDisabled();
  });

  it("allows a fresh submit after timeout reset", async () => {
    mockInvokeContract
      .mockResolvedValueOnce(timeoutWithHash)
      .mockResolvedValueOnce(successResult);

    render(<CreateClient />);
    const submit = await fillValidForm();

    // First submit — times out
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.getByText(/confirmation timed out/i)).toBeInTheDocument();
    });

    // User acknowledges and resets
    fireEvent.click(
      screen.getByRole("button", { name: /i.ve checked.*did not confirm/i }),
    );
    await waitFor(() => {
      expect(screen.queryByText(/confirmation timed out/i)).not.toBeInTheDocument();
    });

    // Second submit — succeeds
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.getByText(/circle created successfully/i)).toBeInTheDocument();
    });

    // invokeContract must have been called exactly twice — no duplicates
    expect(mockInvokeContract).toHaveBeenCalledTimes(2);
  });

  // ── Timeout without hash ────────────────────────────────────────────────────

  it("shows a regular error (not reconciliation) when timeout has no txHash", async () => {
    mockInvokeContract.mockResolvedValue(timeoutNoHash);

    render(<CreateClient />);
    await fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Reconciliation panel must NOT appear — there is no hash to reconcile
    expect(
      screen.queryByText(/confirmation timed out/i),
    ).not.toBeInTheDocument();
  });

  it("re-enables submit when timeout has no txHash", async () => {
    mockInvokeContract.mockResolvedValue(timeoutNoHash);

    render(<CreateClient />);
    const submit = await fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(submit).not.toBeDisabled();
  });

  // ── Generic failure ─────────────────────────────────────────────────────────

  it("shows a generic error on non-timeout failure", async () => {
    mockInvokeContract.mockResolvedValue(genericFailure);

    render(<CreateClient />);
    const submit = await fillValidForm();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(submit).not.toBeDisabled();
  });

  it("does not navigate on generic failure", async () => {
    mockInvokeContract.mockResolvedValue(genericFailure);

    render(<CreateClient />);
    await fillValidForm();
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
    await fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /connect your freighter wallet/i,
      );
    });

    expect(mockInvokeContract).not.toHaveBeenCalled();
  });
});
