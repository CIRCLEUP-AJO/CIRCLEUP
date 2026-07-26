import test from "node:test";
import assert from "node:assert/strict";

import { createEventKey } from "./indexer";

test("createEventKey is stable for equivalent events", () => {
  const event = {
    ledger: 42,
    txHash: "tx-123",
    contractId: "CA123",
    topic: [{}, {}],
    value: {},
  } as any;

  const duplicate = {
    ledger: 42,
    txHash: "tx-123",
    contractId: "CA123",
    topic: [{}, {}],
    value: {},
  } as any;

  assert.equal(createEventKey(event), createEventKey(duplicate));
});

test("createEventKey changes when event content changes", () => {
  const event = {
    ledger: 42,
    txHash: "tx-123",
    contractId: "CA123",
    topic: [{}, {}],
    value: {},
  } as any;

  const changed = {
    ledger: 43,
    txHash: "tx-123",
    contractId: "CA123",
    topic: [{}, {}],
    value: {},
  } as any;

  assert.notEqual(createEventKey(event), createEventKey(changed));
});
