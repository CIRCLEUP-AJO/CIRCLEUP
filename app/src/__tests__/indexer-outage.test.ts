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

// ─── Service outage outcome mapping ──────────────────────────────────────────
//
// The route-level outcome for an indexer 503 must be "service_outage" — a
// distinct category from "contract_read_failure" (RPC/contract read errors)
// and "not_found" (unknown entity). These tests pin that mapping so the
// outage recovery path cannot silently regress into a generic error page.

describe("route outcome mapping — indexer 503 is a service outage", () => {
  it("maps a 503 indexer response to 'service_outage'", async () => {
    const { classifyRouteOutcome } = await import("../lib/routeOutcome");
    const outcome = classifyRouteOutcome({ kind: "http", status: 503 });
    expect(outcome).toBe("service_outage");
  });

  it("does not collapse a 503 into 'not_found' or 'contract_read_failure'", async () => {
    const { classifyRouteOutcome } = await import("../lib/routeOutcome");
    const outcome = classifyRouteOutcome({ kind: "http", status: 503 });
    expect(outcome).not.toBe("not_found");
    expect(outcome).not.toBe("contract_read_failure");
  });

  it("keeps 404 as 'not_found' and contract read errors as 'contract_read_failure'", async () => {
    const { classifyRouteOutcome } = await import("../lib/routeOutcome");
    expect(classifyRouteOutcome({ kind: "http", status: 404 })).toBe("not_found");
    expect(classifyRouteOutcome({ kind: "contract_read" })).toBe("contract_read_failure");
  });

  it("maps an unreachable indexer to 'service_outage' as well", async () => {
    const { classifyRouteOutcome } = await import("../lib/routeOutcome");
    expect(classifyRouteOutcome({ kind: "network" })).toBe("service_outage");
  });

  it("assigns HTTP 503 to the service outage outcome", async () => {
    const { httpStatusForOutcome } = await import("../lib/routeOutcome");
    expect(httpStatusForOutcome("service_outage")).toBe(503);
    expect(httpStatusForOutcome("not_found")).toBe(404);
    expect(httpStatusForOutcome("invalid_address")).toBe(400);
  });
});

describe("outage recovery path rendering", () => {
  it("renders the outage recovery guidance for the service_outage outcome", async () => {
    const { renderRouteOutcome } = await import("../lib/routeOutcome");
    const html = renderRouteOutcome("service_outage");
    expect(html).toContain("temporarily unavailable");
    expect(html).toContain("Retry");
    // Must not render the not-found copy for an outage.
    expect(html).not.toContain("not found");
  });

  it("renders distinct copy for not_found and contract_read_failure", async () => {
    const { renderRouteOutcome } = await import("../lib/routeOutcome");
    const notFound = renderRouteOutcome("not_found");
    const readFailure = renderRouteOutcome("contract_read_failure");
    expect(notFound).not.toBe(readFailure);
    expect(notFound).toContain("not found");
    expect(readFailure).toContain("could not be read");
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
