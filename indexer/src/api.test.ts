import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const queryMock = vi.fn();

vi.mock("./db/pool", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const getLatestLedgerMock = vi.fn();

vi.mock("./indexer", () => ({
  rpc: {
    getLatestLedger: (...args: unknown[]) => getLatestLedgerMock(...args),
  },
}));

import { createApp } from "./api";

describe("GET /circles", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns paginated results with default page/limit", async () => {
    queryMock
      .mockResolvedValueOnce([{ count: "2" }])
      .mockResolvedValueOnce([{ address: "A" }, { address: "B" }]);

    const res = await request(createApp()).get("/circles");

    expect(res.status).toBe(200);
    expect(res.body.circles).toHaveLength(2);
    expect(res.body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
    });
  });

  it("applies explicit page/limit to the query and computes totalPages", async () => {
    queryMock
      .mockResolvedValueOnce([{ count: "45" }])
      .mockResolvedValueOnce([{ address: "A" }]);

    const res = await request(createApp()).get("/circles?page=2&limit=10");

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({
      page: 2,
      limit: 10,
      total: 45,
      totalPages: 5,
    });
    const [, rowParams] = queryMock.mock.calls[1];
    expect(rowParams).toEqual([10, 10]); // limit=10, offset=(page-1)*limit=10
  });

  it("rejects a non-positive page", async () => {
    const res = await request(createApp()).get("/circles?page=0");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/page/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer page", async () => {
    const res = await request(createApp()).get("/circles?page=abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/page/i);
  });

  it("rejects a limit above the max", async () => {
    const res = await request(createApp()).get("/circles?limit=101");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("rejects a limit below 1", async () => {
    const res = await request(createApp()).get("/circles?limit=0");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("rejects an unknown sort field", async () => {
    const res = await request(createApp()).get("/circles?sort=creator");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sort/i);
  });

  it("rejects an invalid order value", async () => {
    const res = await request(createApp()).get("/circles?order=sideways");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/order/i);
  });

  it("accepts a valid sort field and order, applied to ORDER BY", async () => {
    queryMock
      .mockResolvedValueOnce([{ count: "1" }])
      .mockResolvedValueOnce([{ address: "A" }]);

    const res = await request(createApp()).get(
      "/circles?sort=round_amount&order=asc",
    );

    expect(res.status).toBe(200);
    const [rowSql] = queryMock.mock.calls[1];
    expect(rowSql).toMatch(/ORDER BY c\.round_amount ASC/);
  });

  it("rejects an invalid status value", async () => {
    const res = await request(createApp()).get("/circles?status=Bogus");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  it("filters by a valid status on both the count and row queries", async () => {
    queryMock
      .mockResolvedValueOnce([{ count: "1" }])
      .mockResolvedValueOnce([{ address: "A", status: "Active" }]);

    const res = await request(createApp()).get("/circles?status=Active");

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toMatch(/WHERE c\.status = \$1/);
    expect(queryMock.mock.calls[0][1]).toEqual(["Active"]);
    expect(queryMock.mock.calls[1][1]).toEqual(["Active", 20, 0]);
  });

  it("returns 500 on a database error", async () => {
    queryMock.mockRejectedValueOnce(new Error("boom"));
    const res = await request(createApp()).get("/circles");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /circles/summary", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns counts for all statuses, including zero-count ones", async () => {
    queryMock.mockResolvedValueOnce([
      { status: "Active", count: "3" },
      { status: "Completed", count: "1" },
    ]);

    const res = await request(createApp()).get("/circles/summary");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 4,
      byStatus: { Pending: 0, Active: 3, Completed: 1, Cancelled: 0 },
    });
  });

  it("returns all-zero counts when there are no circles", async () => {
    queryMock.mockResolvedValueOnce([]);

    const res = await request(createApp()).get("/circles/summary");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: { Pending: 0, Active: 0, Completed: 0, Cancelled: 0 },
    });
  });

  it("returns 500 on a database error", async () => {
    queryMock.mockRejectedValueOnce(new Error("boom"));
    const res = await request(createApp()).get("/circles/summary");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /health", () => {
  beforeEach(() => {
    queryMock.mockReset();
    getLatestLedgerMock.mockReset();
  });

  it("returns 200 ok when db and rpc are both healthy", async () => {
    queryMock.mockResolvedValueOnce([{ "?column?": 1 }]);
    getLatestLedgerMock.mockResolvedValueOnce({ sequence: 12345 });

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db.status).toBe("ok");
    expect(res.body.rpc.status).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("returns 503 degraded when the db check fails", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    getLatestLedgerMock.mockResolvedValueOnce({ sequence: 12345 });

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.db.status).toBe("error");
    expect(res.body.db.error).toMatch(/connection refused/);
    expect(res.body.rpc.status).toBe("ok");
  });

  it("returns 503 degraded when the rpc check fails", async () => {
    queryMock.mockResolvedValueOnce([{ "?column?": 1 }]);
    getLatestLedgerMock.mockRejectedValueOnce(new Error("rpc unreachable"));

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.db.status).toBe("ok");
    expect(res.body.rpc.status).toBe("error");
    expect(res.body.rpc.error).toMatch(/rpc unreachable/);
  });
});
