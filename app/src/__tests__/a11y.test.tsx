/**
 * Automated accessibility checks for primary UI components and states.
 *
 * Rules checked: axe-core "wcag2a" and "wcag2aa" rulesets, which cover
 * labels, landmarks, colour-contrast alternatives, focus order, and
 * duplicate IDs. Each component state (loading, error, empty, success)
 * is exercised separately so regressions are pinned to a specific state.
 *
 * Manual checks required (not automatable):
 *  - Freighter wallet prompt focus trap and keyboard dismissal
 *  - Screen reader announcement order in multi-step transaction flow
 *  - High-contrast mode rendering of brand-colour elements
 *  - Touch target size for mobile wallet actions (min 44 × 44 CSS px)
 *  - Meaningful focus-visible ring visibility across browser themes
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import axe from "axe-core";

// ── Shared mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/stellar", () => {
  class WalletError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  }
  return {
    WalletError,
    isFreighterInstalled: vi.fn().mockReturnValue(false),
    getWalletAddress: vi.fn().mockResolvedValue(null),
    connectWallet: vi.fn(),
  };
});

vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) =>
    addr && addr.length >= 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr,
  formatUsdc: (stroops: bigint) => {
    const whole = stroops / 10_000_000n;
    const frac = (stroops % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
    return `${whole}.${frac}`;
  },
  formatPot: (stroops: bigint, count: number) => {
    const total = stroops * BigInt(count);
    const whole = total / 10_000_000n;
    const frac = (total % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
    return `${whole}.${frac}`;
  },
  CIRCLE_FACTORY_ADDRESS: "",
  REPUTATION_ADDRESS: "",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className, "aria-label": ariaLabel }: any) => (
    <a href={href} className={className} aria-label={ariaLabel}>{children}</a>
  ),
}));

// ── axe helper ────────────────────────────────────────────────────────────────

const AXE_CONFIG: axe.RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
};

async function checkA11y(container: HTMLElement) {
  const results = await axe.run(container, AXE_CONFIG);
  return results.violations;
}

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { WalletButton } from "@/components/WalletButton";
import { CircleCard, type Circle } from "@/components/CircleCard";
import { ReputationBadge, ReputationLegend } from "@/components/ReputationBadge";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const activeCircle: Circle = {
  address: "CCIRCLE111111111111111111111111111111111111111111111111111",
  creator: "GCREATOR11111111111111111111111111111111111111111111111111",
  round_amount: "100000000",
  member_count: 4,
  status: "Active",
  current_round: 3,
  total_rounds: 8,
  created_ledger: 1000,
};

// ── WalletButton ──────────────────────────────────────────────────────────────

describe("a11y: WalletButton", () => {
  it("not_installed state has no violations", async () => {
    const { container } = render(<WalletButton />);
    // Wait for the useEffect to settle
    await new Promise((r) => setTimeout(r, 0));
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});

// ── CircleCard ────────────────────────────────────────────────────────────────

describe("a11y: CircleCard", () => {
  it.each([
    ["Active", "Active"],
    ["Pending", "Pending"],
    ["Completed", "Completed"],
    ["Cancelled", "Cancelled"],
  ])("%s status has no violations", async (_label, status) => {
    const { container } = render(<CircleCard circle={{ ...activeCircle, status }} />);
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it("zero total_rounds (no progress bar) has no violations", async () => {
    const { container } = render(
      <CircleCard circle={{ ...activeCircle, total_rounds: 0, current_round: 0 }} />
    );
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});

// ── ReputationBadge ───────────────────────────────────────────────────────────

describe("a11y: ReputationBadge", () => {
  it.each([
    ["sm", 0],
    ["md", 5],
    ["lg", 10],
  ] as const)("size=%s score=%i has no violations", async (size, score) => {
    const { container } = render(<ReputationBadge score={score} size={size} />);
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});

// ── ReputationLegend ──────────────────────────────────────────────────────────

describe("a11y: ReputationLegend", () => {
  it("legend table has no violations", async () => {
    const { container } = render(<ReputationLegend />);
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatViolations(violations: axe.Result[]): string {
  if (violations.length === 0) return "";
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.description}\n` +
        v.nodes.map((n) => `  selector: ${n.target.join(", ")}`).join("\n")
    )
    .join("\n\n");
}
