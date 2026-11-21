/**
 * Payout rotation semantics (#873).
 *
 * The member list passed to `FactoryClient.createCircle` is forwarded
 * unchanged to the factory, which forwards it unchanged to the circle's
 * `initialize`. The circle stores it verbatim and pays round `i`'s pot to
 * `members[i]`:
 *
 * - order is preserved exactly — nothing on the path sorts addresses;
 * - round 0 (displayed as "round 1") pays `members[0]`;
 * - the creator is a member **only if** their address is in the list; the
 *   factory never adds the creator;
 * - join order (`circle/joined` `join_order`) never affects the rotation;
 * - each member is scheduled exactly once per full cycle (members are unique).
 */

export interface RotationSlot {
  /** 0-based round index, as stored on-chain (`RoundState.round_index`). */
  roundIndex: number;
  /** 1-based round number for display. */
  roundNumber: number;
  /** Address that receives this round's pot. */
  recipient: string;
}

/** Recipient of `roundIndex` (0-based), or `undefined` when out of range. */
export function recipientForRound(members: readonly string[], roundIndex: number): string | undefined {
  if (!Number.isInteger(roundIndex) || roundIndex < 0) return undefined;
  return members[roundIndex];
}

/**
 * The full payout schedule in on-chain order.
 *
 * @throws Error when `members` contains a duplicate — the contract rejects
 *   such lists at `initialize`, so a duplicate means the input is not a real
 *   circle's member list.
 */
export function payoutSchedule(members: readonly string[]): RotationSlot[] {
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m)) throw new Error(`duplicate member in rotation: ${m}`);
    seen.add(m);
  }
  return members.map((recipient, roundIndex) => ({
    roundIndex,
    roundNumber: roundIndex + 1,
    recipient,
  }));
}

/** 0-based rotation slot of `member`, or `-1` when not a member. */
export function payoutSlotOf(members: readonly string[], member: string): number {
  return members.indexOf(member);
}
