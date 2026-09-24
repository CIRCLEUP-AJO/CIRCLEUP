import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getMissingEnvVars,
  getMalformedContractAddresses,
  assertEnvVars,
  parsePositiveIntEnv,
  parseEventsLimit,
  parseStartLedger,
} from "./config";

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

const VALID_ENV = {
  DATABASE_URL: "postgresql://postgres:password@localhost:5432/circleup",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  CIRCLE_FACTORY_ADDRESS: VALID_CONTRACT,
  REPUTATION_ADDRESS: VALID_CONTRACT,
  USDC_ADDRESS: VALID_CONTRACT,
};

// ─── getMissingEnvVars ────────────────────────────────────────────────────────

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

// ─── getMalformedContractAddresses ────────────────────────────────────────────

test("getMalformedContractAddresses returns [] for valid Soroban contract IDs", () => {
  assert.deepEqual(getMalformedContractAddresses(VALID_ENV), []);
});

test("getMalformedContractAddresses flags a G-prefixed address (not a contract ID)", () => {
  const env = {
    ...VALID_ENV,
    CIRCLE_FACTORY_ADDRESS:
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  };
  const result = getMalformedContractAddresses(env);
  assert.equal(result.length, 1);
  assert.match(result[0], /CIRCLE_FACTORY_ADDRESS/);
  assert.match(result[0], /C-prefixed/);
});

test("getMalformedContractAddresses flags a truncated contract ID", () => {
  const env = { ...VALID_ENV, REPUTATION_ADDRESS: "CSHORT" };
  const result = getMalformedContractAddresses(env);
  assert.equal(result.length, 1);
  assert.match(result[0], /REPUTATION_ADDRESS/);
});

test("getMalformedContractAddresses flags multiple malformed addresses", () => {
  const env = {
    ...VALID_ENV,
    CIRCLE_FACTORY_ADDRESS: "not-a-contract",
    REPUTATION_ADDRESS: "also-wrong",
  };
  assert.equal(getMalformedContractAddresses(env).length, 2);
});

test("getMalformedContractAddresses does not flag empty values (presence checked separately)", () => {
  const env = { ...VALID_ENV, USDC_ADDRESS: "" };
  const result = getMalformedContractAddresses(env);
  assert.ok(result.every((e) => !e.includes("USDC_ADDRESS")));
});

// ─── assertEnvVars ────────────────────────────────────────────────────────────

test("assertEnvVars does not throw when config is complete and valid", () => {
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

test("assertEnvVars includes malformed contract address errors", () => {
  const env = { ...VALID_ENV, CIRCLE_FACTORY_ADDRESS: "not-valid" };
  assert.throws(
    () => assertEnvVars(env),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /CIRCLE_FACTORY_ADDRESS/);
      assert.match(err.message, /C-prefixed/);
      return true;
    },
  );
});

// ─── parsePositiveIntEnv ──────────────────────────────────────────────────────

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

// ─── parseEventsLimit ─────────────────────────────────────────────────────────

test("parseEventsLimit defaults to 100 and accepts a custom value", () => {
  assert.equal(parseEventsLimit(undefined), 100);
  assert.equal(parseEventsLimit("500"), 500);
});

test("parseEventsLimit rejects a value above the Soroban RPC cap of 10000", () => {
  assert.throws(() => parseEventsLimit("10001"), /at most 10000/);
});

// ─── parseStartLedger ─────────────────────────────────────────────────────────

test("parseStartLedger defaults to 0 and accepts a custom ledger", () => {
  assert.equal(parseStartLedger(undefined), 0);
  assert.equal(parseStartLedger("123456"), 123456);
});

test("parseStartLedger rejects negative and non-integer values", () => {
  assert.throws(() => parseStartLedger("-1"), /non-negative integer/);
  assert.throws(() => parseStartLedger("abc"), /non-negative integer/);
});
