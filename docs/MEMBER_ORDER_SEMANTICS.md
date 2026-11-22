# Member Order Semantics

Issue #873. This traces the member list from the create form to the last
payout.

## Rules

1. **Order is preserved exactly.** No layer sorts, re-orders or
   de-duplicates the list. Duplicates are rejected, not removed.
2. **Rotation = list order.** `members[i]` receives the pot of round `i`
   (0-based on-chain; shown as round `i + 1` in the UI).
3. **First payout slot.** Round 0's recipient is `members[0]`, chosen at
   `initialize`, while the circle is still Pending.
4. **Join order is irrelevant.** `circle/joined` carries `join_order`
   (1-based queue position) for progress display only. It never changes the
   rotation.
5. **The creator is not added automatically.** `create_circle(creator, …)`
   uses `creator` for authorization, the deploy salt and the
   `circle_created` event only. A creator who wants to take part includes
   their own address in the list, in the slot they want.
6. **Once per cycle.** Members are unique, so each is scheduled exactly once
   per full cycle of `member_count` rounds.

## Trace

| Step | Code | What happens to `members` |
|---|---|---|
| Create form | `app/src/app/create/CreateClient.tsx` → `buildCreateCircleArgs` (`app/src/lib/createCircleArgs.ts`) | Filled, validated rows in on-screen order, encoded as `Vec<Address>`. Not sorted. |
| SDK | `FactoryClient.createCircle` (`sdk/src/client.ts`) | `scAddressVec(params.members)`, order unchanged. |
| Factory | `create_circle` (`contracts/circle_factory/src/lib.rs`) | `validate_create_inputs` (count, uniqueness, amounts) reads only; the same `members` value is passed to `initialize`. |
| Circle | `initialize` (`contracts/circle/src/lib.rs`) | Stored verbatim in `CircleConfig.members`; `CurrentRound.recipient = members[0]`; `circle/initialized` v2 emits `members` in the same order. |
| Payout | `payout` / `settle_round` | Recipient must equal `members[round_index]` (cross-checked); the next round's recipient is `members[round_index + 1]`. |
| Indexer | `circle/initialized` handler (`indexer/src/indexer.ts`) | `unnest … WITH ORDINALITY` → `circle_members.payout_order = position − 1`. Member reads `ORDER BY payout_order`. |
| SDK helpers | `payoutSchedule`, `recipientForRound`, `payoutSlotOf` (`sdk/src/rotation.ts`) | Pure views of the same rule. |
| UI | Create page copy, `WorkflowBanner`, member list ordered by `payout_order` | Explains that the list order is the payout order and that join time doesn't matter. |

## Fixes made for this issue

- The create form sent the factory a fifth `name` argument that
  `create_circle` does not accept. It now sends exactly
  `(creator, members, round_amount, round_deadline_ledgers)`. The name is
  display-only.
- The create form refused the creator's own address with the message "The
  circle creator is automatically a member". That was false, because the
  factory never adds the creator, so creators could not participate at all.
  The block is removed, and the page explains that creators must list
  themselves.
- `WorkflowBanner` said the payout order is "recorded on-chain at join time".
  It is fixed at creation by list position.

## Tests

| Layer | Test |
|---|---|
| Contract | `contracts/circle/tests/member_order_tests.rs`: input order preserved in config and the `initialized` event; 2-member descending-address full cycle with reversed join order; join order independent of rotation (5 members); **256-member** non-sorted full cycle that asserts every recipient and that each member is paid exactly once |
| Indexer | `eventSchemas.test.ts`: `payout_order` taken from event position, no sorting |
| SDK | `sdk/src/__tests__/penaltyAndRotation.test.ts`: schedule order, 256-slot permutation, duplicates rejected |
| App | `app/src/lib/penaltyAndCreateArgs.test.ts`: exact 4-argument encoding, non-sorted members (creator included) preserved |

The 256-member contract test makes real `join` and `payout` calls, but
injects each round's contribution records instead of making 65,536 real
`contribute` calls. `payout` still verifies the contribution tally, the
canonical recipient and the pot against that state.
