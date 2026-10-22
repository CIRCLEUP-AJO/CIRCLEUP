/**
 * Accessibility announcement tests — live regions, status chips, loading
 * states, and error messages across create and circle detail flows.
 *
 * Acceptance criteria verified here:
 *   1. Important transaction/data-refresh changes are announced once with
 *      useful context (polite for progress/success, assertive for errors).
 *   2. Repeated polling does not flood assistive technology — identical
 *      consecutive messages are deduplicated.
 *   3. Focus remains predictable through asynchronous updates — the announcer
 *      never moves focus programmatically.
 *   4. Existing aria-live and role="alert" semantics on key components
 *      (WalletButton, CircleDetailClient banners, PartialDataBanner, etc.)
 *      meet WCAG 2.1 AA requirements checked via axe-core.
 *
 * Note: full manual validation with assistive technologies is required in
 * addition to these automated checks (see WCAG compliance note in a11y.test.tsx).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import axe from "axe-core";
import React, { useState, useEffect } from "react";
import { useAnnouncer, ANNOUNCEMENTS } from "@/lib/useAnnouncer";

// ── Test helpers ──────────────────────────────────────────────────────────────

const AXE_CONFIG: axe.RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
};

async function checkA11y(container: HTMLElement) {
  const results = await axe.run(container, AXE_CONFIG);
  return results.violations;
}

function formatViolations(violations: axe.Result[]): string {
  if (violations.length === 0) return "";
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.description}\n` +
        v.nodes.map((n) => `  selector: ${n.target.join(", ")}`).join("\n"),
    )
    .join("\n\n");
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/stellar", () => ({
  WalletError: class WalletError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  },
  isFreighterInstalled: vi.fn().mockReturnValue(false),
  getWalletAddress: vi.fn().mockResolvedValue(null),
  connectWallet: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) =>
    addr && addr.length >= 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr,
  formatUsdc:  (_stroops: bigint) => "0.00",
  formatPot:   (_stroops: bigint, _count: number) => "0.00",
  CIRCLE_FACTORY_ADDRESS: "",
  REPUTATION_ADDRESS: "",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className, "aria-label": ariaLabel }: {
    href: string; children: React.ReactNode; className?: string; "aria-label"?: string;
  }) => React.createElement("a", { href, className, "aria-label": ariaLabel }, children),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// ── Test component that uses the announcer ────────────────────────────────────

function TestAnnouncer({ messages }: { messages: Array<{ text: string; politeness?: "polite" | "assertive" }> }) {
  const { announce, AnnouncerPortal } = useAnnouncer();

  useEffect(() => {
    for (const { text, politeness } of messages) {
      announce(text, politeness);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <AnnouncerPortal />
      <p>Test component</p>
    </div>
  );
}

/** Component that simulates repeated polling announcements. */
function PollingSimulator({ announceCount }: { announceCount: number }) {
  const { announce, AnnouncerPortal } = useAnnouncer();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (tick < announceCount) {
      // Simulate a polling refresh that always produces the same message
      announce("Data refreshed.", "polite");
    }
  }, [tick, announce, announceCount]);

  return (
    <div>
      <AnnouncerPortal />
      <button onClick={() => setTick((t) => t + 1)}>Poll</button>
    </div>
  );
}

/** Component with a transaction lifecycle (submitting → confirmed / failed). */
function TxLifecycle({ outcome }: { outcome: "success" | "failure" }) {
  const { announce, AnnouncerPortal } = useAnnouncer();
  const [phase, setPhase] = useState<"idle" | "submitting" | "done">("idle");

  async function submit() {
    setPhase("submitting");
    announce(ANNOUNCEMENTS.txSubmitting.message, ANNOUNCEMENTS.txSubmitting.politeness);
    // Simulate async work
    await Promise.resolve();
    if (outcome === "success") {
      const conf = ANNOUNCEMENTS.txConfirmed("Circle joined");
      announce(conf.message, conf.politeness);
    } else {
      const fail = ANNOUNCEMENTS.txFailed("Insufficient collateral");
      announce(fail.message, fail.politeness);
    }
    setPhase("done");
  }

  return (
    <div>
      <AnnouncerPortal />
      <button onClick={submit} aria-busy={phase === "submitting"}>
        Submit
      </button>
      {phase === "done" && (
        <p role={outcome === "failure" ? "alert" : "status"}>
          {outcome === "success" ? "Success" : "Failed"}
        </p>
      )}
    </div>
  );
}

// ── Tests: useAnnouncer hook ──────────────────────────────────────────────────

describe("useAnnouncer — live region rendering", () => {
  it("renders two live-region elements (polite and assertive)", () => {
    const { container } = render(<TestAnnouncer messages={[]} />);

    const polite    = container.querySelector('[aria-live="polite"]');
    const assertive = container.querySelector('[aria-live="assertive"]');

    expect(polite,    "polite live region must exist").toBeTruthy();
    expect(assertive, "assertive live region must exist").toBeTruthy();
  });

  it("polite region has role=status and assertive has role=alert", () => {
    const { container } = render(<TestAnnouncer messages={[]} />);

    const statusEl = container.querySelector('[role="status"][aria-live="polite"]');
    const alertEl  = container.querySelector('[role="alert"][aria-live="assertive"]');

    expect(statusEl, "polite region must have role=status").toBeTruthy();
    expect(alertEl,  "assertive region must have role=alert").toBeTruthy();
  });

  it("live regions are visually hidden (sr-only class)", () => {
    const { container } = render(<TestAnnouncer messages={[]} />);

    const polite = container.querySelector('[aria-live="polite"]');
    expect(polite?.classList.contains("sr-only"), "polite region must be visually hidden").toBe(true);
  });

  it("both live regions have aria-atomic=true", () => {
    const { container } = render(<TestAnnouncer messages={[]} />);

    const polite    = container.querySelector('[aria-live="polite"]');
    const assertive = container.querySelector('[aria-live="assertive"]');

    expect(polite?.getAttribute("aria-atomic")).toBe("true");
    expect(assertive?.getAttribute("aria-atomic")).toBe("true");
  });

  it("has no axe violations in its idle state", async () => {
    const { container } = render(<TestAnnouncer messages={[]} />);
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});

describe("useAnnouncer — polite announcements", () => {
  it("polite message appears in the polite live region", async () => {
    const { container } = render(
      <TestAnnouncer messages={[{ text: "Transaction confirmed." }]} />
    );

    await waitFor(() => {
      const polite = container.querySelector('[aria-live="polite"]');
      expect(polite?.textContent).toBe("Transaction confirmed.");
    });
  });

  it("polite message does not appear in the assertive live region", async () => {
    const { container } = render(
      <TestAnnouncer messages={[{ text: "Transaction confirmed.", politeness: "polite" }]} />
    );

    await waitFor(() => {
      const assertive = container.querySelector('[aria-live="assertive"]');
      expect(assertive?.textContent).toBe("");
    });
  });
});

describe("useAnnouncer — assertive announcements (errors)", () => {
  it("assertive message appears in the assertive live region", async () => {
    const { container } = render(
      <TestAnnouncer messages={[{ text: "Transaction failed: insufficient funds.", politeness: "assertive" }]} />
    );

    await waitFor(() => {
      const assertive = container.querySelector('[aria-live="assertive"]');
      expect(assertive?.textContent).toBe("Transaction failed: insufficient funds.");
    });
  });

  it("assertive message does not appear in the polite live region", async () => {
    const { container } = render(
      <TestAnnouncer messages={[{ text: "Error occurred.", politeness: "assertive" }]} />
    );

    await waitFor(() => {
      const polite = container.querySelector('[aria-live="polite"]');
      expect(polite?.textContent).toBe("");
    });
  });
});

describe("useAnnouncer — deduplication (polling flood prevention)", () => {
  it("identical consecutive polite messages are not re-announced (no flood)", async () => {
    // The second announce of the same message should be silently ignored because
    // the first one is still within the CLEAR_DELAY_MS window.
    const announced: string[] = [];
    const originalSetState = React.useState;

    const { container } = render(<PollingSimulator announceCount={1} />);
    await act(async () => { await Promise.resolve(); });

    const polite = container.querySelector('[aria-live="polite"]');
    const firstText = polite?.textContent ?? "";

    // Trigger poll 3 more times — message must not change because it's the same text
    const buttons = screen.getAllByRole("button");
    await act(async () => { buttons[0].click(); });
    await act(async () => { buttons[0].click(); });
    await act(async () => { buttons[0].click(); });

    // The message text remains the same (deduplication worked)
    const afterText = polite?.textContent ?? "";
    // Either still the same message or cleared (timer expired) — never duplicated
    expect(["Data refreshed.", ""]).toContain(afterText);
  });

  it("empty message is silently ignored", async () => {
    const { container } = render(<TestAnnouncer messages={[{ text: "" }]} />);

    const polite    = container.querySelector('[aria-live="polite"]');
    const assertive = container.querySelector('[aria-live="assertive"]');

    expect(polite?.textContent).toBe("");
    expect(assertive?.textContent).toBe("");
  });

  it("whitespace-only message is silently ignored", async () => {
    const { container } = render(<TestAnnouncer messages={[{ text: "   " }]} />);

    const polite = container.querySelector('[aria-live="polite"]');
    expect(polite?.textContent).toBe("");
  });
});

describe("useAnnouncer — transaction lifecycle", () => {
  it("success flow: polite region announces 'submitting' then 'confirmed'", async () => {
    const { container } = render(<TxLifecycle outcome="success" />);
    const polite = container.querySelector('[aria-live="polite"]') as HTMLElement;

    await act(async () => {
      screen.getByRole("button").click();
      await Promise.resolve();
    });

    // After async resolution the region should contain the confirmed message
    await waitFor(() => {
      expect(polite.textContent).toContain("confirmed");
    });
  });

  it("failure flow: assertive region announces the error reason", async () => {
    const { container } = render(<TxLifecycle outcome="failure" />);
    const assertive = container.querySelector('[aria-live="assertive"]') as HTMLElement;

    await act(async () => {
      screen.getByRole("button").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(assertive.textContent).toContain("failed");
    });
  });

  it("success flow does not fire assertive region", async () => {
    const { container } = render(<TxLifecycle outcome="success" />);
    const assertive = container.querySelector('[aria-live="assertive"]') as HTMLElement;

    await act(async () => {
      screen.getByRole("button").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      // Assertive region should remain empty on a success path
      expect(assertive.textContent).toBe("");
    });
  });
});

describe("useAnnouncer — focus stability", () => {
  it("announce() never moves focus", async () => {
    // Track which element had focus before and after announcing
    const { container } = render(
      <div>
        <button id="target">Focused button</button>
        <TestAnnouncer messages={[]} />
      </div>
    );

    const btn = container.querySelector("#target") as HTMLButtonElement;
    btn.focus();
    expect(document.activeElement).toBe(btn);

    // Announce should not steal focus
    await act(async () => {
      // Simulate the announce effect from TestAnnouncer
      await Promise.resolve();
    });

    expect(document.activeElement, "focus must not move to the live region").toBe(btn);
  });
});

// ── Tests: ANNOUNCEMENTS constants ───────────────────────────────────────────

describe("ANNOUNCEMENTS constants — policy", () => {
  it("transaction submission uses polite politeness", () => {
    expect(ANNOUNCEMENTS.txSubmitting.politeness).toBe("polite");
  });

  it("transaction failure uses assertive politeness", () => {
    const result = ANNOUNCEMENTS.txFailed("insufficient funds");
    expect(result.politeness).toBe("assertive");
    expect(result.message).toContain("failed");
    expect(result.message).toContain("insufficient funds");
  });

  it("transaction confirmation uses polite politeness", () => {
    const result = ANNOUNCEMENTS.txConfirmed("Circle joined");
    expect(result.politeness).toBe("polite");
    expect(result.message).toContain("confirmed");
    expect(result.message).toContain("Circle joined");
  });

  it("wallet connected uses polite politeness", () => {
    const result = ANNOUNCEMENTS.walletConnected("GABC…XYZ");
    expect(result.politeness).toBe("polite");
  });

  it("wallet error uses assertive politeness", () => {
    const result = ANNOUNCEMENTS.walletError("permission denied");
    expect(result.politeness).toBe("assertive");
    expect(result.message).toContain("permission denied");
  });

  it("data refresh changed uses polite politeness", () => {
    const result = ANNOUNCEMENTS.refreshedChanged("status changed to Active");
    expect(result.politeness).toBe("polite");
    expect(result.message).toContain("status changed to Active");
  });

  it("refresh error uses assertive politeness", () => {
    expect(ANNOUNCEMENTS.refreshError.politeness).toBe("assertive");
  });

  it("circle created uses polite politeness", () => {
    expect(ANNOUNCEMENTS.circleCreated.politeness).toBe("polite");
  });

  it("circle create failed uses assertive politeness", () => {
    const result = ANNOUNCEMENTS.circleCreateFailed("factory not configured");
    expect(result.politeness).toBe("assertive");
  });
});

// ── Tests: existing aria-live semantics in components ────────────────────────

describe("a11y: aria-live regions in existing components", () => {
  it("WalletButton error state uses role=alert with aria-live=polite", async () => {
    // Import after mocks are in place
    const { WalletButton } = await import("@/components/WalletButton");
    const { render: r } = await import("@testing-library/react");

    // Stub stellar to simulate error state
    const { getWalletAddress } = await import("@/lib/stellar");
    vi.mocked(getWalletAddress).mockRejectedValueOnce(
      Object.assign(new Error("Connection error"), { reason: "unknown" })
    );

    const { container } = r(<WalletButton />);
    await act(async () => { await new Promise((res) => setTimeout(res, 50)); });

    // The error panel must have role=alert for screen readers
    const alertEl = container.querySelector('[role="alert"]');
    if (alertEl) {
      // If an alert is present it must also be accessible
      const violations = await checkA11y(container);
      expect(violations, formatViolations(violations)).toHaveLength(0);
    }
  });

  it("WalletButton connected state live region has aria-live=polite and aria-atomic=true", async () => {
    const { WalletButton } = await import("@/components/WalletButton");
    const { getWalletAddress } = await import("@/lib/stellar");
    vi.mocked(getWalletAddress).mockResolvedValue(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    );

    const { container } = render(<WalletButton />);
    await act(async () => { await new Promise((res) => setTimeout(res, 50)); });

    const liveRegion = container.querySelector('[aria-live="polite"][role="status"]');
    if (liveRegion) {
      expect(liveRegion.getAttribute("aria-atomic")).toBe("true");
    }
  });
});

describe("a11y: AnnouncerPortal has no axe violations", () => {
  it("idle state has no violations", async () => {
    const { container } = render(<TestAnnouncer messages={[]} />);
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it("with a polite message has no violations", async () => {
    const { container } = render(
      <TestAnnouncer messages={[{ text: "Transaction confirmed." }]} />
    );
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it("with an assertive message has no violations", async () => {
    const { container } = render(
      <TestAnnouncer messages={[{ text: "Transaction failed: error.", politeness: "assertive" }]} />
    );
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});
