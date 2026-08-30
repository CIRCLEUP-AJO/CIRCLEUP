import "@testing-library/jest-dom";
import { vi } from "vitest";

// ── Next.js navigation stubs ──────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// next/link is NOT mocked here. Individual test files that render components
// using next/link must include their own vi.mock("next/link", ...) near the
// top of the file. The per-test mock is hoisted by vitest so it still applies
// before any imports are resolved.

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
// doesn't implement it.
HTMLCanvasElement.prototype.getContext = () => null as unknown as CanvasRenderingContext2D;

Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});
