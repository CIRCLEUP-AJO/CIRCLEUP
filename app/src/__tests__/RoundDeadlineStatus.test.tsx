/**
 * Component tests for ledger-authoritative round deadlines (#866).
 *
 * Covers future deadlines, the exact ledger boundary, past boundaries,
 * missing/null ledger data, stale data, urgency alignment and the wording
 * exposed to screen readers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { RoundDeadlineStatus } from "@/components/RoundDeadlineStatus";
import { DEADLINE_MAX_DATA_AGE_MS } from "@/lib/deadline";

const NOW = 1_700_000_000_000;

function renderDeadline(props: {
  deadlineLedger: number | null | undefined;
  latestLedger: number | null | undefined;
  fetchedAtMs?: number;
  status?: string;
}) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  return render(
    <RoundDeadlineStatus
      deadlineLedger={props.deadlineLedger}
      latestLedger={props.latestLedger}
      status={props.status ?? "Active"}
      fetchedAtMs={props.fetchedAtMs ?? NOW}
      checkpointTime={null}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RoundDeadlineStatus — future deadline", () => {
  it("shows an approximate estimate plus authoritative ledger values", () => {
    renderDeadline({ deadlineLedger: 5000, latestLedger: 4000 });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("data-deadline-phase", "open");
    expect(screen.getByText("≈ 1h 23m")).toBeInTheDocument();
    expect(screen.getByText(/Approximate — assumes ~5s per ledger/)).toBeInTheDocument();
    expect(region).toHaveTextContent("Deadline at ledger 5,000");
    expect(region).toHaveTextContent("latest indexed ledger 4,000");
    expect(region).toHaveTextContent("1,000 ledgers remaining");
  });

  it("does not render a seconds-level countdown", () => {
    renderDeadline({ deadlineLedger: 4010, latestLedger: 4000 });
    const region = screen.getByRole("status");
    expect(region.textContent).not.toMatch(/\b\d+s\b(?! per ledger)/);
    expect(screen.getByText("≈ under 1m")).toBeInTheDocument();
  });
});

describe("RoundDeadlineStatus — ledger boundaries", () => {
  it("at the exact deadline ledger it is due, not passed, and shows no estimate", () => {
    renderDeadline({ deadlineLedger: 5000, latestLedger: 5000 });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("data-deadline-phase", "due");
    expect(screen.getByText("Deadline ledger reached")).toBeInTheDocument();
    expect(screen.getByText("Due at this ledger")).toBeInTheDocument();
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it("past the deadline ledger it is passed with red urgency", () => {
    renderDeadline({ deadlineLedger: 5000, latestLedger: 5002 });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("data-deadline-phase", "passed");
    expect(region).toHaveAttribute("data-deadline-urgency", "red");
    expect(region.className).toMatch(/bg-red-50/);
    expect(screen.getByText("Round deadline passed")).toBeInTheDocument();
    expect(region).toHaveTextContent("2 ledgers past deadline");
  });
});

describe("RoundDeadlineStatus — missing and stale data", () => {
  it("null latestLedger shows the deadline ledger and an unavailable indicator", () => {
    renderDeadline({ deadlineLedger: 5000, latestLedger: null });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("data-deadline-kind", "unavailable");
    expect(region).toHaveTextContent("Deadline at ledger 5,000 · latest ledger unavailable");
    expect(region).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it("null deadlineLedger shows that deadline data is not available", () => {
    renderDeadline({ deadlineLedger: null, latestLedger: 4000 });
    expect(screen.getByText("Deadline data not available for this circle")).toBeInTheDocument();
  });

  it("stale data hides the time estimate and shows ledger progress", () => {
    renderDeadline({
      deadlineLedger: 5000,
      latestLedger: 4000,
      fetchedAtMs: NOW - DEADLINE_MAX_DATA_AGE_MS,
    });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("data-deadline-kind", "stale");
    expect(region).toHaveAttribute("data-deadline-phase", "open");
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    expect(screen.getByText("1,000 ledgers remaining")).toBeInTheDocument();
    expect(region).toHaveTextContent(/Stale — updating/);
    expect(region).toHaveTextContent(/deadline may already have passed/);
  });
});

describe("RoundDeadlineStatus — urgency alignment", () => {
  it("yellow styling matches the 'Deadline approaching' label", () => {
    renderDeadline({ deadlineLedger: 4000 + 20_000, latestLedger: 4000 });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("data-deadline-urgency", "yellow");
    expect(region.className).toMatch(/bg-amber-50/);
    expect(screen.getByText("Deadline approaching")).toBeInTheDocument();
  });

  it("red styling matches the 'Deadline imminent' label", () => {
    renderDeadline({ deadlineLedger: 4000 + 100, latestLedger: 4000 });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("data-deadline-urgency", "red");
    expect(screen.getByText("Deadline imminent")).toBeInTheDocument();
  });
});

describe("RoundDeadlineStatus — screen-reader wording", () => {
  it("fresh: accessible name includes ledger values and 'Approximately'", () => {
    renderDeadline({ deadlineLedger: 5000, latestLedger: 4000 });
    const region = screen.getByRole("status");
    const name = region.getAttribute("aria-label") ?? "";
    expect(name).toContain("Deadline ledger 5,000");
    expect(name).toContain("Approximately 1h 23m remaining");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("stale: accessible name says data is stale and omits time", () => {
    renderDeadline({
      deadlineLedger: 5000,
      latestLedger: 4000,
      fetchedAtMs: NOW - DEADLINE_MAX_DATA_AGE_MS - 1,
    });
    const name = screen.getByRole("status").getAttribute("aria-label") ?? "";
    expect(name).toMatch(/stale and updating/);
    expect(name).not.toMatch(/Approximately/);
  });

  it("passed: accessible name states the deadline passed", () => {
    renderDeadline({ deadlineLedger: 5000, latestLedger: 5001 });
    const name = screen.getByRole("status").getAttribute("aria-label") ?? "";
    expect(name).toMatch(/^Round deadline passed\./);
  });

  it("missing: accessible name says time cannot be estimated", () => {
    renderDeadline({ deadlineLedger: 5000, latestLedger: undefined });
    const name = screen.getByRole("status").getAttribute("aria-label") ?? "";
    expect(name).toMatch(/cannot be estimated/);
  });
});
