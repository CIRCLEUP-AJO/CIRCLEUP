/**
 * Arguments for the factory's `create_circle` (#873).
 *
 * Contract signature (contracts/circle_factory/src/lib.rs):
 *
 * ```text
 * create_circle(creator: Address, members: Vec<Address>,
 *               round_amount: i128, round_deadline_ledgers: u32) -> Address
 * ```
 *
 * - `members` is forwarded unchanged to the circle's `initialize` and becomes
 *   the payout rotation: `members[0]` receives round 1's pot, and so on.
 *   This helper never sorts or de-duplicates; validation happens before.
 * - `creator` authorizes and pays for the call. The factory does **not** add
 *   the creator as a member — they participate only if listed in `members`.
 * - The circle name is display-only and is not sent on-chain (the factory
 *   has no name parameter).
 */
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export interface CreateCircleArgsInput {
  creator: string;
  /** Validated member addresses, in the order shown in the form. */
  members: readonly string[];
  amountStroops: bigint;
  deadlineLedgers: number;
}

export function buildCreateCircleArgs(input: CreateCircleArgsInput): xdr.ScVal[] {
  return [
    new Address(input.creator).toScVal(),
    xdr.ScVal.scvVec(input.members.map((m) => new Address(m).toScVal())),
    nativeToScVal(input.amountStroops, { type: "i128" }),
    nativeToScVal(input.deadlineLedgers, { type: "u32" }),
  ];
}

/** The rotation the form will create, for preview: round number → address. */
export function previewRotation(members: readonly string[]): Array<{ round: number; address: string }> {
  return members.map((address, i) => ({ round: i + 1, address }));
}
