/**
 * App mirrors of penalty rounding (#874) and create_circle argument order (#873).
 */
import { describe, it, expect } from "vitest";
import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";

import { previewDefaultPenalty, PENALTY_RULE_TEXT } from "./penalty";
import { buildCreateCircleArgs, previewRotation } from "./createCircleArgs";

describe("previewDefaultPenalty", () => {
  it.each([
    ["1", 0n, 1n],
    ["4", 0n, 4n],
    ["5", 1n, 4n],
    ["9", 1n, 8n],
    ["9999", 1999n, 8000n],
    ["10001", 2000n, 8001n],
    ["10000000", 2000000n, 8000000n],
  ])("collateral %s → penalty %s, remaining %s", (c, p, r) => {
    expect(previewDefaultPenalty(c)).toEqual({ penalty: p, remaining: r });
  });

  it("returns null for missing or malformed input rather than inventing a figure", () => {
    for (const bad of [null, undefined, "", "abc", "-5", "1.5"]) {
      expect(previewDefaultPenalty(bad as string | null | undefined)).toBeNull();
    }
    expect(previewDefaultPenalty(-1n)).toBeNull();
  });

  it("describes the floor rule", () => {
    expect(PENALTY_RULE_TEXT).toMatch(/rounded down/);
    expect(PENALTY_RULE_TEXT).toMatch(/at most once per round/);
  });
});

describe("buildCreateCircleArgs", () => {
  const addr = (seed: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();
  const creator = addr(1);
  // Deliberately not sorted (descending), and including the creator as a member.
  const members = [addr(9), creator, addr(3)].sort().reverse();

  it("matches the factory signature: creator, members, round_amount, deadline", () => {
    const args = buildCreateCircleArgs({ creator, members, amountStroops: 10_000_000n, deadlineLedgers: 120_960 });
    expect(args).toHaveLength(4);
    expect(scValToNative(args[0])).toBe(creator);
    expect(scValToNative(args[1])).toEqual(members);
    expect(scValToNative(args[2])).toBe(10_000_000n);
    expect(scValToNative(args[3])).toBe(120_960);
    expect(args[1].switch()).toBe(xdr.ScValType.scvVec());
  });

  it("never sorts members", () => {
    const sorted = [...members].sort();
    expect(sorted).not.toEqual(members);
    const args = buildCreateCircleArgs({ creator, members, amountStroops: 1n, deadlineLedgers: 100 });
    expect(scValToNative(args[1])).toEqual(members);
  });

  it("previews the rotation as listed", () => {
    expect(previewRotation(members)).toEqual([
      { round: 1, address: members[0] },
      { round: 2, address: members[1] },
      { round: 3, address: members[2] },
    ]);
  });
});
