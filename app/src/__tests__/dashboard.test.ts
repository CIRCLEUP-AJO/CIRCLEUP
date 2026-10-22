/**
 * Dashboard data layer tests.
 *
 * Acceptance criteria:
 *   - Invalid addresses are rejected before any fetch.
 *   - No memberships, many memberships, delayed data, and account change are
 *     handled distinctly.
 *   - Empty result is distinct from indexer unavailable.
 *   - Parsed participation fields come from the member sub-object.
 *   - Pagination metadata is propagated correctly.
 *   - fetchedAtMs is close to Date.now().
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchMemberDashboard } from "@/lib/dashboard";

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001";
const INVALID_ADDRESS = "not-a-stellar-address";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeCircleRow(address = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM") {
  return {
    address,
    creator: VALID_ADDRESS,
    round_amount: "10000000",
    member_count: 4,
    status: "Active",
    current_round: 1,
    total_rounds: 4,
    created_ledger: 100,
    updated_at: "2024-01-01T00:00:00Z",
    deadline_ledger: null,
  };
}

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

// ─── Address validation ───────────────────────────────────────────────────────

describe("fetchMemberDashboard — address validation", () => {
  it("returns invalid_address for a malformed address", async () => {
    const result = await fetchMemberDashboard(INVALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_address");
  });

  it("does not call fetch for an invalid address", async () => {
    global.fetch = vi.fn();
    await fetchMemberDashboard(INVALID_ADDRESS);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("proceeds to fetch for a valid address", async () => {
    mockFetch(200, { circles: [], pagination: { total: 0, page: 1, totalPages: 1 } });
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(true);
  });
});

// ─── No memberships ───────────────────────────────────────────────────────────

describe("fetchMemberDashboard — no memberships", () => {
  it("returns ok:true with empty circles for a 200 with empty array", async () => {
    mockFetch(200, { circles: [], pagination: { total: 0, page: 1, totalPages: 1 } });
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.circles).toHaveLength(0);
    expect(result.data.total).toBe(0);
  });
});

// ─── Many memberships ─────────────────────────────────────────────────────────

describe("fetchMemberDashboard — many memberships", () => {
  it("parses multiple circle rows", async () => {
    const circles = [
      makeCircleRow("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"),
      makeCircleRow("CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2"),
    ];
    mockFetch(200, { circles, pagination: { total: 2, page: 1, totalPages: 1 } });
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.circles).toHaveLength(2);
    expect(result.data.total).toBe(2);
  });

  it("deduplicates circles by address", async () => {
    const row = makeCircleRow();
    mockFetch(200, { circles: [row, row], pagination: { total: 2, page: 1, totalPages: 1 } });
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.circles).toHaveLength(1);
  });

  it("parses member participation from nested member object", async () => {
    const circles = [
      {
        circle: makeCircleRow(),
        member: {
          collateral: "10000000",
          defaults: 1,
          reputation_score: 5,
          total_contributions: 3,
        },
      },
    ];
    mockFetch(200, { circles, pagination: { total: 1, page: 1, totalPages: 1 } });
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.data.circles[0].participation;
    expect(p.hasLockedCollateral).toBe(true);
    expect(p.defaults).toBe(1);
    expect(p.reputationScore).toBe(5);
    expect(p.totalContributions).toBe(3);
  });
});

// ─── Error states ─────────────────────────────────────────────────────────────

describe("fetchMemberDashboard — error states", () => {
  it("returns indexer_outage for 503", async () => {
    mockFetch(503, {});
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("indexer_outage");
  });

  it("returns server for 500", async () => {
    mockFetch(500, {});
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("server");
  });

  it("returns network when fetch throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("network");
  });

  it("returns parse when body is not an object", async () => {
    mockFetch(200, "not an object");
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("parse");
  });

  it("returns parse when circles field is missing", async () => {
    mockFetch(200, { data_missing: true });
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("parse");
  });

  // indexer_outage and server are distinct error reasons
  it("indexer_outage and server are different reasons", async () => {
    mockFetch(503, {});
    const outage = await fetchMemberDashboard(VALID_ADDRESS);
    mockFetch(500, {});
    const serverErr = await fetchMemberDashboard(VALID_ADDRESS);
    expect(outage.ok).toBe(false);
    expect(serverErr.ok).toBe(false);
    if (outage.ok || serverErr.ok) return;
    expect(outage.reason).not.toBe(serverErr.reason);
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe("fetchMemberDashboard — pagination", () => {
  it("propagates page and totalPages from the response", async () => {
    mockFetch(200, {
      circles: [makeCircleRow()],
      pagination: { total: 50, page: 2, totalPages: 3 },
    });
    const result = await fetchMemberDashboard(VALID_ADDRESS, { page: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.page).toBe(2);
    expect(result.data.totalPages).toBe(3);
    expect(result.data.total).toBe(50);
  });

  it("fetchedAtMs is close to Date.now()", async () => {
    mockFetch(200, { circles: [], pagination: { total: 0, page: 1, totalPages: 1 } });
    const before = Date.now();
    const result = await fetchMemberDashboard(VALID_ADDRESS);
    const after = Date.now();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fetchedAtMs).toBeGreaterThanOrEqual(before);
    expect(result.fetchedAtMs).toBeLessThanOrEqual(after + 50);
  });
});

// ─── AbortSignal ─────────────────────────────────────────────────────────────

describe("fetchMemberDashboard — AbortSignal", () => {
  it("returns network error when signal is aborted before fetch", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("Aborted"), { name: "AbortError" }),
    );
    const result = await fetchMemberDashboard(VALID_ADDRESS, { signal: ctrl.signal });
    expect(result.ok).toBe(false);
  });
});
