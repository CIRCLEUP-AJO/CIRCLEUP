//! Terminal collateral release (#875).
//!
//! `close` is **global**, not per-member: one successful call by any
//! authorized closer (the stored admin or any configured member) releases
//! every member's remaining collateral in member-list order, sets the
//! permanent `Closed` flag, and makes every later `close` fail with
//! `CloseError::AlreadyClosed`. There is no per-member claim and no
//! per-member "claimed" key — `Collateral(member)` is zeroed as it is paid.
//!
//! Every scenario asserts token balances, stored collateral, status, the
//! closed flag and emitted events after each call, and that rejected calls
//! change nothing.

mod common;

use circle::{CircleStatus, CloseError, ContractError};
use common::{code, gen_members, new_env, setup, Circle};
use soroban_sdk::{testutils::Address as _, Address, Symbol};

const A: i128 = 10_000_000; // 1 USDC; collateral == A (COLLATERAL_MULTIPLIER = 1)

fn penalty(c: i128) -> i128 {
    c * 2_000 / 10_000
}

/// Decoded `collateral_released` events: `(member, amount)`.
fn released(c: &Circle, before: u32) -> std::vec::Vec<(Address, i128)> {
    c.circle_events_since(before)
        .into_iter()
        .filter(|(name, _)| *name == c.sym("collateral_released"))
        .map(|(_, data)| {
            let (_circle, member, amount): (Address, Address, i128) = c.data(&data);
            (member, amount)
        })
        .collect()
}

/// Decoded `closed` event: `(closer, total_released, total_expected, reason)`.
fn closed_event(c: &Circle, before: u32) -> Option<(Address, i128, i128, Symbol)> {
    c.circle_events_since(before)
        .into_iter()
        .find(|(name, _)| *name == c.sym("closed"))
        .map(|(_, data)| {
            let (_circle, closer, total, expected, reason): (Address, Address, i128, i128, Symbol) =
                c.data(&data);
            (closer, total, expected, reason)
        })
}

/// Assert a close attempt is rejected with `expected` and mutates nothing.
fn assert_rejected_without_mutation(c: &Circle, closer: &Address, expected: u32) {
    let before = c.snapshot();
    let events_before = c.event_count();
    assert_eq!(code(c.client.try_close(closer)), Err(expected));
    assert_eq!(c.snapshot(), before, "rejected close must not mutate state");
    assert!(
        c.circle_events_since(events_before).is_empty(),
        "rejected close must not emit circle events"
    );
}

/// 3 members; carol misses round 0 and is penalised, the circle still
/// completes via `settle_round` and two clean rounds.
fn completed_with_one_penalised_member() -> Circle {
    let env = new_env();
    let members = gen_members(&env, 3);
    let c = setup(env, members, A);
    c.join_all();
    // Round 0: alice, bob contribute; carol misses.
    c.contribute(0);
    c.contribute(1);
    c.advance_past_deadline();
    c.client.mark_default(&c.member(2));
    c.client.settle_round();
    // Rounds 1 and 2: everyone contributes.
    for _ in 1..3 {
        c.contribute_all();
        c.client.payout();
    }
    assert_eq!(c.client.get_status(), CircleStatus::Completed);
    c
}

#[test]
fn completed_circle_releases_full_and_penalised_collateral_exactly_once() {
    let c = completed_with_one_penalised_member();
    let p = penalty(A);
    let (alice, bob, carol) = (c.member(0), c.member(1), c.member(2));

    // Pre-close: stored collateral and contract custody.
    assert_eq!(c.client.get_collateral(&alice), A);
    assert_eq!(c.client.get_collateral(&bob), A);
    assert_eq!(c.client.get_collateral(&carol), A - p);
    // Custody = remaining collateral + forfeited penalty.
    assert_eq!(c.circle_balance(), 3 * A);
    let bal_before: std::vec::Vec<i128> = [&alice, &bob, &carol].iter().map(|m| c.balance(m)).collect();

    // A stranger cannot close; nothing changes.
    assert_rejected_without_mutation(&c, &Address::generate(&c.env), CloseError::Unauthorized as u32);

    // Bob (a member, not the first) closes for everyone.
    let ev = c.event_count();
    c.client.close(&bob);

    assert_eq!(
        released(&c, ev),
        std::vec![(alice.clone(), A), (bob.clone(), A), (carol.clone(), A - p)],
        "one release per non-zero member, in member-list order"
    );
    let (closer, total, expected, reason) = closed_event(&c, ev).expect("closed event");
    assert_eq!(closer, bob);
    assert_eq!(total, 3 * A - p);
    assert_eq!(expected, 3 * A);
    assert_eq!(expected - total, p, "expected − released == forfeited penalties (completed circle)");
    assert_eq!(reason, c.sym("completed"));

    assert_eq!(c.balance(&alice), bal_before[0] + A);
    assert_eq!(c.balance(&bob), bal_before[1] + A);
    assert_eq!(c.balance(&carol), bal_before[2] + A - p);
    // Forfeited penalty stays in the contract; it is not redistributed.
    assert_eq!(c.circle_balance(), p);
    for m in [&alice, &bob, &carol] {
        assert_eq!(c.client.get_collateral(m), 0);
    }
    assert!(c.client.is_closed());
    // Close is an overlay: lifecycle status is unchanged.
    assert_eq!(c.client.get_status(), CircleStatus::Completed);

    // Every later close fails, whoever calls it, and pays nothing.
    for again in [alice.clone(), bob.clone(), c.admin.clone(), Address::generate(&c.env)] {
        assert_rejected_without_mutation(&c, &again, CloseError::AlreadyClosed as u32);
    }
}

#[test]
fn cancelled_circle_releases_joined_members_and_skips_never_joined() {
    let env = new_env();
    let members = gen_members(&env, 4);
    let c = setup(env, members, A);
    let (alice, bob, carol, dave) = (c.member(0), c.member(1), c.member(2), c.member(3));
    c.join(0);
    c.join(2);
    // A member who never joined may still cancel a Pending circle.
    c.client.cancel(&dave);
    assert_eq!(c.client.get_status(), CircleStatus::Cancelled);
    assert_eq!(c.circle_balance(), 2 * A);

    let bal_before: std::vec::Vec<i128> = [&alice, &bob, &carol, &dave].iter().map(|m| c.balance(m)).collect();
    let ev = c.event_count();
    // A never-joined member is still an authorized closer.
    c.client.close(&bob);

    assert_eq!(
        released(&c, ev),
        std::vec![(alice.clone(), A), (carol.clone(), A)],
        "zero-collateral (never joined) members get no release event"
    );
    let (closer, total, expected, reason) = closed_event(&c, ev).unwrap();
    assert_eq!(closer, bob);
    assert_eq!(total, 2 * A);
    // `total_expected_collateral` counts every configured member, including
    // the two who never deposited — for a cancelled circle the difference is
    // NOT a forfeiture (see docs/TERMINAL_CLOSE_SEMANTICS.md).
    assert_eq!(expected, 4 * A);
    assert_eq!(reason, c.sym("cancelled"));

    assert_eq!(c.balance(&alice), bal_before[0] + A);
    assert_eq!(c.balance(&bob), bal_before[1]);
    assert_eq!(c.balance(&carol), bal_before[2] + A);
    assert_eq!(c.balance(&dave), bal_before[3]);
    assert_eq!(c.circle_balance(), 0);
    assert!(c.client.is_closed());
    assert_eq!(c.client.get_status(), CircleStatus::Cancelled);

    assert_rejected_without_mutation(&c, &alice, CloseError::AlreadyClosed as u32);
}

#[test]
fn close_call_order_stranger_member_duplicate_admin() {
    let env = new_env();
    let members = gen_members(&env, 3);
    let c = setup(env, members, A);
    c.join_all();
    // Teleport to Completed: rounds are irrelevant to release arithmetic.
    c.force_completed();
    let stranger = Address::generate(&c.env);

    assert_rejected_without_mutation(&c, &stranger, CloseError::Unauthorized as u32);
    let ev = c.event_count();
    c.client.close(&c.member(2));
    assert_eq!(released(&c, ev).len(), 3);
    assert_rejected_without_mutation(&c, &c.member(0), CloseError::AlreadyClosed as u32);
    assert_rejected_without_mutation(&c, &c.admin, CloseError::AlreadyClosed as u32);
    // After close, AlreadyClosed is reported before authorization.
    assert_rejected_without_mutation(&c, &stranger, CloseError::AlreadyClosed as u32);
}

#[test]
fn admin_may_close_and_non_terminal_close_is_rejected() {
    let env = new_env();
    let members = gen_members(&env, 2);
    let c = setup(env, members, A);

    // Pending and Active are not terminal.
    assert_rejected_without_mutation(&c, &c.member(0), CloseError::NotTerminalState as u32);
    c.join_all();
    assert_eq!(c.client.get_status(), CircleStatus::Active);
    assert_rejected_without_mutation(&c, &c.member(0), CloseError::NotTerminalState as u32);

    c.force_completed();
    let ev = c.event_count();
    c.client.close(&c.admin);
    let (closer, total, _, _) = closed_event(&c, ev).unwrap();
    assert_eq!(closer, c.admin);
    assert_eq!(total, 2 * A);
}

#[test]
fn zero_collateral_member_in_completed_circle_is_skipped_and_others_unaffected() {
    let env = new_env();
    let members = gen_members(&env, 3);
    let c = setup(env, members, A);
    c.join_all();
    c.force_completed();
    // Unreachable through the public API (penalties floor and never reach
    // zero); injected to pin `close`'s skip rule for zero balances.
    c.set_collateral(&c.member(1), 0);

    let bal_bob = c.balance(&c.member(1));
    let ev = c.event_count();
    c.client.close(&c.member(1));
    assert_eq!(
        released(&c, ev),
        std::vec![(c.member(0), A), (c.member(2), A)]
    );
    assert_eq!(c.balance(&c.member(1)), bal_bob);
    assert_eq!(closed_event(&c, ev).unwrap().1, 2 * A);
    // The un-released A stays in custody.
    assert_eq!(c.circle_balance(), A);
}

#[test]
fn reduced_collateral_in_cancelled_circle_releases_exactly_the_stored_amount() {
    // Penalties cannot occur while Pending, so a reduced balance in a
    // Cancelled circle is unreachable; injected to prove close pays the
    // stored amount, never the configured deposit.
    let env = new_env();
    let members = gen_members(&env, 2);
    let c = setup(env, members, A);
    c.join(0); // only one of two joins: circle stays Pending
    c.client.cancel(&c.member(0));
    c.set_collateral(&c.member(0), A - 3);

    let ev = c.event_count();
    c.client.close(&c.member(0));
    assert_eq!(released(&c, ev), std::vec![(c.member(0), A - 3)]);
    assert_eq!(c.circle_balance(), 3);
}

#[test]
fn paused_terminal_circle_cannot_close_until_resumed() {
    let env = new_env();
    let members = gen_members(&env, 2);
    let c = setup(env, members, A);
    c.join_all();
    c.force_completed();
    c.client.pause(&c.admin);

    assert_rejected_without_mutation(&c, &c.member(0), ContractError::CirclePaused as u32);
    c.client.resume(&c.admin);
    c.client.close(&c.member(0));
    assert!(c.client.is_closed());
    assert_eq!(c.circle_balance(), 0);
}
