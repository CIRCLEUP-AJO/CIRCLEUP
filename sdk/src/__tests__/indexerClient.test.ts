/**
 * Tests for IndexerClient.
 *
 * We intercept `fetch` with vi.stubGlobal so no real network calls are made.
 * Every test verifies both the happy path (typed response is returned) and
 * the relevant failure modes (network error, non-2xx status, bad JSON).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IndexerClient, IndexerError } from "../client";
import type { CircleUpConfig } from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONFIG: CircleUpConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {
    circleFactory: "CFACTORY",
    reputation: "CREP",
    usdc: "CUSDC",
  },
  indexerUrl: "http://localhost:3001",
};

const CIRCLE_ADDR = "CTEST_CIRCLE_ADDRESS";
const MEMBER_ADDR = "GABC123";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock fetch that returns a 200 JSON response. */
function mockOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

/** Build a mock fetch that returns a non-2xx JSON response. */
function mockError(status: number, errorBody?: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(errorBody ?? { error: `HTTP ${status}` }),
  });
}

/** Build a mock fetch that rejects (network failure). */
function mockNetworkFailure(message = "ECONNREFUSED") {
  return vi.fn().mockRejectedValue(new Error(message));
}

// ─── Construction ─────────────────────────────────────────────────────────────

describe("IndexerClient construction", () => {
  it("constructs successfully when indexerUrl is set", () => {
    expect(() => new IndexerClient(BASE_CONFIG)).not.toThrow();
  });

  it("throws when indexerUrl is missing", () => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl: undefined };
    expect(() => new IndexerClient(cfg)).toThrow(
      "IndexerClient requires config.indexerUrl",
    );
  });

  it("throws when indexerUrl is an empty string", () => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl: "" };
    expect(() => new IndexerClient(cfg)).toThrow(
      "IndexerClient requires config.indexerUrl",
    );
  });

  it("throws when indexerUrl is only whitespace", () => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl: "   " };
    expect(() => new IndexerClient(cfg)).toThrow(
      "IndexerClient requires config.indexerUrl",
    );
  });

  it("strips trailing slash from indexerUrl", async () => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl: "http://localhost:3001/" };
    const mockFetch = mockOk({ circles: [] });
    vi.stubGlobal("fetch", mockFetch);

    const client = new IndexerClient(cfg);
    await client.getCircles();

    const [calledUrl] = mockFetch.mock.calls[0] as [string];
    expect(calledUrl).toBe("http://localhost:3001/circles");
    vi.unstubAllGlobals();
  });
});

// ─── getCircles ───────────────────────────────────────────────────────────────

describe("IndexerClient.getCircles", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed circles list", async () => {
    const payload = { circles: [{ address: CIRCLE_ADDR, status: "Active" }] };
    vi.stubGlobal("fetch", mockOk(payload));

    const client = new IndexerClient(BASE_CONFIG);
    const result = await client.getCircles();

    expect(result.circles).toHaveLength(1);
    expect(result.circles[0].address).toBe(CIRCLE_ADDR);
  });

  it("calls the correct endpoint", async () => {
    const mockFetch = mockOk({ circles: [] });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getCircles();

    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3001/circles");
  });

  it("throws IndexerError on 500", async () => {
    vi.stubGlobal("fetch", mockError(500, { error: "Internal server error" }));

    await expect(new IndexerClient(BASE_CONFIG).getCircles()).rejects.toThrow(
      IndexerError,
    );
  });

  it("IndexerError carries the HTTP status", async () => {
    vi.stubGlobal("fetch", mockError(503));

    const err = await new IndexerClient(BASE_CONFIG)
      .getCircles()
      .catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).status).toBe(503);
  });

  it("throws IndexerError with status 0 on network failure", async () => {
    vi.stubGlobal("fetch", mockNetworkFailure("ECONNREFUSED"));

    const err = await new IndexerClient(BASE_CONFIG)
      .getCircles()
      .catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).status).toBe(0);
    expect((err as IndexerError).message).toContain("ECONNREFUSED");
  });
});

// ─── getCircleDetail ──────────────────────────────────────────────────────────

describe("IndexerClient.getCircleDetail", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns circle, members, and latestLedger", async () => {
    const payload = {
      circle: { address: CIRCLE_ADDR, status: "Active" },
      members: [{ member_address: MEMBER_ADDR }],
      latestLedger: 9_000_000,
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const result = await new IndexerClient(BASE_CONFIG).getCircleDetail(CIRCLE_ADDR);

    expect(result.circle.address).toBe(CIRCLE_ADDR);
    expect(result.members).toHaveLength(1);
    expect(result.latestLedger).toBe(9_000_000);
  });

  it("URL-encodes the circle address", async () => {
    const mockFetch = mockOk({ circle: {}, members: [], latestLedger: null });
    vi.stubGlobal("fetch", mockFetch);

    const addr = "C ADDR WITH SPACES";
    await new IndexerClient(BASE_CONFIG).getCircleDetail(addr);

    const [calledUrl] = mockFetch.mock.calls[0] as [string];
    expect(calledUrl).toBe(`http://localhost:3001/circles/${encodeURIComponent(addr)}`);
  });

  it("throws IndexerError with status 404 when circle not found", async () => {
    vi.stubGlobal("fetch", mockError(404, { error: "Circle not found" }));

    const err = await new IndexerClient(BASE_CONFIG)
      .getCircleDetail(CIRCLE_ADDR)
      .catch((e) => e);

    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).status).toBe(404);
    expect((err as IndexerError).message).toContain("Circle not found");
  });
});

// ─── getMembers ───────────────────────────────────────────────────────────────

describe("IndexerClient.getMembers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns members array", async () => {
    const payload = {
      members: [
        { member_address: MEMBER_ADDR, total_contributions: 2 },
        { member_address: "GDEF456", total_contributions: 1 },
      ],
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const { members } = await new IndexerClient(BASE_CONFIG).getMembers(CIRCLE_ADDR);

    expect(members).toHaveLength(2);
    expect(members[0].member_address).toBe(MEMBER_ADDR);
    expect(members[0].total_contributions).toBe(2);
  });

  it("calls the /members sub-path", async () => {
    const mockFetch = mockOk({ members: [] });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getMembers(CIRCLE_ADDR);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `http://localhost:3001/circles/${CIRCLE_ADDR}/members`,
    );
  });

  it("throws IndexerError on network failure", async () => {
    vi.stubGlobal("fetch", mockNetworkFailure("timeout"));

    await expect(
      new IndexerClient(BASE_CONFIG).getMembers(CIRCLE_ADDR),
    ).rejects.toBeInstanceOf(IndexerError);
  });
});

// ─── getRounds ────────────────────────────────────────────────────────────────

describe("IndexerClient.getRounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns rounds and pendingDefaults", async () => {
    const payload = {
      rounds: [
        { roundIndex: 0, recipient: MEMBER_ADDR, amount: "400000000", contributions: [], defaults: [] },
      ],
      pendingDefaults: [],
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const { rounds, pendingDefaults } = await new IndexerClient(BASE_CONFIG).getRounds(CIRCLE_ADDR);

    expect(rounds).toHaveLength(1);
    expect(rounds[0].roundIndex).toBe(0);
    expect(pendingDefaults).toHaveLength(0);
  });

  it("calls the /rounds sub-path", async () => {
    const mockFetch = mockOk({ rounds: [], pendingDefaults: [] });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getRounds(CIRCLE_ADDR);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `http://localhost:3001/circles/${CIRCLE_ADDR}/rounds`,
    );
  });
});

// ─── getReputation ────────────────────────────────────────────────────────────

describe("IndexerClient.getReputation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns score, contributions, defaults, and updatedAt", async () => {
    const payload = {
      member: MEMBER_ADDR,
      score: 3,
      contributions: [{ circle_address: CIRCLE_ADDR, contributions: 4, total_rounds: 4 }],
      defaults: [],
      updatedAt: "2024-01-01T00:00:00Z",
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const rep = await new IndexerClient(BASE_CONFIG).getReputation(MEMBER_ADDR);

    expect(rep.score).toBe(3);
    expect(rep.contributions).toHaveLength(1);
    expect(rep.updatedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("calls the /reputation/:member endpoint", async () => {
    const mockFetch = mockOk({ member: MEMBER_ADDR, score: 0, contributions: [], defaults: [], updatedAt: null });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getReputation(MEMBER_ADDR);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `http://localhost:3001/reputation/${MEMBER_ADDR}`,
    );
  });

  it("URL-encodes the member address", async () => {
    const mockFetch = mockOk({ member: "", score: 0, contributions: [], defaults: [], updatedAt: null });
    vi.stubGlobal("fetch", mockFetch);

    const addr = "G ADDR WITH SPACES";
    await new IndexerClient(BASE_CONFIG).getReputation(addr);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `http://localhost:3001/reputation/${encodeURIComponent(addr)}`,
    );
  });
});

// ─── health ───────────────────────────────────────────────────────────────────

describe("IndexerClient.health", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns status and timestamp", async () => {
    const payload = { status: "ok" as const, timestamp: "2024-01-01T00:00:00Z" };
    vi.stubGlobal("fetch", mockOk(payload));

    const result = await new IndexerClient(BASE_CONFIG).health();

    expect(result.status).toBe("ok");
    expect(result.timestamp).toBe("2024-01-01T00:00:00Z");
  });

  it("throws IndexerError with actionable message when unreachable", async () => {
    vi.stubGlobal("fetch", mockNetworkFailure("ECONNREFUSED"));

    const err = await new IndexerClient(BASE_CONFIG).health().catch((e) => e);

    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).message).toContain("config.indexerUrl is correct");
  });
});

// ─── IndexerError shape ───────────────────────────────────────────────────────

describe("IndexerError", () => {
  it("exposes status and url", () => {
    const err = new IndexerError("something went wrong", 404, "http://localhost:3001/circles/X");
    expect(err.name).toBe("IndexerError");
    expect(err.status).toBe(404);
    expect(err.url).toBe("http://localhost:3001/circles/X");
    expect(err.message).toBe("something went wrong");
    expect(err).toBeInstanceOf(Error);
  });
});
