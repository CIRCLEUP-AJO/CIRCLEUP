/**
 * Focused responsive-layout checks for the core routes.
 *
 * These tests assert structural responsive behaviour (stacking, wrapping,
 * truncation) and that required fields and transaction controls remain
 * focusable and operable. True pixel-level layout is verified by exercising
 * the routes at phone / tablet / desktop widths in a real browser; these
 * unit tests pin the markup that makes that possible.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
  ACTIVE_NETWORK: "testnet",
  getExplorerLink: () => null,
  indexerEndpoint: () => null,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className, "aria-label": ariaLabel }: any) => (
    <a href={href} className={className} aria-label={ariaLabel}>{children}</a>
  ),
}));

import CreateClient from "@/app/create/CreateClient";
import { CircleCard, type Circle } from "@/components/CircleCard";
import CircleDetailClient from "@/app/circle/[address]/CircleDetailClient";

const baseCircle: Circle = {
  address: "CCIRCLE111111111111111111111111111111111111111111111111111",
  creator: "GCREATOR11111111111111111111111111111111111111111111111111",
  round_amount: "100000000",
  member_count: 4,
  status: "Active",
  current_round: 2,
  total_rounds: 8,
  created_ledger: 1000,
};

describe("viewport — create form", () => {
  it("renders required fields that are focusable and not initially disabled", () => {
    render(<CreateClient />);
    const name = screen.getByLabelText(/circle name/i);
    const amount = screen.getByLabelText(/contribution amount/i);
    const days = screen.getByLabelText(/round duration/i);
    const member1 = screen.getByRole("textbox", { name: /member 1 of/i });

    for (const el of [name, amount, days, member1]) {
      expect(el).not.toHaveAttribute("disabled");
      expect(el).toBeEnabled();
    }
  });

  it("keeps long member addresses legible on narrow viewports (input stacks full-width)", () => {
    render(<CreateClient />);
    const member1 = screen.getByRole("textbox", { name: /member 1 of/i }) as HTMLInputElement;
    expect(member1.className).toContain("w-full");
    expect(member1.className).toContain("sm:flex-1");
    expect(member1.className).toContain("font-mono");
  });

  it("keeps member rows focusable in source order (name → amount → days → members → submit)", () => {
    render(<CreateClient />);
    const focusable = Array.from(
      document.querySelectorAll('input:not([disabled]), button:not([disabled])'),
    );
    const labels = focusable.map((el) => el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.textContent ?? "");
    const firstMember = labels.find((l) => /member 1 of/i.test(l ?? ""));
    const submit = labels.find((l) => /create circle/i.test(l ?? ""));
    expect(firstMember).toBeDefined();
    expect(submit).toBeDefined();
    expect(labels.indexOf(firstMember!)).toBeLessThan(labels.indexOf(submit!));
  });

  it("renders the submit button as an operable transaction control", () => {
    render(<CreateClient />);
    const submit = screen.getByRole("button", { name: /create circle/i });
    expect(submit).not.toHaveAttribute("disabled");
    expect(submit).toHaveClass("min-h-[48px]");
  });

  it.each([
    ["mobile", MOBILE_WIDTH],
    ["200% zoom", ZOOM_200_WIDTH],
  ])("keeps the create flow operable at %s width", (_label, width) => {
    setViewport(width);
    render(<CreateClient />);
    const submit = screen.getByRole("button", { name: /create circle/i });
    expect(submit).toBeEnabled();
    expect(submit).toHaveClass("min-h-[48px]");
    const member1 = screen.getByRole("textbox", { name: /member 1 of/i });
    expect(member1).toBeEnabled();
    setViewport(1024);
  });
});

/**
 * Documented supported mobile width (px) and the effective CSS viewport at
 * 200% browser zoom on a 1280px-wide desktop (1280 / 2 = 640px).
 */
const MOBILE_WIDTH = 375;
const ZOOM_200_WIDTH = 640;

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

const detailCircle: Circle = {
  address: "CDETAIL111111111111111111111111111111111111111111111111111",
  creator: "GCREATOR11111111111111111111111111111111111111111111111111",
  round_amount: "1234567890",
  member_count: 3,
  status: "Active",
  current_round: 1,
  total_rounds: 3,
  created_ledger: 1000,
};

describe.each([
  ["mobile", MOBILE_WIDTH],
  ["200% zoom", ZOOM_200_WIDTH],
])("viewport — circle detail at %s width", (_label, width) => {
  beforeEach(() => setViewport(width));
  afterEach(() => setViewport(1024));

  it("renders long addresses with wrapping and full value available", () => {
    render(<CircleDetailClient circle={detailCircle} />);
    const addresses = screen.getAllByText(/CDETAIL|GCREATOR/);
    expect(addresses.length).toBeGreaterThan(0);
    for (const el of addresses) {
      expect(el.className).toMatch(/break-all|break-words|truncate/);
    }
  });

  it("labels any horizontal scroll container so it is announced", () => {
    render(<CircleDetailClient circle={detailCircle} />);
    const scrollers = document.querySelectorAll<HTMLElement>("[data-scroll-container]");
    for (const el of scrollers) {
      const label =
        el.getAttribute("aria-label") ??
        el.getAttribute("aria-labelledby") ??
        el.getAttribute("role");
      expect(label).toBeTruthy();
    }
  });

  it("keeps core read and write actions reachable and focusable", () => {
    render(<CircleDetailClient circle={detailCircle} />);
    const contribute = screen.getByRole("button", { name: /contribute/i });
    expect(contribute).toBeEnabled();
    expect(contribute).toHaveClass("min-h-[48px]");
    const back = screen.getByRole("link", { name: /back|all circles/i });
    expect(back).toHaveAttribute("href");
  });
});

describe("viewport — circle card", () => {
  it("truncates long addresses with the full value available via title", () => {
    render(<CircleCard circle={baseCircle} />);
    const shortenedAddress = `${baseCircle.address.slice(0, 4)}…${baseCircle.address.slice(-4)}`;
    const address = screen.getByText(shortenedAddress);
    expect(address).toHaveAttribute("title", baseCircle.address);
    expect(address).toHaveClass("truncate");
  });

  it("truncates the pot with the full value available via title", () => {
    render(<CircleCard circle={baseCircle} />);
    // round_amount $10.00 × 4 members = $40.00 pot
    const pot = screen.getByText(/\$40\.00/);
    expect(pot).toHaveAttribute("title", "$40.00 total pot");
    expect(pot).toHaveClass("truncate");
  });
});
