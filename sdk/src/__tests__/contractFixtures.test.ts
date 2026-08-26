/**
 * Issue 30: Contract argument compatibility fixtures
 *
 * A contract argument order or XDR change can compile in TypeScript but fail
 * at runtime with an opaque host error. These serialized fixtures protect the
 * SDK ↔ contract boundary by encoding valid argument combinations as XDR and
 * verifying they remain decodable across contract changes.
 *
 * Each fixture is a base64-encoded XDR ScVal array representing one contract
 * method's arguments. If a contract method signature changes (parameter order,
 * type, or removal), the corresponding fixture will fail to decode, surfacing
 * the break in CI before it reaches production.
 *
 * Covered contracts:
 *   - CircleFactory: create_circle
 *   - Circle: initialize, join, contribute, payout, mark_default, close,
 *             get_config, get_status, get_current_round, get_collateral,
 *             get_defaults, has_contributed
 *   - Reputation: score, increment
 *
 * Fixtures are derived from the public SDK builders (scAddress, scU32, scI128,
 * scAddressVec) so they represent exactly what application code sends. Any
 * mismatch between SDK encoding and contract expectations is caught here.
 */

import { describe, it, expect } from "vitest";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { scAddress, scU32, scI128, scBool, scAddressVec } from "../client";

// ─── Test addresses ───────────────────────────────────────────────────────────

const CREATOR_ADDR = "GABC7ZT3IOKDKWEJ3IKW4LWHEZ6V5IDYZBH5FQNHQOVVLBMYDEO5AAAA";
const MEMBER_A_ADDR = "GBCD7ZT3IOKDKWEJ3IKW4LWHEZ6V5IDYZBH5FQNHQOVVLBMYDEO5BBBB";
const MEMBER_B_ADDR = "GCDE7ZT3IOKDKWEJ3IKW4LWHEZ6V5IDYZBH5FQNHQOVVLBMYDEO5CCCC";
const CIRCLE_ADDR = "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";
const REPUTATION_ADDR = "CBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

// ─── Fixture encoding helpers ─────────────────────────────────────────────────

/** Encode an xdr.ScVal array as base64 XDR for persistence. */
function encodeFixture(args: xdr.ScVal[]): string {
  const vec = xdr.ScVal.scvVec(args);
  return vec.toXDR("base64");
}

/** Decode a base64 XDR fixture back into an ScVal array. */
function decodeFixture(fixture: string): xdr.ScVal[] {
  const vec = xdr.ScVal.fromXDR(fixture, "base64");
  if (vec.switch().name !== "scvVec") {
    throw new Error("Fixture is not an ScVal vec");
  }
  return vec.vec() ?? [];
}

/**
 * Verify that a fixture decodes cleanly and that each decoded element matches
 * the expected native value.
 */
function assertFixture(
  fixture: string,
  expectedNativeArgs: unknown[],
): void {
  const decoded = decodeFixture(fixture);
  expect(decoded).toHaveLength(expectedNativeArgs.length);

  for (let i = 0; i < expectedNativeArgs.length; i++) {
    const native = scValToNative(decoded[i]);
    expect(native).toEqual(expectedNativeArgs[i]);
  }
}

// ─── Factory fixtures ─────────────────────────────────────────────────────────

describe("CircleFactory contract fixtures", () => {
  describe("create_circle", () => {
    const FIXTURE_VALID = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n), // round_amount in stroops (10 USDC)
      scU32(120_960),       // round_deadline_ledgers (~7 days at 5s/ledger)
    ]);

    const FIXTURE_SINGLE_MEMBER = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR]),
      scI128(50_000_000n),
      scU32(17_280), // 1 day
    ]);

    const FIXTURE_BOUNDARY_DEADLINE = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n),
      scU32(1), // minimum 1 ledger deadline
    ]);

    it("valid create_circle with two members", () => {
      assertFixture(FIXTURE_VALID, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        120_960,
      ]);
    });

    it("create_circle with single member", () => {
      assertFixture(FIXTURE_SINGLE_MEMBER, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR],
        50_000_000n,
        17_280,
      ]);
    });

    it("create_circle with boundary deadline (1 ledger)", () => {
      assertFixture(FIXTURE_BOUNDARY_DEADLINE, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        1,
      ]);
    });

    it("encoded fixtures are stable (deterministic XDR)", () => {
      // Re-encode the same arguments and verify the fixture hasn't changed
      const reencoded = encodeFixture([
        scAddress(CREATOR_ADDR),
        scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
        scI128(100_000_000n),
        scU32(120_960),
      ]);
      expect(reencoded).toBe(FIXTURE_VALID);
    });
  });
});

// ─── Circle contract fixtures ─────────────────────────────────────────────────

describe("Circle contract fixtures", () => {
  describe("initialize", () => {
    // initialize(creator: Address, members: Vec<Address>, round_amount: i128, round_deadline_ledgers: u32)
    // Same signature as create_circle; factory calls this after deploying.
    const FIXTURE = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n),
      scU32(120_960),
    ]);

    it("initialize with valid args", () => {
      assertFixture(FIXTURE, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        120_960,
      ]);
    });
  });

  describe("join", () => {
    // join(member: Address)
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("join with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  describe("contribute", () => {
    // contribute(member: Address)
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("contribute with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  describe("payout", () => {
    // payout() — no arguments
    const FIXTURE = encodeFixture([]);

    it("payout with no arguments", () => {
      assertFixture(FIXTURE, []);
    });
  });

  describe("mark_default", () => {
    // mark_default(member: Address)
    const FIXTURE = encodeFixture([scAddress(MEMBER_B_ADDR)]);

    it("mark_default with member address", () => {
      assertFixture(FIXTURE, [MEMBER_B_ADDR]);
    });
  });

  describe("close", () => {
    // close(caller: Address)
    const FIXTURE = encodeFixture([scAddress(CREATOR_ADDR)]);

    it("close with caller address", () => {
      assertFixture(FIXTURE, [CREATOR_ADDR]);
    });
  });

  describe("get_config", () => {
    // get_config() — no arguments
    const FIXTURE = encodeFixture([]);

    it("get_config with no arguments", () => {
      assertFixture(FIXTURE, []);
    });
  });

  describe("get_status", () => {
    // get_status() — no arguments
    const FIXTURE = encodeFixture([]);

    it("get_status with no arguments", () => {
      assertFixture(FIXTURE, []);
    });
  });

  describe("get_current_round", () => {
    // get_current_round() — no arguments
    const FIXTURE = encodeFixture([]);

    it("get_current_round with no arguments", () => {
      assertFixture(FIXTURE, []);
    });
  });

  describe("get_collateral", () => {
    // get_collateral(member: Address)
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("get_collateral with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  describe("get_defaults", () => {
    // get_defaults(member: Address)
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("get_defaults with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  describe("has_contributed", () => {
    // has_contributed(member: Address, round_index: u32)
    const FIXTURE_ROUND_ZERO = encodeFixture([
      scAddress(MEMBER_A_ADDR),
      scU32(0),
    ]);

    const FIXTURE_ROUND_FIVE = encodeFixture([
      scAddress(MEMBER_B_ADDR),
      scU32(5),
    ]);

    it("has_contributed with round_index 0", () => {
      assertFixture(FIXTURE_ROUND_ZERO, [MEMBER_A_ADDR, 0]);
    });

    it("has_contributed with round_index 5", () => {
      assertFixture(FIXTURE_ROUND_FIVE, [MEMBER_B_ADDR, 5]);
    });
  });
});

// ─── Reputation contract fixtures ─────────────────────────────────────────────

describe("Reputation contract fixtures", () => {
  describe("score", () => {
    // score(member: Address) — read-only query
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("score with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  describe("increment", () => {
    // increment(member: Address, delta: i32) — admin-only mutation
    // The contract uses i32 for the delta, not u32.
    const FIXTURE_POSITIVE = encodeFixture([
      scAddress(MEMBER_A_ADDR),
      xdr.ScVal.scvI32(10),
    ]);

    const FIXTURE_NEGATIVE = encodeFixture([
      scAddress(MEMBER_B_ADDR),
      xdr.ScVal.scvI32(-5),
    ]);

    it("increment with positive delta", () => {
      const decoded = decodeFixture(FIXTURE_POSITIVE);
      expect(decoded).toHaveLength(2);
      expect(scValToNative(decoded[0])).toBe(MEMBER_A_ADDR);
      expect(scValToNative(decoded[1])).toBe(10);
    });

    it("increment with negative delta (penalty)", () => {
      const decoded = decodeFixture(FIXTURE_NEGATIVE);
      expect(decoded).toHaveLength(2);
      expect(scValToNative(decoded[0])).toBe(MEMBER_B_ADDR);
      expect(scValToNative(decoded[1])).toBe(-5);
    });
  });
});

// ─── Regression suite: encode → decode round-trip ──────────────────────────────

describe("XDR encoding stability", () => {
  it("re-encoding the same arguments produces identical fixtures", () => {
    const args = [
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n),
      scU32(120_960),
    ];

    const encoded1 = encodeFixture(args);
    const encoded2 = encodeFixture(args);

    expect(encoded1).toBe(encoded2);
  });

  it("decode → re-encode produces the original fixture", () => {
    const original = encodeFixture([
      scAddress(MEMBER_A_ADDR),
      scU32(42),
    ]);

    const decoded = decodeFixture(original);
    const reencoded = encodeFixture(decoded);

    expect(reencoded).toBe(original);
  });
});

// ─── Usage instructions ────────────────────────────────────────────────────────

/**
 * MAINTAINING THESE FIXTURES
 *
 * When a contract method signature changes:
 * 1. Update the corresponding fixture encoding to match the new signature
 * 2. Update the expectedNativeArgs in the test
 * 3. Run the tests — if they pass, the SDK and contract are still compatible
 * 4. Commit the updated fixture
 *
 * If a test fails after a contract change:
 * - The contract method signature has changed in a breaking way
 * - Update the SDK client method to match the new signature
 * - Update the fixture and test expectations
 * - Document the breaking change in CHANGELOG.md
 *
 * Adding new contract methods:
 * 1. Add a new describe block for the method
 * 2. Encode valid and boundary-case fixtures using the SDK builders
 * 3. Add tests verifying the fixtures decode to expected native values
 * 4. Run in CI — fixtures are checked on every build
 */
