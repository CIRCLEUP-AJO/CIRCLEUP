# Contract Security Review Checklist

Use this checklist when reviewing any pull request that modifies
`contracts/circle/src/lib.rs`, `contracts/circle_factory/src/lib.rs`, or
`contracts/reputation/src/lib.rs`.

**This checklist is a structured prompt, not a substitute for a specialist
security audit.** Ticking every box does not certify that the change is free of
vulnerabilities. When a change is novel in scope (new financial path, new
cross-contract call, new privilege escalation surface) involve a Soroban
security specialist before merging.

---

## How to use this checklist

Reviewers: work through every section that is relevant to the PR and leave an
inline comment quoting the evidence you found. If an item does not apply, note
why. Unexplained blank items block merge.

Authors: paste the relevant sections from this checklist into your PR
description (under the Scope A gate evidence) and fill in the evidence column
before requesting review.

---

## 1. Authorization

Questions to answer for every new or modified entry-point:

- [ ] **Who is permitted to call this function?**  Is the trust boundary
  documented in a comment directly above the `fn` signature?
- [ ] **Is `require_auth()` called on every address that authorises the
  operation?**  Check that `caller.require_auth()` appears before any state
  write, not after.
- [ ] **Can an unpermissioned caller reach this path through a cross-contract
  call?**  Trace any `invoke_contract` path that leads here and verify the
  auth model at each hop.
- [ ] **Does the adversarial test suite cover the unauthorized path?**  Name the
  test (e.g. `guard_reputation_unauthorized_caller_blocked` in
  `contracts/circle/src/mutation_guards.rs`).

Existing tested guarantees:
- `circle.join`, `contribute`, `payout`, `mark_default`, `close` all require the
  caller to sign.  Tests are in `adversarial_tests.rs`.
- `reputation.increment` rejects any caller not in `AuthorizedCallers` and
  rejects revoked callers before checking the allowlist.  Tests are in
  `contracts/reputation/src/lib.rs` unit tests.
- `circle.pause` / `resume` are admin-only (see `PauseError::Unauthorized`).

---

## 2. Arithmetic and overflow

- [ ] **Every multiplication that involves financial amounts uses `checked_mul`
  (or a pre-validated constant).**  The factory pre-checks `round_amount ×
  member_count` and `round_amount × PENALTY_BPS` before deploy gas is spent.
  Confirm the same pattern for any new calculation.
- [ ] **Integer division truncates toward zero in Rust.**  If the result of a
  division is used as a payout or penalty amount, confirm truncation in the
  expected direction (i.e. truncation cannot give a member more than their
  entitlement).
- [ ] **`i128` is the wire type for USDC amounts (stroops).**  Never narrow to
  `u64` or `u32` mid-calculation without a bounds check.
- [ ] **Is the `BPS_DENOM` denominator applied last?**  Multiplying before
  dividing (`amount × BPS / DENOM`) preserves precision; dividing first
  introduces rounding error that can compound over rounds.

Existing tested guarantees:
- `prop_tests.rs` invariant 2 verifies that total collateral released ≤ total
  collateral locked.
- `prop_tests.rs` invariant 3 verifies that penalty per round ≤ collateral
  balance.

---

## 3. Token transfers

- [ ] **Are transfers ordered correctly?**  The pattern is: validate inputs →
  read state → write state → transfer.  Writing state before a transfer prevents
  reentrancy from reading stale balances.  Do not transfer tokens before
  updating the contract's own records.
- [ ] **Is the transfer recipient correct?**  Confirm the destination address is
  the intended recipient, not the contract itself.  A self-transfer would lock
  funds permanently.
- [ ] **Is the transfer amount bounded?**  Verify the amount cannot be zero,
  negative, or larger than the contract's balance.
- [ ] **Is the token address validated?**  The circle contract guards against
  `usdc_token == contract_address` (`InitError::InvalidTokenAddress`).  Any new
  token interaction should have a parallel guard.

---

## 4. Reentrancy

- [ ] **Does the entry-point perform a cross-contract call (`invoke_contract` or
  a token client call)?**  List every outbound call.
- [ ] **Is all state written before the outbound call?**  The Soroban
  host does not provide automatic reentrancy guards; the contract must
  enforce checks-effects-interactions manually.
- [ ] **Is the `Initializing` / `Closed` guard pattern extended to this
  entry-point if it is non-atomic?**  See `DataKey::Initializing` in the
  factory and circle contracts for the existing pattern.

Existing tested guarantees:
- `DataKey::Initializing` prevents reentrant `initialize` calls across all three
  contracts.
- `DataKey::Closed` prevents re-invocation of `close`.

---

## 5. Lifecycle and state transitions

- [ ] **Does the entry-point assert the expected `CircleStatus` before
  proceeding?**  Every fund-moving method should panic if the circle is not in
  the correct state (e.g. `join` requires `Pending`, `contribute` requires
  `Active`).
- [ ] **Is the status transition emitted as an event?**  Each status change
  must emit the corresponding event so the indexer can track it (see
  `docs/EVENTS.md`).
- [ ] **Can a paused circle reach this entry-point?**  `DataKey::Paused` blocks
  all fund-moving operations.  Any new fund-moving entry-point must include the
  same pause check.
- [ ] **Is the `Cancelled` lifecycle reachable from the new path?**  Only
  `Pending` circles can be cancelled.  Active or Completed circles cannot revert.

---

## 6. Events

- [ ] **Does every observable state transition emit an event?**  Refer to
  `docs/EVENTS.md` for the canonical list.
- [ ] **Do the emitted topics match the namespace convention?**
  `(Symbol("circle"), Symbol("<event_name>"))` for circle events, etc.
- [ ] **Is the data tuple order and type stable?**  Adding a new trailing field
  is backwards-compatible; reordering or removing fields is breaking and requires
  a new event name.
- [ ] **Does the indexer have a handler for every new event?**  See gate A6 in
  `CONTRIBUTING.md`.
- [ ] **Are fixture tests updated?**  See `indexer/src/fixtures/event-fixtures.ts`
  and `indexer/src/eventSchemas.test.ts`.

---

## 7. Storage cost

- [ ] **How many new persistent storage entries does this change introduce per
  call?**  Refer to the storage budget table in the circle contract module doc
  comment.
- [ ] **Are new persistent entries cleaned up during `close`?**  Entries that
  grow proportionally to member count or round count must be cleared during
  settlement, or the storage fee will be charged forever.
- [ ] **Are instance-storage entries (caller lists, config, status) bounded in
  size?**  Unbounded `Vec` growth in instance storage can make the contract
  too expensive to invoke.
- [ ] **Has the change been profiled with `stellar-cli contract invoke --cost`?**
  Document the instruction count and read/write byte estimates in the PR.

---

## 8. Rollback semantics

- [ ] **If this entry-point panics partway through, is the contract left in a
  consistent state?**  The Soroban host rolls back all storage writes on a
  panic, so a panic mid-way is safe.  However, **token transfers that already
  completed are not rolled back** by the host.  Confirm no transfer happens
  before all validation.
- [ ] **Is the rollback plan documented in the PR description?**  See gate A9 in
  `CONTRIBUTING.md` — required for any change that modifies on-chain storage
  layout.
- [ ] **Does a failed mutation guard test prove the guard is load-bearing?**  See
  gate A2 in `CONTRIBUTING.md`.

---

## Specialist-review assumptions

The following properties are **assumed** by this checklist but are **not verified
by it**:

- The Soroban host correctly enforces auth requirements across sub-contract calls.
- The Stellar token contract (USDC) behaves according to the SEP-41 interface.
- The WASM compilation target does not introduce undefined behaviour absent in
  the Rust source.
- Economic viability of the ROSCA model under adversarial coordination among
  members.

These assumptions should be evaluated by a Soroban security specialist for any
change that introduces a new financial path or cross-contract privilege.
