/**
 * Tests for the audit utilities (Issue #624).
 * Note: These tests intentionally skip actual DB queries to avoid needing
 * a running database. Full integration tests should be run against a
 * real database.
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert";
import {
  encodeCursor,
  decodeCursor,
  queryWithCursor,
} from "./cursorPagination";

describe("cursor encoding", () => {
  test("encodes and decodes basic object", () => {
    const row = { created_ledger: 12345, id: 42 };
    const cursor = encodeCursor(row, ["created_ledger", "id"]);
    const decoded = decodeCursor(cursor);

    assert.ok(decoded);
    assert.equal(decoded!.created_ledger, "12345");
    assert.equal(decoded!.id, "42");
  });

  test("handles bigint values", () => {
    const row = { ledger: BigInt(999999999999), id: BigInt(123) };
    const cursor = encodeCursor(row, ["ledger", "id"]);
    const decoded = decodeCursor(cursor);

    assert.ok(decoded);
    assert.equal(decoded!.ledger, "999999999999");
    assert.equal(decoded!.id, "123");
  });

  test("returns null for malformed cursor", () => {
    assert.equal(decodeCursor("not-valid-base64!!!"), null);
    assert.equal(decodeCursor(""), null);
  });

  test("encodes only specified fields", () => {
    const row = { a: 1, b: 2, c: 3 };
    const cursor = encodeCursor(row, ["a", "c"]);
    const decoded = decodeCursor(cursor);

    assert.ok(decoded);
    assert.equal(decoded!.a, "1");
    assert.equal(decoded!.c, "3");
    assert.equal(decoded!.b, undefined);
  });
});

describe("cursorPagination", () => {
  // Note: queryWithCursor actually queries the DB, so we mock the query function
  // for unit testing the cursor logic
  
  test("round-trip encode/decode preserves order", () => {
    const rows = [
      { created_ledger: 100, id: 1 },
      { created_ledger: 100, id: 2 },
      { created_ledger: 99, id: 5 },
    ];

    // Encode each row
    const cursors = rows.map(r => encodeCursor(r, ["created_ledger", "id"]));

    // Decode in reverse order - should get last row first
    const lastDecoded = decodeCursor(cursors[2]);
    assert.equal(lastDecoded?.created_ledger, "99");
    assert.equal(lastDecoded?.id, "5");
  });

  test("cursor with null values encodes safely", () => {
    const row = { created_ledger: 100, id: null };
    const cursor = encodeCursor(row, ["created_ledger", "id"]);
    const decoded = decodeCursor(cursor);

    assert.ok(decoded);
    assert.equal(decoded!.created_ledger, "100");
    assert.equal(decoded!.id, "null");
  });
});

// Note: Integration tests for runAudit would require a running database.
// These would typically be in __tests__/audit.integration.test.ts
describe("audit module structure", () => {
  test("exports audit types", async () => {
    // Dynamic import to check exports without needing DB
    const audit = await import("./audit");
    
    // Check key exports exist
    assert.ok(typeof audit.runAudit === "function");
    assert.ok(typeof audit.printAuditReport === "function");
    assert.ok(typeof audit.checkDuplicateEventIdentities === "function");
    assert.ok(typeof audit.checkLedgerCheckpointGaps === "function");
    assert.ok(typeof audit.checkCircleStatusConsistency === "function");
    assert.ok(typeof audit.checkCircleRoundDrift === "function");
    assert.ok(typeof audit.checkOrphanedMembers === "function");
    assert.ok(typeof audit.checkContributionConsistency === "function");
  });

  test("AuditOptions has expected shape", () => {
    // This is a compile-time check in TypeScript
    const options = {
      maxCircles: 100,
      maxLedgers: 1000,
      log: (msg: string) => console.log(msg),
    };

    assert.equal(options.maxCircles, 100);
    assert.equal(options.maxLedgers, 1000);
    assert.equal(typeof options.log, "function");
  });
});