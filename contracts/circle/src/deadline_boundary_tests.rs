//! Deadline ledger inclusivity for every time-gated action (issue #890).
//!
//! The contract's single authoritative predicate is
//! `sequence > deadline_ledger`. Consequently the deadline ledger itself is
//! the **last accepted contribution ledger**, and default/settlement become
//! eligible only on the following ledger. `payout` is intentionally not
//! time-gated. Each test below pins all three adjacent ledger values.

#![cfg(test)]
extern crate std;

use crate::test_support::{Fixture, FixtureBuilder, COLLATERAL};
use crate::{CircleStatus, BPS_DENOM, PENALTY_BPS};
use soroban_sdk::testutils::Ledger;

const WINDOW: u32 = 100;

fn fixture_with_window() -> Fixture<'static> {
    FixtureBuilder::default().round_deadline(WINDOW).build()
}

fn set_ledger_at_offset(t: &Fixture<'_>, offset: i64) {
    let deadline = t.circle.get_current_round().deadline_ledger;
    let target = (deadline as i64 + offset) as u32;
    t.env.ledger().with_mut(|l| l.sequence_number = target);
}

#[test]
fn contribution_is_inclusive_of_the_deadline_ledger() {
    for offset in [-1i64, 0, 1] {
        let t = fixture_with_window();
        t.join_all();
        set_ledger_at_offset(&t, offset);

        if offset <= 0 {
            t.circle.contribute(&t.alice);
            assert!(t.circle.has_contributed(&t.alice, &0));
            assert_eq!(t.circle.get_current_round().contributions_received, 1);
        } else {
            assert!(t.circle.try_contribute(&t.alice).is_err());
            assert!(!t.circle.has_contributed(&t.alice, &0));
            assert_eq!(t.circle.get_current_round().contributions_received, 0);
        }
    }
}

#[test]
fn default_is_eligible_only_after_the_deadline_ledger() {
    let penalty = COLLATERAL * PENALTY_BPS / BPS_DENOM;
    for offset in [-1i64, 0, 1] {
        let t = fixture_with_window();
        t.join_all();
        set_ledger_at_offset(&t, offset);

        if offset <= 0 {
            assert!(t.circle.try_mark_default(&t.alice).is_err());
            assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
            assert_eq!(t.circle.get_defaults(&t.alice), 0);
        } else {
            t.circle.mark_default(&t.alice);
            assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL - penalty);
            assert_eq!(t.circle.get_defaults(&t.alice), 1);
        }
    }
}

#[test]
fn settlement_uses_the_same_strict_deadline_boundary() {
    for offset in [-1i64, 0, 1] {
        let t = fixture_with_window();
        t.join_all();
        set_ledger_at_offset(&t, offset);

        if offset <= 0 {
            assert!(t.circle.try_settle_round().is_err());
            let round = t.circle.get_current_round();
            assert_eq!(round.round_index, 0);
            assert!(!round.paid_out);
            assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
            assert_eq!(t.circle.get_defaults(&t.alice), 0);
        } else {
            t.circle.settle_round();
            let round = t.circle.get_current_round();
            assert_eq!(round.round_index, 1);
            assert!(!round.paid_out);
            assert_eq!(t.circle.get_defaults(&t.alice), 1);
            assert_eq!(t.circle.get_status(), CircleStatus::Active);
        }
    }
}

#[test]
fn payout_is_not_deadline_gated_and_refreshes_the_next_round_deadline() {
    let t = fixture_with_window();
    t.join_all();
    t.contribute_all();
    set_ledger_at_offset(&t, 1);

    t.circle.payout();

    let round = t.circle.get_current_round();
    assert_eq!(round.round_index, 1);
    assert_eq!(t.circle.get_status(), CircleStatus::Active);
    assert_eq!(
        round.deadline_ledger,
        t.env.ledger().sequence() as u64 + WINDOW as u64
    );
}
