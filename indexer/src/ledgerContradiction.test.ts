/**
 * Issue 98: Tests for ledger contradiction detection and finality invariants.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectLedgerSequenceRegression,
  detectEventRangeContradiction,
  LedgerContradictionError,
} from "./ledgerContradiction";

describe("Ledger Contradiction Detection", () => {
  describe("detectLedgerSequenceRegression", () => {
    it("returns null on initial startup when durableLastLedger is 0", () => {
      const result = detectLedgerSequenceRegression(0, 500);
      assert.strictEqual(result, null);
    });

    it("returns null when observedLatestLedger advances past durableLastLedger", () => {
      const result = detectLedgerSequenceRegression(1000, 1005);
      assert.strictEqual(result, null);
    });

    it("returns null when observedLatestLedger equals durableLastLedger", () => {
      const result = detectLedgerSequenceRegression(1000, 1000);
      assert.strictEqual(result, null);
    });

    it("detects sequence regression when observedLatestLedger is lower than durable cursor", () => {
      const evidence = detectLedgerSequenceRegression(1050, 1020, "ledger-hash-stale");
      assert.ok(evidence !== null);
      assert.strictEqual(evidence?.type, "SEQUENCE_REGRESSION");
      assert.strictEqual(evidence?.durableLedger, 1050);
      assert.strictEqual(evidence?.observedLedger, 1020);
      assert.strictEqual(evidence?.observedId, "ledger-hash-stale");
      assert.match(evidence?.detail ?? "", /regressed behind indexer's committed cursor/);
      assert.match(evidence?.detail ?? "", /lagging RPC replica/);
      assert.match(evidence?.remediation ?? "", /RPC cluster load-balancer health/);
    });
  });

  describe("detectEventRangeContradiction", () => {
    it("returns null when all events fall within [fromLedger, toLedger]", () => {
      const events = [
        { ledger: 100, id: "ev-1" },
        { ledger: 101, id: "ev-2" },
        { ledger: 102, id: "ev-3" },
      ];
      const result = detectEventRangeContradiction(events, 100, 102);
      assert.strictEqual(result, null);
    });

    it("detects contradiction when an event ledger is strictly lower than fromLedger", () => {
      const events = [
        { ledger: 99, id: "ev-stray" },
        { ledger: 100, id: "ev-1" },
      ];
      const evidence = detectEventRangeContradiction(events, 100, 105);
      assert.ok(evidence !== null);
      assert.strictEqual(evidence?.type, "INCONSISTENT_EVENT_RANGE");
      assert.strictEqual(evidence?.durableLedger, 100);
      assert.strictEqual(evidence?.observedLedger, 99);
      assert.strictEqual(evidence?.observedId, "ev-stray");
      assert.match(evidence?.detail ?? "", /lower than the queried range start/);
    });

    it("detects contradiction when an event ledger exceeds toLedger", () => {
      const events = [
        { ledger: 101, id: "ev-1" },
        { ledger: 106, id: "ev-future" },
      ];
      const evidence = detectEventRangeContradiction(events, 100, 105);
      assert.ok(evidence !== null);
      assert.strictEqual(evidence?.type, "INCONSISTENT_EVENT_RANGE");
      assert.strictEqual(evidence?.durableLedger, 105);
      assert.strictEqual(evidence?.observedLedger, 106);
      assert.strictEqual(evidence?.observedId, "ev-future");
      assert.match(evidence?.detail ?? "", /exceeds the maximum window ledger/);
    });
  });

  describe("LedgerContradictionError", () => {
    it("constructs error with structured evidence and diagnostic message", () => {
      const evidence = {
        type: "SEQUENCE_REGRESSION" as const,
        durableLedger: 5000,
        observedLedger: 4800,
        detail: "Stale node response",
        remediation: "Check cluster health",
      };

      const err = new LedgerContradictionError(evidence);
      assert.strictEqual(err.name, "LedgerContradictionError");
      assert.strictEqual(err.evidence, evidence);
      assert.match(err.message, /\[LedgerContradiction\] SEQUENCE_REGRESSION/);
      assert.match(err.message, /Observed ledger 4800 contradicts durable ledger 5000/);
    });
  });
});
