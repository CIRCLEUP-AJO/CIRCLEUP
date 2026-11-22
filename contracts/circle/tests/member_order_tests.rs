//! Member-order semantics from initialization through payout (#873).
//!
//! The `members` vector is stored exactly as supplied (no sorting, no
//! de-duplication beyond rejecting duplicates, no creator insertion).
//! `members[i]` receives the pot of round `i`; round 0's recipient is
//! `members[0]`. Join order has no effect on the rotation.
//!
//! Every fixture is deliberately **not** sorted by address so a regression
//! that sorts members anywhere on the path would change the recipients.

mod common;

use circle::{CircleStatus, DataKey, MAX_MEMBERS};
use common::{from_std, gen_members, new_env, setup, to_std, Circle};
use soroban_sdk::{Address, Env, Vec};

const A: i128 = 10_000_000;

/// Addresses sorted ascending, then permuted by `i → (i·7 + 3) mod n`
/// (a bijection whenever gcd(7, n) == 1), so the result is a known
/// non-sorted order. Use n with `7 mod n ∉ {0, 1}` or n == 2 (n = 3 and
/// n = 6 give the identity or a rotation that may be sorted).
fn non_sorted(env: &Env, n: u32) -> Vec<Address> {
    let mut sorted = to_std(&gen_members(env, n));
    sorted.sort();
    let n_usize = n as usize;
    let permuted: std::vec::Vec<Address> = (0..n_usize)
        .map(|i| sorted[(i * 7 + 3) % n_usize].clone())
        .collect();
    let mut check = permuted.clone();
    check.sort();
    assert_eq!(check, sorted, "permutation must use every address once");
    assert_ne!(permuted, sorted, "fixture must not be sorted");
    from_std(env, &permuted)
}

/// Recipients named by `payout` events since `before`, in emission order.
fn payout_recipients(c: &Circle, before: u32) -> std::vec::Vec<Address> {
    c.circle_events_since(before)
        .into_iter()
        .filter(|(name, _)| *name == c.sym("payout"))
        .map(|(_, data)| {
            let (_circle, recipient, _amount, _round): (Address, Address, i128, u32) = c.data(&data);
            recipient
        })
        .collect()
}

fn assert_each_member_scheduled_exactly_once(members: &Vec<Address>, recipients: &[Address]) {
    let mut a = to_std(members);
    let mut b = recipients.to_vec();
    a.sort();
    b.sort();
    assert_eq!(a, b, "every member receives exactly once per full cycle");
}

#[test]
fn config_and_initialized_event_preserve_input_order() {
    let env = new_env();
    let members = non_sorted(&env, 5);
    let c = setup(env, members.clone(), A);

    assert_eq!(to_std(&c.client.get_config().members), to_std(&members));
    // `initialized` was the circle's first event.
    let init = c
        .circle_events_since(0)
        .into_iter()
        .find(|(name, _)| *name == c.sym("initialized"))
        .expect("initialized event");
    let (_circle, count, amount, evt_members): (Address, u32, i128, Vec<Address>) = c.data(&init.1);
    assert_eq!(count, 5);
    assert_eq!(amount, A);
    assert_eq!(to_std(&evt_members), to_std(&members));
    // Round 0 is prepared for members[0] already while Pending.
    assert_eq!(c.client.get_current_round().recipient, members.get(0).unwrap());
}

#[test]
fn two_member_non_sorted_full_cycle_pays_in_list_order() {
    let env = new_env();
    let mut pair = to_std(&gen_members(&env, 2));
    pair.sort();
    pair.reverse(); // descending: guaranteed non-sorted
    let members = from_std(&env, &pair);
    let c = setup(env, members.clone(), A);
    let (first, second) = (c.member(0), c.member(1));
    assert!(first > second);

    // Join in the opposite order to the rotation.
    c.join(1);
    c.join(0);
    assert_eq!(c.client.get_status(), CircleStatus::Active);

    let ev = c.event_count();
    for round in 0..2u32 {
        let expected = members.get(round).unwrap();
        assert_eq!(c.client.get_current_round().round_index, round);
        assert_eq!(c.client.get_current_round().recipient, expected);
        let before = c.balance(&expected);
        c.contribute_all();
        c.client.payout();
        // Recipient paid 2A, having contributed A this round.
        assert_eq!(c.balance(&expected), before - A + 2 * A);
    }
    let recipients = payout_recipients(&c, ev);
    assert_eq!(recipients, std::vec![first, second]);
    assert_each_member_scheduled_exactly_once(&members, &recipients);
    assert_eq!(c.client.get_status(), CircleStatus::Completed);
}

#[test]
fn join_order_never_changes_rotation() {
    let env = new_env();
    let members = non_sorted(&env, 5);
    let c = setup(env, members.clone(), A);
    // Join last-to-first.
    for i in (0..5).rev() {
        c.join(i);
    }
    let ev = c.event_count();
    for _ in 0..5 {
        c.contribute_all();
        c.client.payout();
    }
    assert_eq!(payout_recipients(&c, ev), to_std(&members));
}

/// Full 256-round cycle at `MAX_MEMBERS`. Joins and payouts are real calls;
/// per-round contribution records are injected (256 × 256 real `contribute`
/// calls would dominate CI time) and `payout` still verifies the tally, the
/// canonical recipient and the pot against them.
#[test]
fn max_size_non_sorted_full_cycle_pays_every_member_once_in_list_order() {
    let env = new_env();
    let members = non_sorted(&env, MAX_MEMBERS);
    let c = setup(env, members.clone(), A);
    assert_eq!(to_std(&c.client.get_config().members), to_std(&members));
    c.join_all();
    assert_eq!(c.client.get_status(), CircleStatus::Active);

    let ev = c.event_count();
    for round in 0..MAX_MEMBERS {
        let current = c.client.get_current_round();
        assert_eq!(current.round_index, round);
        assert_eq!(current.recipient, members.get(round).unwrap(), "round {round}");
        c.inject_full_contributions();
        c.client.payout();
    }

    let recipients = payout_recipients(&c, ev);
    assert_eq!(recipients.len(), MAX_MEMBERS as usize);
    assert_eq!(recipients, to_std(&members), "recipient of round i is members[i]");
    assert_each_member_scheduled_exactly_once(&members, &recipients);
    assert_eq!(c.client.get_status(), CircleStatus::Completed);
    let rounds: u32 = c
        .env
        .as_contract(&c.id, || c.env.storage().instance().get(&DataKey::RoundsCompleted).unwrap());
    assert_eq!(rounds, MAX_MEMBERS);
}
