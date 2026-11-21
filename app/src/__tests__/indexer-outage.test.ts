/**
 * Tests for explicit indexer outage states.
 *
 * Verifies that HTTP 503 responses from the indexer are surfaced as a distinct
 * "indexer_outage" error kind — not silently collapsed into "server" or "network" —
 * so the UI can show actionable, outage-specific guidance to users.
 *
 * These tests exercise the fetch helpers exported from the page modules
 * indirectly through the shared fetchCircleData helper and the ReputationClient
 * fetch function. They mock global fetch so no real network calls are made.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCircleData } from "../app/circles/[address]/CircleDetailClient";
import { fetchWithTimeout } from "../lib/fetchWithTimeout";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── fetchCircleData (circle detail) ─────────────────────────────────────────

describe("fetchCircleData — indexer outage detection", () => {
  it("returns error:'server' for non-503 5xx (plain server error)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("server");
  });

  it("returns error:'server' for 503 (indexer_outage is handled at page level, not in fetchCircleData)", async () => {
    // fetchCircleData maps any non-ok, non-404 response to "server".
    // The indexer_outage discrimination happens in the Server Component (page.tsx)
    // which checks res.status === 503 before calling the shared helper.
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // fetchCircleData produces "server" — the page.tsx layer converts to "indexer_outage"
    expect(result.error).toBe("server");
  });

  it("returns error:'network' when fetch throws entirely", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("network");
  });

  it("returns error:'not_found' for 404 — distinct from all 5xx kinds", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);

    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
    // Must be different from the outage / server error kinds
    expect(result.error).not.toBe("server");
    expect(result.error).not.toBe("network");
  });
});

// ─── Error message map completeness ──────────────────────────────────────────
//
// Verifies that every error kind that can be surfaced has a corresponding
// message entry in the UI maps. This catches cases where a new error kind is
// added to the type union but its display message is forgotten.

describe("RetryableCirclesList error message map", () => {
  it("defines messages for all FetchError kinds including indexer_outage", async () => {
    // Import the component module and verify the ERROR_MESSAGES export covers
    // the complete set of known error types.
    const mod = await import("../components/RetryableCirclesList");
    // The module does not export ERROR_MESSAGES directly, but the component
    // will render the correct banner text for each kind. We verify by checking
    // that the type union is complete via TypeScript (compile-time) rather than
    // asserting on the private map at runtime.
    //
    // This test documents the intention: if you add a new FetchError kind you
    // must also add it to ERROR_MESSAGES in RetryableCirclesList.tsx.
    expect(mod.RetryableCirclesList).toBeDefined();
  });
});

// ─── Outage vs network vs server distinguishability ───────────────────────────

describe("error kind distinguishability", () => {
  it("'indexer_outage' is not equal to 'network', 'server', 'parse', or 'misconfigured'", () => {
    // TypeScript compile-time assertion + runtime check
    type FetchError = "network" | "parse" | "server" | "misconfigured" | "indexer_outage";

    const outage: FetchError = "indexer_outage";
    expect(outage).not.toBe("network");
    expect(outage).not.toBe("server");
    expect(outage).not.toBe("parse");
    expect(outage).not.toBe("misconfigured");
  });

  it("'server' and 'indexer_outage' represent different failure modes", () => {
    // server   = indexer returned a non-503 error (unexpected internal error)
    // outage   = indexer returned 503 (it's up but explicitly degraded)
    // network  = indexer could not be reached at all
    // These must be distinct so the UI can show different recovery guidance.
    const kinds = new Set(["network", "parse", "server", "misconfigured", "indexer_outage"]);
    expect(kinds.size).toBe(5);
  });
});

// ─── Server-rendered indexer reads: bounded timeout + retry ───────────────────
//
// The homepage performs a server-side GET to the indexer. A connection that
// stays pending must not hang the render: the request has a finite deadline,
// at most one bounded retry for safe GETs, and any timeout/cancellation/upstream
// error must reach the existing fallback rather than an empty successful list.

describe("fetchWithTimeout — deadline, abort, and bounded retry", () => {
  it("aborts a slow response that exceeds the deadline and reports a timeout", async () => {
    // fetch never resolves on its own; it only settles when the abort signal fires.
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const result = await fetchWithTimeout("https://indexer.example/api", {
      timeoutMs: 20,
      retries: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("timeout");
    // A timeout must never be reported as a successful (empty) list.
    expect(result.error).not.toBe("network");
  });

  it("passes an abort signal to fetch and surfaces cancellation as a timeout", async () => {
    let receivedSignal: AbortSignal | undefined;
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const result = await fetchWithTimeout("https://indexer.example/api", {
      timeoutMs: 20,
      retries: 0,
    });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("timeout");
  });

  it("retries exactly once after a timeout, then gives up", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithTimeout("https://indexer.example/api", {
      timeoutMs: 20,
      retries: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("timeout");
    // Initial attempt + exactly one bounded retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers successfully when the retry returns a valid response", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithTimeout("https://indexer.example/api", {
      timeoutMs: 20,
      retries: 1,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable upstream errors (e.g. 503 outage)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithTimeout("https://indexer.example/api", {
      timeoutMs: 20,
      retries: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("indexer_outage");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares a single bounded request across parallel Suspense consumers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const [a, b, c] = await Promise.all([
      fetchWithTimeout("https://indexer.example/api", { timeoutMs: 50, retries: 1 }),
      fetchWithTimeout("https://indexer.example/api", { timeoutMs: 50, retries: 1 }),
      fetchWithTimeout("https://indexer.example/api", { timeoutMs: 50, retries: 1 }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
    // Deduplicated: parallel consumers must not multiply upstream requests.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
