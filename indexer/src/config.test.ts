import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getMissingEnvVars,
  assertEnvVars,
  parsePositiveIntEnv,
  parseEventsLimit,
  parseStartLedger,
} from "./config";

const VALID_ENV = {
  DATABASE_URL: "postgresql://postgres:password@localhost:5432/circleup",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  CIRCLE_FACTORY_ADDRESS: "CFACTORY",
  REPUTATION_ADDRESS: "CREPUTATION",
  USDC_ADDRESS: "CUSDC",
};

test("getMissingEnvVars returns [] when every required var is set", () => {
  assert.deepEqual(getMissingEnvVars(VALID_ENV), []);
});

test("getMissingEnvVars reports unset required vars, including USDC_ADDRESS", () => {
  const { USDC_ADDRESS, ...rest } = VALID_ENV;
  assert.deepEqual(getMissingEnvVars(rest), ["USDC_ADDRESS"]);
});

test("getMissingEnvVars treats a blank string the same as unset", () => {
  const missing = getMissingEnvVars({ ...VALID_ENV, DATABASE_URL: "   " });
  assert.deepEqual(missing, ["DATABASE_URL"]);
});

test("getMissingEnvVars reports every missing var, not just the first", () => {
  const missing = getMissingEnvVars({});
  assert.deepEqual(missing, [
    "DATABASE_URL",
    "STELLAR_RPC_URL",
    "CIRCLE_FACTORY_ADDRESS",
    "REPUTATION_ADDRESS",
    "USDC_ADDRESS",
  ]);
});

test("assertEnvVars does not throw when config is complete", () => {
  assert.doesNotThrow(() => assertEnvVars(VALID_ENV));
});

test("assertEnvVars throws a single error naming every missing var", () => {
  const { USDC_ADDRESS, REPUTATION_ADDRESS, ...rest } = VALID_ENV;
  assert.throws(
    () => assertEnvVars(rest),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /USDC_ADDRESS/);
      assert.match(err.message, /REPUTATION_ADDRESS/);
      return true;
    },
  );
});

test("parsePositiveIntEnv falls back when unset", () => {
  assert.equal(parsePositiveIntEnv("EVENTS_LIMIT", undefined, 100), 100);
  assert.equal(parsePositiveIntEnv("EVENTS_LIMIT", "", 100), 100);
});

test("parsePositiveIntEnv parses a valid override", () => {
  assert.equal(parsePositiveIntEnv("EVENTS_LIMIT", "250", 100), 250);
});

test("parsePositiveIntEnv rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parsePositiveIntEnv("EVENTS_LIMIT", "0", 100), /positive integer/);
  assert.throws(() => parsePositiveIntEnv("EVENTS_LIMIT", "-5", 100), /positive integer/);
  assert.throws(() => parsePositiveIntEnv("EVENTS_LIMIT", "abc", 100), /positive integer/);
  assert.throws(() => parsePositiveIntEnv("EVENTS_LIMIT", "1.5", 100), /positive integer/);
});

test("parseEventsLimit defaults to 100 and accepts a custom value", () => {
  assert.equal(parseEventsLimit(undefined), 100);
  assert.equal(parseEventsLimit("500"), 500);
});

test("parseEventsLimit rejects a value above the Soroban RPC cap of 10000", () => {
  assert.throws(() => parseEventsLimit("10001"), /at most 10000/);
});

test("parseStartLedger defaults to 0 and accepts a custom ledger", () => {
  assert.equal(parseStartLedger(undefined), 0);
  assert.equal(parseStartLedger("123456"), 123456);
});

test("parseStartLedger rejects negative and non-integer values", () => {
  assert.throws(() => parseStartLedger("-1"), /non-negative integer/);
  assert.throws(() => parseStartLedger("abc"), /non-negative integer/);
});
