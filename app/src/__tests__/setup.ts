import "@testing-library/jest-dom";
import { vi } from "vitest";

// ── Next.js stubs ─────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) =>
    // Render as a plain anchor so href-based assertions work in tests
    Object.assign(
      document.createElement("a"),
      { href, className, ...rest },
    ),
}));

// ── Freighter stubs ───────────────────────────────────────────────────────────
// Replaced per-test when specific wallet states are needed.

vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn().mockResolvedValue(false),
  getPublicKey: vi.fn().mockResolvedValue(""),
  signTransaction: vi.fn().mockResolvedValue(""),
  requestAccess: vi.fn().mockResolvedValue(""),
}));

// ── Browser API stubs ─────────────────────────────────────────────────────────

Object.defineProperty(window, "freighter", {
  value: undefined,
  writable: true,
});

// axe-core's color-contrast rule probes canvas for ligature detection; jsdom
// doesn't implement it. Suppress the not-implemented noise so it doesn't
// pollute test output — the rule still runs and reports violations correctly.
HTMLCanvasElement.prototype.getContext = () => null as unknown as CanvasRenderingContext2D;

Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});
