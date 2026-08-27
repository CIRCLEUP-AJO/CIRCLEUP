/**
 * Tests for the wallet capability adapter (app/src/lib/walletCapabilities.ts).
 *
 * Uses node:test + node:assert (the app has no dedicated test runner; run via
 * `npx tsc --noEmit` to type-check, or compile and `node --test`). Every case
 * injects a fake provider object, so no browser, DOM, or real Freighter
 * extension is required.
 *
 * Coverage: one case per capability state the acceptance criteria call out —
 * SSR (no window), provider absent, full provider, partial providers (signing
 * only / network only / listeners only), denied/partial (non-function members),
 * and the pre-signing explanation helper.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectWalletCapabilities,
  explainUnsupportedAction,
  getInjectedProvider,
} from "./walletCapabilities";

const fn = () => {};

/** A provider exposing every capability. */
const fullProvider = {
  isConnected: fn,
  requestAccess: fn,
  getPublicKey: fn,
  getAddress: fn,
  signTransaction: fn,
  getNetwork: fn,
  getNetworkDetails: fn,
  addEventListener: fn,
  watchWalletChanges: fn,
};

describe("detectWalletCapabilities — environment safety", () => {
  test("SSR (window undefined) returns all-unsupported and never throws", () => {
    const caps = detectWalletCapabilities(undefined);
    assert.deepEqual(caps, {
      installed: false,
      canConnect: false,
      canSignTransaction: false,
      canGetNetwork: false,
      canWatchChanges: false,
    });
  });

  test("window present but no provider injected → not installed", () => {
    const caps = detectWalletCapabilities({});
    assert.equal(caps.installed, false);
    assert.equal(caps.canSignTransaction, false);
  });

  test("provider that is not an object is ignored", () => {
    const caps = detectWalletCapabilities({ freighter: "nope" as unknown });
    assert.equal(caps.installed, false);
  });
});

describe("detectWalletCapabilities — capability states", () => {
  test("full provider reports every capability", () => {
    const caps = detectWalletCapabilities({ freighter: fullProvider });
    assert.deepEqual(caps, {
      installed: true,
      canConnect: true,
      canSignTransaction: true,
      canGetNetwork: true,
      canWatchChanges: true,
    });
  });

  test("signing-only provider: signs but cannot report network or watch changes", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: fn, signTransaction: fn },
    });
    assert.equal(caps.installed, true);
    assert.equal(caps.canConnect, true);
    assert.equal(caps.canSignTransaction, true);
    assert.equal(caps.canGetNetwork, false);
    assert.equal(caps.canWatchChanges, false);
  });

  test("network-only provider: reports network but cannot sign", () => {
    const caps = detectWalletCapabilities({
      freighter: { isConnected: fn, getNetworkDetails: fn },
    });
    assert.equal(caps.canGetNetwork, true);
    assert.equal(caps.canSignTransaction, false);
  });

  test("listener-only provider: watches changes but cannot sign", () => {
    const caps = detectWalletCapabilities({
      freighter: { isConnected: fn, addEventListener: fn },
    });
    assert.equal(caps.canWatchChanges, true);
    assert.equal(caps.canSignTransaction, false);
  });

  test("partial/denied provider: members present but not functions → capability false", () => {
    const caps = detectWalletCapabilities({
      freighter: { signTransaction: null, getNetwork: 42, requestAccess: fn },
    });
    assert.equal(caps.installed, true);
    assert.equal(caps.canConnect, true);
    assert.equal(caps.canSignTransaction, false);
    assert.equal(caps.canGetNetwork, false);
  });

  test("legacy freighterApi global is detected when freighter is absent", () => {
    const caps = detectWalletCapabilities({ freighterApi: fullProvider });
    assert.equal(caps.installed, true);
  });
});

describe("getInjectedProvider", () => {
  test("prefers window.freighter over window.freighterApi", () => {
    const a = { signTransaction: fn };
    const b = { getNetwork: fn };
    assert.equal(getInjectedProvider({ freighter: a, freighterApi: b }), a);
  });

  test("returns null on the server", () => {
    assert.equal(getInjectedProvider(undefined), null);
  });
});

describe("explainUnsupportedAction", () => {
  const none = detectWalletCapabilities(undefined);
  const full = detectWalletCapabilities({ freighter: fullProvider });
  const signOnly = detectWalletCapabilities({
    freighter: { requestAccess: fn, signTransaction: fn },
  });

  test("no wallet → explains installation for any action", () => {
    const msg = explainUnsupportedAction("connect", none);
    assert.ok(msg && /install/i.test(msg));
  });

  test("supported action returns null (not blocked)", () => {
    assert.equal(explainUnsupportedAction("sign", full), null);
    assert.equal(explainUnsupportedAction("connect", signOnly), null);
  });

  test("unsupported capability is explained before the action starts", () => {
    const msg = explainUnsupportedAction("detectNetwork", signOnly);
    assert.ok(msg && /active network/i.test(msg));
    const msg2 = explainUnsupportedAction("watchChanges", signOnly);
    assert.ok(msg2 && /account changes/i.test(msg2));
  });
});
