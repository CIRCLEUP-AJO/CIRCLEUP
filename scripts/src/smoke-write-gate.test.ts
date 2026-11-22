/**
 * Tests for the disposable-testnet write gate (#865).
 *
 * Proves that write-based smoke scenarios can never run against mainnet and
 * only run on testnet when every explicit env/funding condition holds.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAINNET_PASSPHRASE,
  TESTNET_PASSPHRASE,
  checkFunding,
  evaluateWriteGate,
  runGatedTestnetWrites,
  type FetchLike,
} from "./smoke-write-gate";

const PK = "G" + "A".repeat(55);
const FAKE_SECRET = "S" + "B".repeat(55);

function okEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SMOKE_TESTNET: "true",
    SMOKE_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
    SMOKE_RPC_URL: "https://soroban-testnet.stellar.org",
    SMOKE_HORIZON_URL: "https://horizon-testnet.stellar.org",
    SMOKE_DISPOSABLE_ACCOUNT: "true",
    SMOKE_TESTNET_PUBLIC_KEY: PK,
    SMOKE_TESTNET_SECRET: FAKE_SECRET,
    ...overrides,
  };
}

function fakeFetch(status: number, balance?: string): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ balances: balance === undefined ? [] : [{ asset_type: "native", balance }] }),
  });
}

describe("evaluateWriteGate — mainnet is always refused", () => {
  test("mainnet without SMOKE_TESTNET is a skip", () => {
    const d = evaluateWriteGate("mainnet", {});
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.status, "skip");
  });

  test("mainnet with a fully valid testnet env is still refused (fail)", () => {
    const d = evaluateWriteGate("mainnet", okEnv());
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.status, "fail");
  });

  test("testnet env carrying the mainnet passphrase is refused", () => {
    const d = evaluateWriteGate("testnet", okEnv({ SMOKE_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE }));
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.match(d.reason, /MAINNET/);
  });

  test("mainnet-looking RPC or Horizon URLs are refused", () => {
    for (const o of [
      { SMOKE_RPC_URL: "https://mainnet.sorobanrpc.com" },
      { SMOKE_HORIZON_URL: "https://horizon.stellar.org" },
      { SMOKE_RPC_URL: "not a url" },
    ]) {
      const d = evaluateWriteGate("testnet", okEnv(o));
      assert.equal(d.allowed, false, JSON.stringify(o));
    }
  });
});

describe("evaluateWriteGate — explicit testnet opt-in", () => {
  test("skips when SMOKE_TESTNET is not set", () => {
    const d = evaluateWriteGate("testnet", okEnv({ SMOKE_TESTNET: undefined }));
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.status, "skip");
  });

  test("requires disposable-account acknowledgement", () => {
    const d = evaluateWriteGate("testnet", okEnv({ SMOKE_DISPOSABLE_ACCOUNT: undefined }));
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.status, "fail");
  });

  test("requires a valid public key and a present secret", () => {
    assert.equal(evaluateWriteGate("testnet", okEnv({ SMOKE_TESTNET_PUBLIC_KEY: "GBAD" })).allowed, false);
    assert.equal(evaluateWriteGate("testnet", okEnv({ SMOKE_TESTNET_SECRET: undefined })).allowed, false);
  });

  test("rejects unknown environments", () => {
    const d = evaluateWriteGate("futurenet", okEnv());
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.status, "fail");
  });

  test("allows a fully configured disposable testnet env and never echoes the secret", () => {
    const d = evaluateWriteGate("testnet", okEnv());
    assert.equal(d.allowed, true);
    assert.ok(!JSON.stringify(d).includes(FAKE_SECRET));
  });
});

describe("checkFunding — read-only balance check", () => {
  test("passes at or above the minimum", async () => {
    const r = await checkFunding("https://horizon-testnet.stellar.org", PK, fakeFetch(200, "50.0000000"));
    assert.equal(r.ok, true);
  });

  test("fails below the minimum", async () => {
    const r = await checkFunding("https://horizon-testnet.stellar.org", PK, fakeFetch(200, "1.0"));
    assert.equal(r.ok, false);
  });

  test("fails for an unfunded (404) account", async () => {
    const r = await checkFunding("https://horizon-testnet.stellar.org", PK, fakeFetch(404));
    assert.equal(r.ok, false);
    assert.match(r.reason, /friendbot/);
  });
});

describe("runGatedTestnetWrites", () => {
  test("never invokes the scenario on mainnet", async () => {
    let ran = false;
    await assert.rejects(
      runGatedTestnetWrites("mainnet", async () => {
        ran = true;
      }, { env: okEnv(), fetchImpl: fakeFetch(200, "1000") }),
    );
    assert.equal(ran, false);
  });

  test("never invokes the scenario when funding is insufficient", async () => {
    let ran = false;
    await assert.rejects(
      runGatedTestnetWrites("testnet", async () => {
        ran = true;
      }, { env: okEnv(), fetchImpl: fakeFetch(200, "0.5") }),
    );
    assert.equal(ran, false);
  });

  test("invokes the scenario on a funded disposable testnet account", async () => {
    const out = await runGatedTestnetWrites("testnet", async (ctx) => ctx.publicKey, {
      env: okEnv(),
      fetchImpl: fakeFetch(200, "100"),
    });
    assert.equal(out, PK);
  });
});
