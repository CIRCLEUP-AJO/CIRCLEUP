//! Pause authority and overlay semantics (#876).
//!
//! * Authority: only the `Admin` address written once by `initialize`. There
//!   is no setter, no second role, and no upgrade entrypoint.
//! * Overlay: `Paused` never changes `Status`, `Closed`, rounds, collateral or
//!   defaults. Pause and resume are accepted in every status, including
//!   terminal and closed circles.
//! * While paused every mutation except `resume` (and the no-op re-pause,
//!   rejected) fails with `ContractError::CirclePaused` before any other
//!   check; every read stays available.
//! * The round deadline is an absolute ledger number, so ledgers that close
//!   during a pause count against it.

mod common;

use circle::{CircleStatus, ContractError, PauseError};
use common::{code, gen_members, new_env, setup, Circle};
use soroban_sdk::{testutils::Address as _, Address};

const A: i128 = 10_000_000;

fn active(n: u32) -> Circle {
    let env = new_env();
    let members = gen_members(&env, n);
    let c = setup(env, members, A);
    c.join_all();
    c
}

fn pause_events(c: &Circle, before: u32) -> std::vec::Vec<(&'static str, Address)> {
    c.circle_events_since(before)
        .into_iter()
        .filter_map(|(name, data)| {
            let label = if name == c.sym("paused") {
                "paused"
            } else if name == c.sym("resumed") {
                "resumed"
            } else {
                return None;
            };
            let (circle, admin, _ledger): (Address, Address, u32) = c.data(&data);
            assert_eq!(circle, c.id, "first field is the emitting circle");
            Some((label, admin))
        })
        .collect()
}

#[test]
fn only_the_stored_admin_can_pause_or_resume() {
    let c = active(3);
    let stranger = Address::generate(&c.env);
    for caller in [c.member(0), stranger.clone(), c.id.clone()] {
        let before = c.snapshot();
        let ev = c.event_count();
        assert_eq!(code(c.client.try_pause(&caller)), Err(PauseError::Unauthorized as u32));
        assert_eq!(c.snapshot(), before);
        assert!(c.circle_events_since(ev).is_empty());
    }

    c.client.pause(&c.admin);
    for caller in [c.member(1), stranger] {
        let before = c.snapshot();
        assert_eq!(code(c.client.try_resume(&caller)), Err(PauseError::Unauthorized as u32));
        assert_eq!(c.snapshot(), before);
        assert!(c.client.is_paused());
    }
    // Admin is unchanged by any pause/resume activity.
    assert_eq!(c.client.get_admin(), c.admin);
}

#[test]
fn repeated_pause_resume_transitions_are_strictly_alternating() {
    let c = active(2);
    let ev = c.event_count();
    for _ in 0..3 {
        c.client.pause(&c.admin);
        assert_eq!(code(c.client.try_pause(&c.admin)), Err(PauseError::AlreadyPaused as u32));
        assert!(c.client.is_paused());
        c.client.resume(&c.admin);
        assert_eq!(code(c.client.try_resume(&c.admin)), Err(PauseError::NotPaused as u32));
        assert!(!c.client.is_paused());
    }
    let labels: std::vec::Vec<&str> = pause_events(&c, ev).into_iter().map(|(l, _)| l).collect();
    assert_eq!(labels, ["paused", "resumed", "paused", "resumed", "paused", "resumed"]);
}

#[test]
fn resume_on_never_paused_circle_is_typed_and_harmless() {
    let c = active(2);
    let before = c.snapshot();
    assert_eq!(code(c.client.try_resume(&c.admin)), Err(PauseError::NotPaused as u32));
    assert_eq!(c.snapshot(), before);
}

#[test]
fn pause_preserves_lifecycle_status_in_every_state() {
    let env = new_env();
    let members = gen_members(&env, 2);
    let c = setup(env, members, A);

    // Pending
    let check = |expected: CircleStatus, closed: bool| {
        c.client.pause(&c.admin);
        assert_eq!(c.client.get_status(), expected);
        assert_eq!(c.client.is_closed(), closed);
        c.client.resume(&c.admin);
        assert_eq!(c.client.get_status(), expected);
        assert_eq!(c.client.is_closed(), closed);
    };
    check(CircleStatus::Pending, false);
    c.join_all();
    check(CircleStatus::Active, false);
    c.force_completed();
    check(CircleStatus::Completed, false);
    c.client.close(&c.member(0));
    // Closed overlay: pause is still accepted and changes nothing else.
    check(CircleStatus::Completed, true);
}

#[test]
fn pause_on_cancelled_circle_blocks_close_until_resume() {
    let env = new_env();
    let members = gen_members(&env, 2);
    let c = setup(env, members, A);
    c.join(0);
    c.client.cancel(&c.member(1));
    c.client.pause(&c.admin);
    assert_eq!(c.client.get_status(), CircleStatus::Cancelled);

    let before = c.snapshot();
    assert_eq!(code(c.client.try_close(&c.member(0))), Err(ContractError::CirclePaused as u32));
    assert_eq!(c.snapshot(), before);

    c.client.resume(&c.admin);
    c.client.close(&c.member(0));
    assert!(c.client.is_closed());
}

#[test]
fn every_mutation_is_blocked_while_paused_and_state_is_untouched() {
    // Pending: join and cancel.
    let env = new_env();
    let members = gen_members(&env, 2);
    let p = setup(env, members, A);
    p.client.pause(&p.admin);
    let before = p.snapshot();
    let paused = Err(ContractError::CirclePaused as u32);
    assert_eq!(code(p.client.try_join(&p.member(0))), paused);
    assert_eq!(code(p.client.try_cancel(&p.member(0))), paused);
    assert_eq!(p.snapshot(), before);

    // Active, after the deadline: contribute, payout, mark_default, settle_round, close.
    let c = active(2);
    c.contribute(0);
    c.advance_past_deadline();
    c.client.pause(&c.admin);
    let before = c.snapshot();
    let round_before = c.client.get_current_round();
    let ev = c.event_count();
    assert_eq!(code(c.client.try_contribute(&c.member(1))), paused);
    assert_eq!(code(c.client.try_payout()), paused);
    assert_eq!(code(c.client.try_mark_default(&c.member(1))), paused);
    assert_eq!(code(c.client.try_settle_round()), paused);
    assert_eq!(code(c.client.try_close(&c.member(0))), paused);
    assert_eq!(c.snapshot(), before);
    let round_after = c.client.get_current_round();
    assert_eq!(round_after.contributions_received, round_before.contributions_received);
    assert_eq!(round_after.deadline_ledger, round_before.deadline_ledger);
    assert!(!round_after.paid_out);
    assert!(c.circle_events_since(ev).is_empty());

    // After resume the same calls are evaluated normally.
    c.client.resume(&c.admin);
    c.client.mark_default(&c.member(1));
    assert_eq!(c.client.get_defaults(&c.member(1)), 1);
}

#[test]
fn reads_remain_available_while_paused() {
    let c = active(3);
    c.contribute(0);
    c.client.pause(&c.admin);

    assert_eq!(c.client.get_status(), CircleStatus::Active);
    assert!(c.client.is_paused());
    assert!(!c.client.is_closed());
    assert_eq!(c.client.get_config().members.len(), 3);
    assert_eq!(c.client.get_current_round().contributions_received, 1);
    assert_eq!(c.client.get_collateral(&c.member(0)), A);
    assert_eq!(c.client.get_defaults(&c.member(0)), 0);
    assert!(c.client.has_contributed(&c.member(0), &0));
    assert_eq!(c.client.get_admin(), c.admin);
    assert_eq!(c.client.get_pot_amount(), 3 * A);
    let _ = c.client.get_usdc_token();
    let _ = c.client.get_protocol_params();
}

#[test]
fn ledgers_closed_during_a_pause_count_against_the_deadline() {
    let c = active(2);
    c.contribute(0);
    let deadline = c.client.get_current_round().deadline_ledger;
    c.client.pause(&c.admin);
    // The network keeps closing ledgers while the circle is paused.
    c.set_ledger(u32::try_from(deadline + 1).unwrap());
    c.client.resume(&c.admin);

    assert_eq!(c.client.get_current_round().deadline_ledger, deadline, "pause does not extend the deadline");
    assert_eq!(
        code(c.client.try_contribute(&c.member(1))),
        Err(ContractError::DeadlinePassed as u32)
    );
    // ...and the missed contribution is now defaultable.
    c.client.mark_default(&c.member(1));
}

#[test]
fn pause_events_carry_circle_admin_and_ledger() {
    let c = active(2);
    c.set_ledger(7_777);
    let ev = c.event_count();
    c.client.pause(&c.admin);
    let raw = c.circle_events_since(ev);
    assert_eq!(raw.len(), 1);
    let (circle, admin, ledger): (Address, Address, u32) = c.data(&raw[0].1);
    assert_eq!((circle, admin, ledger), (c.id.clone(), c.admin.clone(), 7_777));
}
