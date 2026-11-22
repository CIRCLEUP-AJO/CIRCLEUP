//! Default-penalty boundaries (#874).
//!
//! Rule under test (contracts/circle/src/lib.rs, `mark_default` and
//! `settle_round`):
//!
//! ```text
//! penalty        = collateral * PENALTY_BPS / BPS_DENOM   // = floor(collateral / 5)
//! new_collateral = collateral - penalty
//! ```
//!
//! All values are i128 base units (stroops). `collateral` is never negative,
//! so Rust's truncating division is a **floor**: fractional base units are
//! dropped in the member's favour, never rounded up and never rejected.
//! Consequences pinned here:
//!
//! * collateral 1–4 → penalty 0 (the default is still recorded and counted);
//! * collateral ≥ 1 never reaches 0 through penalties (floor(c/5) < c);
//! * each (member, round) is charged at most once across `mark_default`
//!   and `settle_round` (`Defaulted(member, round)` marker).

mod common;

use circle::{CircleStatus, ContractError, BPS_DENOM, PENALTY_BPS};
use common::{code, gen_members, new_env, setup, Circle};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address};

fn floor_penalty(c: i128) -> i128 {
    c * PENALTY_BPS / BPS_DENOM
}

/// Decoded `default` events: `(member, penalty, round_index, new_collateral)`.
fn defaults_emitted(c: &Circle, before: u32) -> std::vec::Vec<(Address, i128, u32, i128)> {
    c.circle_events_since(before)
        .into_iter()
        .filter(|(name, _)| *name == c.sym("default"))
        .map(|(_, data)| {
            let (_circle, member, penalty, round, new_c): (Address, Address, i128, u32, i128) =
                c.data(&data);
            (member, penalty, round, new_c)
        })
        .collect()
}

/// 2-member circle with collateral == `round_amount`; member 0 contributed,
/// member 1 did not, ledger is one past the deadline.
fn missed_round(round_amount: i128) -> Circle {
    let env = new_env();
    let members = gen_members(&env, 2);
    let c = setup(env, members, round_amount);
    c.join_all();
    c.contribute(0);
    c.advance_past_deadline();
    c
}

#[test]
fn rule_is_floor_of_one_fifth() {
    assert_eq!(PENALTY_BPS, 2_000);
    assert_eq!(BPS_DENOM, 10_000);
    for c in 0..=1_000i128 {
        assert_eq!(floor_penalty(c), c / 5, "collateral {c}");
    }
}

/// Hand-derived boundary table: (collateral, penalty, new_collateral).
const BOUNDARIES: [(i128, i128, i128); 10] = [
    (1, 0, 1),                       // smallest supported contribution
    (4, 0, 4),                       // largest zero-penalty balance
    (5, 1, 4),                       // first non-zero penalty
    (9, 1, 8),                       // 1.8 floors to 1
    (10, 2, 8),                      // exact
    (9_999, 1_999, 8_000),           // 1999.8 floors to 1999
    (10_000, 2_000, 8_000),          // exact BPS_DENOM multiple
    (10_001, 2_000, 8_001),          // 2000.2 floors to 2000
    (10_000_000, 2_000_000, 8_000_000), // 1 USDC
    (100_000_000, 20_000_000, 80_000_000), // 10 USDC
];

#[test]
fn single_default_boundaries_match_hand_derived_table() {
    for (collateral, want_penalty, want_new) in BOUNDARIES {
        assert_eq!(floor_penalty(collateral), want_penalty, "table row {collateral}");
        let c = missed_round(collateral);
        let bob = c.member(1);
        let bob_bal = c.balance(&bob);
        let custody = c.circle_balance();
        assert_eq!(c.client.get_collateral(&bob), collateral);
        assert_eq!(c.client.get_defaults(&bob), 0);

        let ev = c.event_count();
        c.client.mark_default(&bob);

        assert_eq!(c.client.get_collateral(&bob), want_new, "collateral {collateral}");
        assert_eq!(c.client.get_defaults(&bob), 1);
        assert_eq!(
            defaults_emitted(&c, ev),
            std::vec![(bob.clone(), want_penalty, 0u32, want_new)]
        );
        // A penalty is a bookkeeping reduction: no tokens move.
        assert_eq!(c.balance(&bob), bob_bal);
        assert_eq!(c.circle_balance(), custody);
    }
}

#[test]
fn default_is_rejected_at_the_exact_deadline_ledger() {
    let env = new_env();
    let members = gen_members(&env, 2);
    let c = setup(env, members, 10_000_000);
    c.join_all();
    c.contribute(0);
    let deadline = c.client.get_current_round().deadline_ledger as u32;
    c.set_ledger(deadline);
    let before = c.snapshot();
    assert_eq!(
        code(c.client.try_mark_default(&c.member(1))),
        Err(ContractError::DeadlineNotPassed as u32)
    );
    assert_eq!(c.snapshot(), before);
    c.set_ledger(deadline + 1);
    c.client.mark_default(&c.member(1));
}

#[test]
fn repeated_default_same_round_never_double_charges() {
    let env = new_env();
    let members = gen_members(&env, 3);
    let c = setup(env, members, 100);
    c.join_all();
    c.contribute(0);
    c.contribute(1);
    c.advance_past_deadline();
    let carol = c.member(2);

    c.client.mark_default(&carol);
    assert_eq!(c.client.get_collateral(&carol), 80);

    // Second mark_default for the same (member, round): typed rejection, no change.
    let before = c.snapshot();
    let ev = c.event_count();
    assert_eq!(
        code(c.client.try_mark_default(&carol)),
        Err(ContractError::AlreadyDefaulted as u32)
    );
    assert_eq!(c.snapshot(), before);
    assert!(defaults_emitted(&c, ev).is_empty());

    // settle_round skips members already flagged this round.
    let ev = c.event_count();
    c.client.settle_round();
    assert!(defaults_emitted(&c, ev).is_empty(), "settle_round must not re-penalise carol");
    assert_eq!(c.client.get_collateral(&carol), 80);
    assert_eq!(c.client.get_defaults(&carol), 1);
}

#[test]
fn settle_round_alone_charges_each_missing_member_once() {
    let env = new_env();
    let members = gen_members(&env, 3);
    let c = setup(env, members, 1_000);
    c.join_all();
    c.contribute(0);
    c.advance_past_deadline();

    let ev = c.event_count();
    c.client.settle_round();
    let emitted = defaults_emitted(&c, ev);
    assert_eq!(
        emitted,
        std::vec![(c.member(1), 200, 0, 800), (c.member(2), 200, 0, 800)]
    );
    assert_eq!(c.client.get_defaults(&c.member(1)), 1);
    assert_eq!(c.client.get_defaults(&c.member(2)), 1);
    assert_eq!(c.client.get_defaults(&c.member(0)), 0);
}

/// Dave misses every round of a 4-member circle.
fn dave_defaults_every_round(round_amount: i128) -> (Circle, std::vec::Vec<(i128, i128)>) {
    let env = new_env();
    let members = gen_members(&env, 4);
    let c = setup(env, members, round_amount);
    c.join_all();
    let dave = c.member(3);
    let mut seen = std::vec::Vec::new();
    for round in 0..4u32 {
        for i in 0..3 {
            c.contribute(i);
        }
        c.advance_past_deadline();
        let ev = c.event_count();
        c.client.mark_default(&dave);
        let e = defaults_emitted(&c, ev);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].2, round);
        seen.push((e[0].1, e[0].3));
        c.client.settle_round();
    }
    assert_eq!(c.client.get_status(), CircleStatus::Completed);
    (c, seen)
}

#[test]
fn repeated_missed_rounds_decay_on_remaining_balance_with_floor() {
    // 100 → 80 → 64 → 52 → 42 (12.8 and 10.4 floor to 12 and 10).
    let (c, seen) = dave_defaults_every_round(100);
    assert_eq!(seen, std::vec![(20, 80), (16, 64), (12, 52), (10, 42)]);
    let dave = c.member(3);
    assert_eq!(c.client.get_collateral(&dave), 42);
    assert_eq!(c.client.get_defaults(&dave), 4);

    // Custody = remaining collateral (3 × 100 + 42) + forfeited penalties (58).
    assert_eq!(c.circle_balance(), 400);
    c.client.close(&dave);
    assert_eq!(c.circle_balance(), 58, "forfeited penalties stay in the contract");
}

#[test]
fn smallest_contribution_never_depletes_and_still_counts_defaults() {
    let (c, seen) = dave_defaults_every_round(1);
    assert_eq!(seen, std::vec![(0, 1), (0, 1), (0, 1), (0, 1)]);
    let dave = c.member(3);
    assert_eq!(c.client.get_collateral(&dave), 1);
    assert_eq!(c.client.get_defaults(&dave), 4);
    c.client.close(&dave);
    assert_eq!(c.circle_balance(), 0);
}

#[test]
fn depleted_collateral_is_rejected_without_mutation() {
    let c = missed_round(10_000_000);
    // Zero is unreachable via penalties; injected to pin the guard.
    c.set_collateral(&c.member(1), 0);
    let before = c.snapshot();
    assert_eq!(
        code(c.client.try_mark_default(&c.member(1))),
        Err(ContractError::MemberNotJoined as u32)
    );
    assert_eq!(c.snapshot(), before);
}

#[test]
fn contributor_and_stranger_cannot_be_defaulted() {
    let c = missed_round(10_000_000);
    assert_eq!(
        code(c.client.try_mark_default(&c.member(0))),
        Err(ContractError::MemberContributed as u32)
    );
    assert_eq!(
        code(c.client.try_mark_default(&Address::generate(&c.env))),
        Err(ContractError::NotMember as u32)
    );
}

// ─── Property-based ───────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Pure rule: non-negative, floor, strictly decreasing only from 5 up.
    #[test]
    fn prop_penalty_floor_rule(c in 0i128..=(i128::MAX / PENALTY_BPS)) {
        let p = floor_penalty(c);
        prop_assert!(p >= 0);
        prop_assert!(p * 5 <= c && c < (p + 1) * 5);
        let next = c - p;
        prop_assert!(next >= 0);
        if c >= 1 { prop_assert!(next >= 1, "positive collateral never reaches zero"); }
        prop_assert_eq!(next < c, c >= 5);
    }

    /// Repeated defaults never go negative and never increase collateral.
    #[test]
    fn prop_decay_sequence_monotone_non_negative(start in 0i128..=1_000_000_000_000i128, rounds in 0u32..=256) {
        let mut c = start;
        for _ in 0..rounds {
            let next = c - floor_penalty(c);
            prop_assert!(next >= 0 && next <= c);
            c = next;
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    /// Against the contract: one charge per (member, round), exact floor,
    /// non-negative result, typed rejection on repeat with no mutation.
    #[test]
    fn prop_contract_charges_at_most_once(collateral in 1i128..=1_000_000_000_000i128) {
        let c = missed_round(10_000_000);
        let bob = c.member(1);
        // Arbitrary current balance (e.g. after earlier rounds' penalties).
        c.set_collateral(&bob, collateral);

        let ev = c.event_count();
        c.client.mark_default(&bob);
        let want = collateral - floor_penalty(collateral);
        prop_assert_eq!(c.client.get_collateral(&bob), want);
        prop_assert!(want >= 1);
        let emitted = defaults_emitted(&c, ev);
        prop_assert_eq!(emitted.len(), 1);
        prop_assert_eq!(emitted[0].1, floor_penalty(collateral));

        let before = c.snapshot();
        prop_assert_eq!(
            code(c.client.try_mark_default(&bob)),
            Err(ContractError::AlreadyDefaulted as u32)
        );
        prop_assert_eq!(c.snapshot(), before);
    }
}
