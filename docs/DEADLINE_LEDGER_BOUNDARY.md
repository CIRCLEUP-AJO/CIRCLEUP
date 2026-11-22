# Deadline Ledger Inclusivity (Issue #54 / #890)

CircleUp treats the **ledger sequence number** as the only authority for round deadlines. Wall-clock time, indexer timestamps and wallet clocks are advisory and can never authorize or reject an on-chain action.

## Authoritative rule

The single predicate is [`deadline_passed`](../contracts/circle/src/lib.rs) in `contracts/circle/src/lib.rs`:

```rust
fn deadline_passed(env: &Env, round: &RoundState) -> bool {
    (env.ledger().sequence() as u64) > round.deadline_ledger
}
```

The comparison is **strictly greater-than**. Therefore `deadline_ledger` is inclusive for contributions and exclusive for punitive actions.

| Ledger sequence | `contribute` | `mark_default` | `settle_round` | `payout` |
|---|---|---|---|---|
| `deadline_ledger - 1` | accepted | rejected (`DeadlineNotPassed`) | rejected (`DeadlineNotPassed`) | not time-gated |
| `deadline_ledger` | **accepted (last valid ledger)** | rejected (`DeadlineNotPassed`) | rejected (`DeadlineNotPassed`) | not time-gated |
| `deadline_ledger + 1` | rejected (`DeadlinePassed`) | accepted | accepted | not time-gated |

`payout` is only gated by status, unpaid round, complete contribution tally and the canonical recipient; it deliberately has no deadline check. Every new round stores a fresh `deadline_ledger` derived from the ledger in which the previous round was paid out.

## Evidence

- Contract helper and its three boundary call sites: [`contracts/circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`deadline_passed`, `contribute`, `mark_default`, `settle_round`).
- Three-adjacent-ledger tests for all time-gated paths: [`deadline_boundary_tests.rs`](../contracts/circle/src/deadline_boundary_tests.rs).
- Existing adversarial and mutation-guard coverage: [`adversarial_tests.rs`](../contracts/circle/src/adversarial_tests.rs), [`mutation_guards.rs`](../contracts/circle/src/mutation_guards.rs).
- Invariant catalogue: [`API_INVARIANTS.md`](./API_INVARIANTS.md) (R5, R8, S9).

Reproduce the contract evidence with:

```bash
cd contracts && cargo test deadline
```

## Client and indexer semantics

- [`sdk/src/gating.ts`](../sdk/src/gating.ts): `gateContribute` blocks only when `latestLedger > deadlineLedger`; `gateDefault` requires `latestLedger > deadlineLedger` and fails closed when the ledger height is unknown.
- [`app/src/lib/gating.ts`](../app/src/lib/gating.ts): mirrors the SDK so equality remains actionable for contributors and ineligible for defaults.
- [`app/src/lib/deadline.ts`](../app/src/lib/deadline.ts): presentation only. `latestLedger === deadlineLedger` renders as **due now**, never as overdue; `latestLedger > deadlineLedger` renders as overdue. Countdown labels always say `estimate`.
- [`indexer/src/api.ts`](../indexer/src/api.ts): computed `deadline_ledger` values are approximations derived from round length because per-round deadlines are not yet indexed. They must not be presented as authoritative.

A stale snapshot blocks writes through app gating. An unknown ledger height blocks punitive default gating but intentionally does not block an otherwise valid contribution; the contract remains the final authority in both cases.

## Error mapping

| Contract error | Stable code | Operator/user meaning |
|---|---|---|
| `ContractError::DeadlinePassed` | `8` | Contribution window closed; the ledger is past the deadline. |
| `ContractError::DeadlineNotPassed` | `9` | Default/settlement cannot run until the ledger is past the deadline. |

Clients must branch on the stable code (see [`CONTRACT_ERRORS.md`](./CONTRACT_ERRORS.md)), never on message text or wall-clock estimates.
