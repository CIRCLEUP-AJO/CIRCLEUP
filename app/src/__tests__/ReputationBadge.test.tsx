import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReputationBadge, ReputationLegend, getLevel, REPUTATION_LEVELS } from "@/components/ReputationBadge";

describe("getLevel", () => {
  it.each([
    [0, "New"],
    [1, "Starter"],
    [2, "Starter"],
    [3, "Reliable"],
    [5, "Reliable"],
    [6, "Trusted"],
    [9, "Trusted"],
    [10, "Legend"],
    [100, "Legend"],
  ])("score %i → %s", (score, expectedLabel) => {
    expect(getLevel(score).label).toBe(expectedLabel);
  });

  it("every tier boundary is covered without gaps", () => {
    // Walk 0..12 and confirm no score returns undefined
    for (let s = 0; s <= 12; s++) {
      expect(getLevel(s)).toBeDefined();
    }
  });
});

describe("ReputationBadge — rendering", () => {
  it("renders score number", () => {
    render(<ReputationBadge score={7} />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("renders the correct tier label", () => {
    render(<ReputationBadge score={7} />);
    expect(screen.getByText("Trusted")).toBeInTheDocument();
  });

  it("applies sm size class", () => {
    const { container } = render(<ReputationBadge score={3} size="sm" />);
    expect(container.firstChild).toHaveClass("text-xs");
  });

  it("applies lg size class", () => {
    const { container } = render(<ReputationBadge score={3} size="lg" />);
    expect(container.firstChild).toHaveClass("text-base");
  });
});

describe("ReputationBadge — accessibility", () => {
  it("has a meaningful aria-label announcing level and score", () => {
    render(<ReputationBadge score={10} />);
    const badge = screen.getByLabelText(/reputation level: legend, score 10/i);
    expect(badge).toBeInTheDocument();
  });

  it("emoji is aria-hidden", () => {
    const { container } = render(<ReputationBadge score={1} />);
    const spans = container.querySelectorAll("[aria-hidden='true']");
    const hiddenTexts = Array.from(spans).map((el) => el.textContent);
    expect(hiddenTexts).toContain("⭐");
  });

  it("score text is aria-hidden (label already announces it)", () => {
    const { container } = render(<ReputationBadge score={5} />);
    const hiddenSpans = Array.from(
      container.querySelectorAll("[aria-hidden='true']")
    ).map((el) => el.textContent);
    expect(hiddenSpans).toContain("5");
  });
});

describe("ReputationLegend", () => {
  it("renders all tier labels", () => {
    render(<ReputationLegend />);
    for (const tier of REPUTATION_LEVELS) {
      expect(screen.getAllByText(tier.label).length).toBeGreaterThan(0);
    }
  });

  it("renders tier descriptions", () => {
    render(<ReputationLegend />);
    expect(screen.getByText(/1–2 completed rounds/i)).toBeInTheDocument();
    expect(screen.getByText(/10 or more completed rounds/i)).toBeInTheDocument();
  });

  it("uses a description-list element for semantic correctness", () => {
    const { container } = render(<ReputationLegend />);
    expect(container.querySelector("dl")).toBeInTheDocument();
  });

  it("section has an accessible label", () => {
    render(<ReputationLegend />);
    expect(
      screen.getByRole("region", { name: /reputation badge legend/i })
    ).toBeInTheDocument();
  });
});
