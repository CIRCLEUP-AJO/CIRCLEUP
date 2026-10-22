/**
 * JoinIntroBanner component tests.
 *
 * Acceptance criteria:
 *   - Each lifecycle status variant renders the correct heading.
 *   - The advisory note is always visible.
 *   - Prerequisites are shown only when joinAvailable=true.
 *   - Unmet prerequisites show setup guidance/links.
 *   - The component has a labeled section role for accessibility.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JoinIntroBanner } from "@/components/JoinIntroBanner";
import { buildJoinIntroContent } from "@/lib/joinIntro";
import type { JoinIntroInput } from "@/lib/joinIntro";

function makeInput(overrides: Partial<JoinIntroInput> = {}): JoinIntroInput {
  return {
    status: "Pending",
    joinedCount: 1,
    memberCount: 4,
    roundAmountStroops: "10000000",
    isMember: false,
    walletState: "connected",
    networkName: "testnet",
    networkMismatch: false,
    ...overrides,
  };
}

describe("JoinIntroBanner — rendering", () => {
  it("renders a labeled section for accessibility", () => {
    render(<JoinIntroBanner content={buildJoinIntroContent(makeInput())} />);
    expect(screen.getByRole("region", { name: /join information/i })).toBeInTheDocument();
  });

  it("shows the heading from content", () => {
    const content = buildJoinIntroContent(makeInput());
    render(<JoinIntroBanner content={content} />);
    expect(screen.getByText(content.heading)).toBeInTheDocument();
  });

  it("always renders the advisory (guaranteeNote)", () => {
    const content = buildJoinIntroContent(makeInput());
    render(<JoinIntroBanner content={content} />);
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.getByRole("note").textContent).toContain("indexed data");
  });
});

describe("JoinIntroBanner — prerequisites", () => {
  it("shows prerequisites when joinAvailable=true", () => {
    const content = buildJoinIntroContent(
      makeInput({ walletState: "connected", networkMismatch: false }),
    );
    render(<JoinIntroBanner content={content} />);
    expect(screen.getByRole("list", { name: /prerequisites/i })).toBeInTheDocument();
  });

  it("hides prerequisites when joinAvailable=false (Active circle)", () => {
    const content = buildJoinIntroContent(makeInput({ status: "Active" }));
    render(<JoinIntroBanner content={content} />);
    expect(screen.queryByRole("list", { name: /prerequisites/i })).not.toBeInTheDocument();
  });

  it("shows Freighter install link when wallet not installed", () => {
    const content = buildJoinIntroContent(
      makeInput({ walletState: "not_installed" }),
    );
    render(<JoinIntroBanner content={content} />);
    const link = screen.getByRole("link", { name: /install/i });
    expect(link).toHaveAttribute("href", "https://freighter.app");
  });

  it("shows network mismatch guidance when networkMismatch=true", () => {
    const content = buildJoinIntroContent(
      makeInput({ walletState: "connected", networkMismatch: true }),
    );
    render(<JoinIntroBanner content={content} />);
    // Should show something about wrong network
    expect(screen.getByText(/testnet/i)).toBeInTheDocument();
  });
});

describe("JoinIntroBanner — variant headings", () => {
  const variants: Array<[Partial<JoinIntroInput>, RegExp]> = [
    [{ status: "Pending", isMember: false, joinedCount: 1, memberCount: 4 }, /accepting members/i],
    [{ status: "Pending", isMember: true },   /you have joined/i],
    [{ status: "Pending", joinedCount: 4, memberCount: 4, isMember: false }, /circle is full/i],
    [{ status: "Active" },      /joining is closed/i],
    [{ status: "Completed" },   /completed/i],
    [{ status: "Cancelled" },   /cancelled/i],
    [{ status: "Closed" },      /closed/i],
  ];

  for (const [input, headingPattern] of variants) {
    it(`renders correct heading for variant`, () => {
      const content = buildJoinIntroContent(makeInput(input));
      render(<JoinIntroBanner content={content} />);
      expect(screen.getByText(headingPattern)).toBeInTheDocument();
    });
  }
});
