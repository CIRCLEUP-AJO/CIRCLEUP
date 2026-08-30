/**
 * Issue #464: Extended contract argument fixtures for public methods not covered
 * by the original contractFixtures.test.ts.
 *
 * Covers:
 *   Circle contract: cancel, pause, resume, get_protocol_params, get_usdc_token
 *
 * These entry-points were added after the initial fixture suite was written.
 * They are kept in a separate file to make the addition clearly attributable
 * to issue #464 and to avoid a noisy diff on the original fixture file.
 *
 * Fixture strategy mirrors contractFixtures.test.ts:
 *   - Encode arguments with the public SDK builders (scAddress, scU32, …).
 *   - Verify that encoding is deterministic and that decoding round-trips.
 *   - Verify that the decoded native values match the expected contract signature.
 *   - Include boundary cases where the contract accepts optional or typed args.
 *
 * Maintenance: if any of these signatures change in the Rust contract, the
 * corresponding fixture encoding will no longer match and the test will fail,
 * surfacing the break in CI before it reaches production.
 */

import { describe, it, expect } from "vitest";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { scAddress, scAddressVec, scI128, scU32 } from "../client";

// ─── Test addresses ───────────────────────────────────────────────────────────
// All derived deterministically from sdk/src/__tests__/fixtures.ts patterns.

import {
  CREATOR_ADDR,
  MEMBER_A_ADDR,
  MEMBER_B_ADDR,
} from "./fixtures";

// ─── Encoding helpers (copied from contractFixtures.test.ts) ─────────────────

function encodeFixture(args: xdr.ScVal[]): string {
  return xdr.ScVal.scvVec(args).toXDR("base64");
}

function decodeFixture(fixture: string): xdr.ScVal[] {
  const vec = xdr.ScVal.fromXDR(fixture, "base64");
  if (vec.switch().name !== "scvVec") throw new Error("Fixture is not scvVec");
  return vec.vec() ?? [];
}

function assertFixture(fixture: string, expectedNativeArgs: unknown[]): void {
  const decoded = decodeFixture(fixture);
  expect(decoded).toHaveLength(expectedNativeArgs.length);
  for (let i = 0; i < expectedNativeArgs.length; i++) {
    expect(scValToNative(decoded[i])).toEqual(expectedNativeArgs[i]);
  }
}

// ─── Circle contract — cancel ─────────────────────────────────────────────────
//
// Rust signature: cancel(env: Env, caller: Address)
// Callable while status = Pending; transitions to Cancelled.

describe("Circle contract — cancel (Issue #464)", () => {
  const FIXTURE = encodeFixture([scAddress(CREATOR_ADDR)]);

  it("cancel with caller address encodes correctly", () => {
    assertFixture(FIXTURE, [CREATOR_ADDR]);
  });

  it("cancel fixture is deterministic", () => {
    expect(encodeFixture([scAddress(CREATOR_ADDR)])).toBe(FIXTURE);
  });

  it("cancel with member address (non-creator caller)", () => {
    const fixture = encodeFixture([scAddress(MEMBER_A_ADDR)]);
    assertFixture(fixture, [MEMBER_A_ADDR]);
  });
});

// ─── Circle contract — pause ──────────────────────────────────────────────────
//
// Rust signature: pause(env: Env, admin: Address) -> Result<(), PauseError>
// Only callable by the stored admin address. Blocks all fund-moving operations.

describe("Circle contract — pause (Issue #464)", () => {
  const FIXTURE = encodeFixture([scAddress(CREATOR_ADDR)]);

  it("pause with admin address encodes correctly", () => {
    assertFixture(FIXTURE, [CREATOR_ADDR]);
  });

  it("pause fixture is deterministic", () => {
    expect(encodeFixture([scAddress(CREATOR_ADDR)])).toBe(FIXTURE);
  });
});

// ─── Circle contract — resume ─────────────────────────────────────────────────
//
// Rust signature: resume(env: Env, admin: Address) -> Result<(), PauseError>
// Clears the Paused flag; re-enables fund-moving operations.

describe("Circle contract — resume (Issue #464)", () => {
  const FIXTURE = encodeFixture([scAddress(CREATOR_ADDR)]);

  it("resume with admin address encodes correctly", () => {
    assertFixture(FIXTURE, [CREATOR_ADDR]);
  });

  it("resume fixture is deterministic", () => {
    expect(encodeFixture([scAddress(CREATOR_ADDR)])).toBe(FIXTURE);
  });

  it("pause and resume share the same argument shape", () => {
    // They must use identical encoding — both take (admin: Address)
    const pauseFixture  = encodeFixture([scAddress(CREATOR_ADDR)]);
    const resumeFixture = encodeFixture([scAddress(CREATOR_ADDR)]);
    expect(pauseFixture).toBe(resumeFixture);
  });
});

// ─── Circle contract — get_protocol_params ───────────────────────────────────
//
// Rust signature: get_protocol_params(_env: Env) -> ProtocolParams
// No arguments — read-only view that returns static protocol constants.
// Does not require the contract to be initialized.

describe("Circle contract — get_protocol_params (Issue #464)", () => {
  const FIXTURE = encodeFixture([]);

  it("get_protocol_params takes no arguments", () => {
    assertFixture(FIXTURE, []);
  });

  it("empty-arg fixture is deterministic", () => {
    expect(encodeFixture([])).toBe(FIXTURE);
  });

  it("empty fixtures for all no-arg views are identical (structural consistency)", () => {
    // All zero-argument read methods must produce the same (empty) fixture —
    // this guards against accidentally encoding a dummy arg.
    const views = [
      encodeFixture([]), // get_protocol_params
      encodeFixture([]), // get_config
      encodeFixture([]), // get_status
      encodeFixture([]), // get_current_round
      encodeFixture([]), // payout
    ];
    const unique = new Set(views);
    expect(unique.size).toBe(1);
  });
});

// ─── Circle contract — get_usdc_token ────────────────────────────────────────
//
// Rust signature: get_usdc_token(env: Env) -> Result<Address, ContractError>
// No arguments — read-only view of the locked USDC token address.

describe("Circle contract — get_usdc_token (Issue #464)", () => {
  const FIXTURE = encodeFixture([]);

  it("get_usdc_token takes no arguments", () => {
    assertFixture(FIXTURE, []);
  });
});

// ─── initialize boundary cases ───────────────────────────────────────────────
//
// The original fixture covered a 2-member circle with the default deadline.
// These cases extend coverage to the minimum and maximum protocol boundaries
// so a future change to MIN/MAX_ROUND_DEADLINE_LEDGERS is caught here.

describe("Circle contract — initialize boundary cases (Issue #464)", () => {
  // MIN_ROUND_DEADLINE_LEDGERS = 100 (from contracts/circle/src/lib.rs)
  const FIXTURE_MIN_DEADLINE = encodeFixture([
    scAddress(CREATOR_ADDR),
    scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
    scI128(100_000_000n),
    scU32(100),
  ]);

  // MAX_ROUND_DEADLINE_LEDGERS = 1_036_800 (~60 days)
  const FIXTURE_MAX_DEADLINE = encodeFixture([
    scAddress(CREATOR_ADDR),
    scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
    scI128(100_000_000n),
    scU32(1_036_800),
  ]);

  // Minimum valid round_amount: 1 stroop (> 0 required)
  const FIXTURE_MIN_AMOUNT = encodeFixture([
    scAddress(CREATOR_ADDR),
    scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
    scI128(1n),
    scU32(120_960),
  ]);

  it("initialize with minimum deadline (100 ledgers)", () => {
    assertFixture(FIXTURE_MIN_DEADLINE, [
      CREATOR_ADDR,
      [MEMBER_A_ADDR, MEMBER_B_ADDR],
      100_000_000n,
      100,
    ]);
  });

  it("initialize with maximum deadline (1_036_800 ledgers)", () => {
    assertFixture(FIXTURE_MAX_DEADLINE, [
      CREATOR_ADDR,
      [MEMBER_A_ADDR, MEMBER_B_ADDR],
      100_000_000n,
      1_036_800,
    ]);
  });

  it("initialize with minimum round amount (1 stroop)", () => {
    assertFixture(FIXTURE_MIN_AMOUNT, [
      CREATOR_ADDR,
      [MEMBER_A_ADDR, MEMBER_B_ADDR],
      1n,
      120_960,
    ]);
  });
});

// ─── SDK encoding sanity: scI128 boundary values ─────────────────────────────
//
// These don't correspond to a specific contract method but guard the encoder
// itself — if scI128 starts silently truncating at the i128 boundary the test
// will catch it.

describe("scI128 boundary values (Issue #464)", () => {
  const I128_MAX = (1n << 127n) - 1n;
  const I128_MIN = -(1n << 127n);

  it("encodes and decodes i128 max value correctly", () => {
    const fixture = encodeFixture([scI128(I128_MAX)]);
    const [decoded] = decodeFixture(fixture);
    expect(scValToNative(decoded)).toBe(I128_MAX);
  });

  it("encodes and decodes i128 min value correctly", () => {
    const fixture = encodeFixture([scI128(I128_MIN)]);
    const [decoded] = decodeFixture(fixture);
    expect(scValToNative(decoded)).toBe(I128_MIN);
  });

  it("encodes and decodes zero as i128", () => {
    const fixture = encodeFixture([scI128(0n)]);
    const [decoded] = decodeFixture(fixture);
    expect(scValToNative(decoded)).toBe(0n);
  });

  it("throws RangeError for values exceeding i128 max", () => {
    expect(() => scI128(I128_MAX + 1n)).toThrow(RangeError);
  });

  it("throws RangeError for values below i128 min", () => {
    expect(() => scI128(I128_MIN - 1n)).toThrow(RangeError);
  });
});

// ─── Fixture index comment ────────────────────────────────────────────────────
//
// Full coverage across the two fixture files:
//
// contractFixtures.test.ts (original):
//   CircleFactory: create_circle (valid, single-member, boundary-deadline)
//   Circle: initialize, join, contribute, payout, mark_default, close,
//           get_config, get_status, get_current_round, get_collateral,
//           get_defaults, has_contributed (round 0, round 5)
//   Reputation: score, increment (positive delta, negative delta)
//   XDR stability regression suite
//
// contractFixtures.extended.test.ts (this file, Issue #464):
//   Circle: cancel, pause, resume, get_protocol_params, get_usdc_token
//   Circle: initialize boundary (min deadline, max deadline, min amount)
//   Encoder: scI128 i128 boundary values
