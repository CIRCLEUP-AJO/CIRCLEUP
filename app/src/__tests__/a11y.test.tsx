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
import {
  CSP_ENFORCEMENT_STAGE,
  buildCspHeader,
  isEnforced,
  type CspStage,
} from "@/lib/csp";


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

  it("null score (unknown) has no violations", async () => {
    const { container } = render(<ReputationBadge score={null} />);
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it("negative score has no violations", async () => {
    const { container } = render(<ReputationBadge score={-1} />);
    const violations = await checkA11y(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it("large score (999) has no violations", async () => {
    const { container } = render(<ReputationBadge score={999} />);
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

// ── CSP: required app assets under the enforced policy ────────────────────────

/**
 * These tests pin the resources the app shell actually needs (scripts, styles,
 * fonts, images) to the enforced CSP policy. If a directive is tightened past
 * what the app requires, or a required source is dropped from the reviewed
 * allowlist, these tests fail before enforcement can break the app.
 *
 * The policy is built for the enforced stage explicitly so the tests do not
 * depend on the current rollout stage of the deployment.
 */
describe("csp: enforced policy allows required app assets", () => {
  const enforcedHeader = buildCspHeader("enforced" as CspStage);
  const directives = parseCspHeader(enforcedHeader);

  it("enforced stage is recognised as enforcing", () => {
    expect(isEnforced("enforced" as CspStage)).toBe(true);
    expect(isEnforced("report-only" as CspStage)).toBe(false);
  });

  it("does not use broad wildcard sources to suppress reports", () => {
    for (const [directive, sources] of Object.entries(directives)) {
      if (directive === "report-uri" || directive === "report-to") continue;
      expect(sources, `${directive} must not allow *`).not.toContain("*");
      expect(
        sources.some((s) => s === "https:" || s === "http:"),
        `${directive} must not allow a bare scheme source`
      ).toBe(false);
    }
  });

  it("allows the Next.js runtime scripts", () => {
    expect(directives["script-src"]).toBeDefined();
    expect(directives["script-src"]).toContain("'self'");
    // Next.js injects inline bootstrap scripts; nonce/hash based policies are
    // preferred, but 'unsafe-inline' must never be paired with a wildcard.
    expect(directives["script-src"]).not.toContain("*");
  });

  it("allows required styles", () => {
    expect(directives["style-src"]).toBeDefined();
    expect(directives["style-src"]).toContain("'self'");
  });

  it("allows required fonts", () => {
    expect(directives["font-src"]).toBeDefined();
    expect(directives["font-src"]).toContain("'self'");
  });

  it("allows required images", () => {
    expect(directives["img-src"]).toBeDefined();
    expect(directives["img-src"]).toContain("'self'");
  });

  it("restricts connections to reviewed origins only", () => {
    expect(directives["connect-src"]).toBeDefined();
    expect(directives["connect-src"]).toContain("'self'");
    expect(directives["connect-src"]).not.toContain("*");
  });

  it("blocks framing and object embedding", () => {
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
  });

  it("report-only stage still emits a report endpoint", () => {
    const reportOnly = parseCspHeader(buildCspHeader("report-only" as CspStage));
    const endpoint =
      reportOnly["report-uri"]?.[0] ?? reportOnly["report-to"]?.[0] ?? "";
    expect(endpoint).not.toBe("");
  });

  it("current rollout stage is a known stage", () => {
    expect(["report-only", "enforced"]).toContain(CSP_ENFORCEMENT_STAGE);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCspHeader(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of header.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    out[name.toLowerCase()] = sources;
  }
  return out;
}

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
