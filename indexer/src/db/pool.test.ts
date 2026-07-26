import { test } from "node:test";
import assert from "node:assert/strict";
import { connectWithRetry } from "./pool";

function fakePool(failuresBeforeSuccess: number) {
  let calls = 0;
  return {
    calls: () => calls,
    connect: async () => {
      calls++;
      if (calls <= failuresBeforeSuccess) {
        throw new Error(`ECONNREFUSED (attempt ${calls})`);
      }
      return { release: () => {} } as any;
    },
  };
}

test("connectWithRetry succeeds immediately when Postgres is already up", async () => {
  const pool = fakePool(0);
  await connectWithRetry({ pool, maxRetries: 3, baseDelayMs: 1 });
  assert.equal(pool.calls(), 1);
});

test("connectWithRetry retries transient failures and eventually succeeds", async () => {
  const pool = fakePool(2);
  await connectWithRetry({ pool, maxRetries: 5, baseDelayMs: 1 });
  assert.equal(pool.calls(), 3);
});

test("connectWithRetry gives up after maxRetries and throws a clear error", async () => {
  const pool = fakePool(Infinity);
  await assert.rejects(
    () => connectWithRetry({ pool, maxRetries: 3, baseDelayMs: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Could not connect to Postgres after 3 attempt/);
      assert.match(err.message, /ECONNREFUSED/);
      return true;
    },
  );
  assert.equal(pool.calls(), 3);
});

test("connectWithRetry surfaces a useful message for a refused-connection AggregateError", async () => {
  // pg's connection failure for an unreachable host is an AggregateError
  // whose own `.message` is "" — the real text lives in `.errors[]`. A naive
  // `err.message` would silently produce an empty, useless failure message.
  const pool = {
    connect: async () => {
      // Shaped like Node's real AggregateError for a refused connection:
      // `.message` is "" and the real text is nested in `.errors[]`.
      throw {
        name: "AggregateError",
        message: "",
        code: "ECONNREFUSED",
        errors: [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })],
      };
    },
  };
  await assert.rejects(
    () => connectWithRetry({ pool, maxRetries: 1, baseDelayMs: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ECONNREFUSED 127\.0\.0\.1:5432/);
      return true;
    },
  );
});
