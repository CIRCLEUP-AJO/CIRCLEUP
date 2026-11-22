//! Full-lifecycle behavior at the supported member-count bounds (issue #889).
//!
//! `MIN_MEMBERS` and `MAX_MEMBERS` are read from the contract rather than
//! duplicated as literals, so these tests fail if the enforced bounds ever
//! diverge from the documented ones. The maximum-size case drives the first
//! rotation slot through a real round and then jumps to the last slot with a
//! test-only storage injection, keeping runtime and event volume bounded.

#![cfg(test)]
extern crate std;

use crate::test_support::{Fixture, FixtureBuilder, ROUND_DEADLINE};
use crate::{CircleStatus, DataKey, RoundState, MAX_MEMBERS, MIN_MEMBERS};
use soroban_sdk::testutils::Ledger;

fn rounds_completed(t: &Fixture<'_>) -> u32 {
    t.env.as_contract(&t.circle_id, || {
        t.env
            .storage()
            .instance()
            .get(&DataKey::RoundsCompleted)
            .unwrap()
    })
}

fn place_at_final_round(t: &Fixture<'_>, round_index: u32) {
    let deadline_ledger = t.env.ledger().sequence() as u64 + ROUND_DEADLINE as u64;
    let round = RoundState {
        round_index,
        recipient: t.member(round_index),
        contributions_received: 0,
        deadline_ledger,
        paid_out: false,
    };
    t.env.as_contract(&t.circle_id, || {
        t.env
            .storage()
            .instance()
            .set(&DataKey::CurrentRound, &round);
        t.env
            .storage()
            .instance()
            .set(&DataKey::RoundsCompleted, &round_index);
    });
}

#[test]
fn bounds_are_the_documented_values() {
    assert_eq!(MIN_MEMBERS, 2);
    assert_eq!(MAX_MEMBERS, 256);
}

#[test]
fn minimum_member_circle_completes_first_and_last_rotation_slots() {
    let t = FixtureBuilder::default().members(MIN_MEMBERS).build();
    assert_eq!(t.member_count(), MIN_MEMBERS);

    t.join_all();
    assert_eq!(t.circle.get_status(), CircleStatus::Active);
    let first = t.circle.get_current_round();
    assert_eq!(first.round_index, 0);
    assert_eq!(first.recipient, t.member(0));

    t.complete_round();
    let second = t.circle.get_current_round();
    assert_eq!(second.round_index, 1);
    assert_eq!(second.recipient, t.member(1));
    assert_eq!(rounds_completed(&t), 1);
    assert_eq!(t.circle.get_status(), CircleStatus::Active);

    t.complete_round();
    assert_eq!(rounds_completed(&t), MIN_MEMBERS);
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);
    assert!(!t.circle.is_closed());

    t.circle.close(&t.alice);
    assert!(t.circle.is_closed());
    for i in 0..MIN_MEMBERS {
        assert_eq!(t.circle.get_collateral(&t.member(i)), 0);
    }
}

#[test]
fn maximum_member_circle_completes_first_and_last_rotation_slots() {
    let t = FixtureBuilder::default().members(MAX_MEMBERS).build();
    assert_eq!(t.member_count(), MAX_MEMBERS);

    t.join_all();
    assert_eq!(t.circle.get_status(), CircleStatus::Active);
    let first = t.circle.get_current_round();
    assert_eq!(first.round_index, 0);
    assert_eq!(first.recipient, t.member(0));

    t.contribute_all();
    t.circle.payout();
    let second = t.circle.get_current_round();
    assert_eq!(second.round_index, 1);
    assert_eq!(second.recipient, t.member(1));
    assert_eq!(rounds_completed(&t), 1);
    assert_eq!(t.circle.get_status(), CircleStatus::Active);

    let final_index = MAX_MEMBERS - 1;
    place_at_final_round(&t, final_index);
    t.contribute_all();
    t.circle.payout();

    let final_round = t.circle.get_current_round();
    assert_eq!(final_round.round_index, final_index);
    assert_eq!(final_round.recipient, t.member(final_index));
    assert_eq!(rounds_completed(&t), MAX_MEMBERS);
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);

    t.circle.close(&t.alice);
    assert!(t.circle.is_closed());
    assert_eq!(t.circle.get_collateral(&t.member(0)), 0);
    assert_eq!(t.circle.get_collateral(&t.member(final_index)), 0);
}
