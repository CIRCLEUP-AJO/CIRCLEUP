// --- eventParsers.ts ----------------------------------------------------------
//
// Pure, I/O-free functions that parse the data payloads of Soroban contract
// events into typed objects.  Extracted from indexer.ts to reduce that file's
// LOC and make the parsers independently testable.
//
// All three functions throw Error with a descriptive message when the payload
// is malformed � the caller (indexer.ts event handlers) catches and quarantines
// the event.  They have no dependencies on the indexer's database, RPC, or
// logger modules.
export function parseInitializedEvent(value: unknown): {
  circleAddress: string;
  memberCount: number;
  roundAmount: bigint;
  members: string[] | null;
} {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(
      `circle/initialized: expected data tuple [circle_address, member_count, round_amount] ` +
        `but received ${JSON.stringify(value)}`,
    );
  }
  const [circleAddress, memberCount, roundAmount] = value as [
    string,
    number,
    bigint | number,
  ];

  if (typeof circleAddress !== "string" || circleAddress.length === 0) {
    throw new Error(
      `circle/initialized: circle_address must be a non-empty string, got ${JSON.stringify(circleAddress)}`,
    );
  }
  if (
    typeof memberCount !== "number" ||
    !Number.isInteger(memberCount) ||
    memberCount < 2 ||
    memberCount > 256
  ) {
    throw new Error(
      `circle/initialized: member_count must be an integer in [2, 256], got ${JSON.stringify(memberCount)}`,
    );
  }

  let roundAmountBig: bigint;
  if (typeof roundAmount === "bigint") {
    roundAmountBig = roundAmount;
  } else if (typeof roundAmount === "number" && Number.isInteger(roundAmount) && roundAmount > 0) {
    roundAmountBig = BigInt(roundAmount);
  } else {
    throw new Error(
      `circle/initialized: round_amount must be a positive bigint or integer, got ${JSON.stringify(roundAmount)}`,
    );
  }
  if (roundAmountBig <= 0n) {
    throw new Error(
      `circle/initialized: round_amount must be a positive bigint, round_amount must be > 0, got ${roundAmountBig}`,
    );
  }

  let members: string[] | null = null;
  if (value.length > 3) {
    const rawMembers = value[3];
    if (
      !Array.isArray(rawMembers) ||
      !rawMembers.every((m) => typeof m === "string" && m.length > 0)
    ) {
      throw new Error(
        `circle/initialized: members must be an array of addresses, got ${JSON.stringify(rawMembers)}`,
      );
    }
    if (rawMembers.length !== memberCount) {
      throw new Error(
        `circle/initialized: members length ${rawMembers.length} does not match member_count ${memberCount}`,
      );
    }
    if (new Set(rawMembers).size !== rawMembers.length) {
      throw new Error("circle/initialized: members must not contain duplicates");
    }
    members = rawMembers as string[];
  }

  return { circleAddress, memberCount, roundAmount: roundAmountBig, members };
}

/**
 * Parse the data payload of a `circle/joined` event.
 *
 * Contract data tuple (contracts/circle/src/lib.rs — `join` entry-point):
 *   (circle_address: Address, member: Address, join_order: u32, collateral: i128)
 *
 * Invariants:
 *   - `join_order` is in `[1, member_count]` (1-based join-queue position).
 *   - When `join_order == member_count` the circle transitions to Active and
 *     a `circle/active` event follows in the same transaction.
 *   - `collateral` equals `round_amount × COLLATERAL_MULTIPLIER` (always ≥ 0).
 *
 * @throws `Error` with a descriptive message when the payload is malformed or
 *   any field has an unexpected type/value.
 */
export function parseJoinedEvent(value: unknown): {
  circleAddress: string;
  member: string;
  joinOrder: number;
  collateral: bigint;
} {
  if (!Array.isArray(value) || value.length < 4) {
    throw new Error(
      `circle/joined: expected data tuple [circle_address, member, join_order, collateral] ` +
        `but received ${JSON.stringify(value)}`,
    );
  }
  const [circleAddress, member, joinOrder, collateral] = value as [
    string,
    string,
    number,
    bigint | number,
  ];

  if (typeof circleAddress !== "string" || circleAddress.length === 0) {
    throw new Error(
      `circle/joined: circle_address must be a non-empty string, got ${JSON.stringify(circleAddress)}`,
    );
  }
  if (typeof member !== "string" || member.length === 0) {
    throw new Error(
      `circle/joined: member must be a non-empty string, got ${JSON.stringify(member)}`,
    );
  }
  if (typeof joinOrder !== "number" || !Number.isInteger(joinOrder) || joinOrder < 1) {
    throw new Error(
      `circle/joined: join_order must be a positive integer (≥ 1), got ${JSON.stringify(joinOrder)}`,
    );
  }
  // collateral is i128 → bigint after scValToNative; accept plain numbers too
  // (narrower integer types on older SDK versions).
  let collateralBig: bigint;
  if (typeof collateral === "bigint") {
    if (collateral < 0n) {
      throw new Error(
        `circle/joined: collateral must be a non-negative bigint or integer, got ${JSON.stringify(collateral.toString())}`,
      );
    }
    collateralBig = collateral;
  } else if (typeof collateral === "number" && Number.isInteger(collateral) && collateral >= 0) {
    collateralBig = BigInt(collateral);
  } else {
    throw new Error(
      `circle/joined: collateral must be a non-negative bigint or integer, got ${JSON.stringify(collateral)}`,
    );
  }

  return { circleAddress, member, joinOrder, collateral: collateralBig };
}

/**
 * Parse the data payload of a `factory/circle_created` event.
 *
 * Contract data tuple (contracts/circle_factory/src/lib.rs):
 *   (circle_address: Address, creator: Address, circle_index: u32)
 */
export function parseCircleCreatedEvent(value: unknown): {
  circleAddress: string;
  creator: string;
  circleIndex: number;
} {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(
      `factory/circle_created: expected data tuple [address, creator, circle_index] ` +
        `but received ${JSON.stringify(value)}`,
    );
  }
  const [circleAddress, creator, circleIndex] = value as [string, string, number];
  if (typeof circleAddress !== "string" || circleAddress.length === 0) {
    throw new Error(
      `factory/circle_created: circle_address must be a non-empty string, got ${JSON.stringify(circleAddress)}`,
    );
  }
  if (typeof creator !== "string" || creator.length === 0) {
    throw new Error(
      `factory/circle_created: creator must be a non-empty string, got ${JSON.stringify(creator)}`,
    );
  }
  if (typeof circleIndex !== "number" || !Number.isInteger(circleIndex) || circleIndex < 0) {
    throw new Error(
      `factory/circle_created: circle_index must be a non-negative integer, got ${JSON.stringify(circleIndex)}`,
    );
  }
  return { circleAddress, creator, circleIndex };
}
