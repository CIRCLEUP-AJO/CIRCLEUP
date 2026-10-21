import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { requestTracing, REQUEST_ID_RE } from "./requestTracing";
import { configureLogger, resetLogger, LogEntry } from "./logger";

test("safe read IDs are correlated without wallet URLs or query strings", async () => {
  const entries: LogEntry[] = [];
  configureLogger({ transport: entry => entries.push(entry), minLevel: "debug" });
  try {
    const app = express(); app.use(requestTracing);
    app.get("/members/:member", (_req, res) => res.json({ ok: true }));
    const id = "12345678-1234-4123-8123-123456789abc";
    const wallet = "G" + "A".repeat(55);
    const response = await request(app).get("/members/" + wallet + "?secret=hidden").set("X-Request-ID", id);
    assert.equal(response.headers["x-request-id"], id);
    assert.equal(entries[0].requestId, id);
    assert.equal(entries[0].path, "/members/:member");
    assert.ok(!JSON.stringify(entries).includes(wallet));
    assert.ok(!JSON.stringify(entries).includes("hidden"));
    for (const supplied of [undefined, wallet, "attacker supplied", id + "," + id]) {
      let pending = request(app).get("/members/fixture");
      if (supplied) pending = pending.set("X-Request-ID", supplied);
      const result = await pending;
      assert.match(result.headers["x-request-id"], REQUEST_ID_RE);
      assert.notEqual(result.headers["x-request-id"], supplied);
    }
    const duplicate = await request(app).get("/members/fixture").set("X-Request-ID", [id,id]);
    assert.match(duplicate.headers["x-request-id"], REQUEST_ID_RE);
    assert.notEqual(duplicate.headers["x-request-id"], id);
    assert.equal((await request(app).post("/members/fixture")).headers["x-request-id"], undefined);
  } finally { resetLogger(); }
});
