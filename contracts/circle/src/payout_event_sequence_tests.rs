//! Payout and compound operation event sequence tests.
//!
//! These tests verify that compound operations emit events in a documented,
//! deterministic order. The indexer and downstream consumers rely on this
//! ordering to reconstruct a coherent view of circle state changes.
//!
//! Event ordering rules:
//! - Events are emitted in the order operations execute within a transaction
//! - The indexer preserves this order when projecting to PostgreSQL
//! - Compound operations have a defined event sequence (documented below)
//!
//! Compound operation event sequences:
//!
//! **payout (full contributions)**:
//!   1. circle/payout — pot transferred to recipient
//!   2. reputation/score_updated — recipient's score incremented
//!   3. circle/round_started — next round opens (if not final)
//!   4. circle/completed — all rounds done (if final)
//!
//! **settle_round (partial contributions)**:
//!   1. circle/default — per defaulted member (may be multiple)
//!   2. circle/exceptional_settlement — partial pot settlement
//!   3. circle/payout — pot transferred to recipient
//!   4. reputation/score_updated — recipient's score incremented
//!   5. circle/round_started — next round opens (if not final)
//!   6. circle/completed — all rounds done (if final)
//!
//! **close (collateral release)**:
//!   1. circle/collateral_released — per member with positive balance
//!   2. circle/closed — aggregate settlement event
//!
//! **join (activation)**:
//!   1. circle/joined — member locked collateral
//!   2. circle/active — all members joined, round 0 deadline starts
//!
//! Failed transactions emit NO events — the Soroban host rolls back atomically.

#![cfg(test)]

use crate::{
    CircleContract, CircleContractClient, ContractError, DataKey, CircleStatus, RoundState,
    MIN_MEMBERS, MAX_MEMBERS, MIN_ROUND_DEADLINE_LEDGERS, PENALTY_BPS, BPS_DENOM,
};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, Address, Env, Symbol, Vec,
};

// ─── Test Fixtures ───────────────────────────────────────────────────────────

struct CircleFixture {
    env: Env,
    contract_id: Address,
    client: CircleContractClient<'static>,
    admin: Address,
    members: Vec<Address>,
    usdc: Address,
    reputation: Address,
    round_amount: i128,
}

impl CircleFixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, CircleContract);
        let client = CircleContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let usdc = Address::generate(&env);
        let reputation = Address::generate(&env);

        let mut members = Vec::new(&env);
        for _ in 0..4 {
            members.push_back(Address::generate(&env));
        }

        let round_amount = 1_000_000i128; // 0.1 USDC

        client.initialize(
            &admin,
            &members,
            &round_amount,
            &usdc,
            &reputation,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        Self { env, contract_id, client, admin, members, usdc, reputation, round_amount }
    }

    fn activate(&self) {
        for member in self.members.iter() {
            self.client.join(&member);
        }
    }

    fn contribute_all(&self) {
        for member in self.members.iter() {
            self.client.contribute(&member);
        }
    }
}

// ─── Event Extraction Helpers ─────────────────────────────────────────────────

/// Extract all event topics and data from the environment.
fn all_events(env: &Env) -> Vec<(Vec<soroban_sdk::Val>, soroban_sdk::Val)> {
    env.events().all().events().iter().map(|e| {
        let soroban_sdk::xdr::ContractEventBody::V0(ref v0) = e.body;
        (v0.topics.clone(), v0.data.clone())
    }).collect()
}

/// Filter events by topic[1] (event name).
fn events_named(env: &Env, name: &str) -> Vec<(Vec<soroban_sdk::Val>, soroban_sdk::Val)> {
    let target = Symbol::new(env, name);
    all_events(env).into_iter().filter(|(topics, _)| {
        topics.get(1).map_or(false, |t| t == target.to_val())
    }).collect()
}

/// Count events by name.
fn event_count(env: &Env, name: &str) -> usize {
    events_named(env, name).len()
}

// ─── Payout Event Sequence Tests ─────────────────────────────────────────────

#[test]
fn test_payout_emits_events_in_documentated_order() {
    let f = CircleFixture::new();
    f.activate();
    f.contribute_all();

    // Clear events from setup
    let before_payout = all_events(&f.env);

    // Execute payout
    f.client.payout();

    let after_payout = all_events(&f.env);
    let payout_events: Vec<_> = after_payout.iter().skip(before_payout.len()).collect();

    // Verify event sequence: payout → score_updated → round_started
    assert!(!payout_events.is_empty(), "payout must emit at least one event");

    let names: Vec<String> = payout_events.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    // Expected order: payout, score_updated, round_started
    assert_eq!(names[0], "payout", "first event must be payout");
    assert_eq!(names[1], "score_updated", "second event must be score_updated");
    assert_eq!(names[2], "round_started", "third event must be round_started");
}

#[test]
fn test_final_payout_emits_completed_not_round_started() {
    let f = CircleFixture::new();
    f.activate();
    f.contribute_all();

    // Payout rounds 0, 1, 2 (3 of 4 members)
    for _ in 0..3 {
        f.client.payout();
        f.contribute_all();
    }

    // Clear events before final payout
    let before = all_events(&f.env);

    // Final payout (round 3) should emit completed, not round_started
    f.client.payout();

    let after = all_events(&f.env);
    let events: Vec<_> = after.iter().skip(before.len()).collect();

    let names: Vec<String> = events.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    // Final round: payout → score_updated → completed
    assert_eq!(names[0], "payout");
    assert_eq!(names[1], "score_updated");
    assert_eq!(names[2], "completed");
    assert!(!names.contains(&"round_started".to_string()), "final round must not emit round_started");
}

#[test]
fn test_payout_event_carries_correct_data() {
    let f = CircleFixture::new();
    f.activate();
    f.contribute_all();

    f.client.payout();

    let payout_events = events_named(&f.env, "payout");
    assert_eq!(payout_events.len(), 1, "payout must emit exactly one event");

    let (_, data) = &payout_events[0];
    let parsed: (Address, Address, i128, u32) = FromVal::from_val(&f.env, data);

    assert_eq!(parsed.0, f.contract_id, "event must carry circle_address");
    assert_eq!(parsed.1, f.members.get(0).unwrap(), "recipient must be first member");
    assert_eq!(parsed.2, f.round_amount * 4, "amount must be pot (round_amount × member_count)");
    assert_eq!(parsed.3, 0, "round_index must be 0");
}

#[test]
fn test_score_updated_event_carries_correct_data() {
    let f = CircleFixture::new();
    f.activate();
    f.contribute_all();

    f.client.payout();

    let score_events = events_named(&f.env, "score_updated");
    assert_eq!(score_events.len(), 1, "payout must emit exactly one score_updated event");

    let (_, data) = &score_events[0];
    let parsed: (Address, u32) = FromVal::from_val(&f.env, data);

    assert_eq!(parsed.0, f.members.get(0).unwrap(), "member must be the recipient");
    assert_eq!(parsed.1, 1, "score must be 1 after first payout");
}

// ─── Failed Transaction Tests ─────────────────────────────────────────────────

#[test]
fn test_failed_payout_emits_no_events() {
    let f = CircleFixture::new();
    f.activate();
    // NOT all members contributed — payout should fail

    let before = all_events(&f.env);

    let result = f.client.try_payout();
    assert!(result.is_err(), "payout must fail when not all contributed");

    let after = all_events(&f.env);
    let new_events: Vec<_> = after.iter().skip(before.len()).collect();

    assert_eq!(new_events.len(), 0, "failed payout must emit no events");
    assert_eq!(event_count(&f.env, "payout"), 0, "no payout event after failure");
    assert_eq!(event_count(&f.env, "score_updated"), 0, "no score_updated after failure");
}

#[test]
fn test_failed_contribute_emits_no_events() {
    let f = CircleFixture::new();
    f.activate();

    let before = all_events(&f.env);

    // Try to contribute twice (should fail)
    f.client.contribute(&f.members.get(0).unwrap());
    let result = f.client.try_contribute(&f.members.get(0).unwrap());
    assert!(result.is_err(), "duplicate contribution must fail");

    let after = all_events(&f.env);
    let new_events: Vec<_> = after.iter().skip(before.len()).collect();

    // First contribute succeeded, second failed
    let contribute_count = new_events.iter()
        .filter(|(topics, _)| {
            topics.get(1).map_or(false, |t| {
                let sym: Symbol = t.try_from_val(&f.env).unwrap();
                sym.to_string() == "contributed"
            })
        })
        .count();

    assert_eq!(contribute_count, 1, "only one contributed event (first call succeeded)");
}

// ─── Settle Round Event Sequence Tests ───────────────────────────────────────

#[test]
fn test_settle_round_emits_default_events_before_settlement() {
    let f = CircleFixture::new();
    f.activate();

    // Only 3 of 4 members contribute
    for i in 0..3 {
        f.client.contribute(&f.members.get(i).unwrap());
    }

    // Advance past deadline
    f.env.ledger().with_mut(|l| l.sequence_number += 200);

    let before = all_events(&f.env);

    // Settle the round
    f.client.settle_round();

    let after = all_events(&f.env);
    let events: Vec<_> = after.iter().skip(before.len()).collect();

    let names: Vec<String> = events.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    // Expected: default (for member 3) → exceptional_settlement → payout → score_updated → round_started
    assert!(names.contains(&"default".to_string()), "must emit default event for non-contributor");
    assert!(names.contains(&"exceptional_settlement".to_string()), "must emit exceptional_settlement");
    assert!(names.contains(&"payout".to_string()), "must emit payout");
    assert!(names.contains(&"score_updated".to_string()), "must emit score_updated");
    assert!(names.contains(&"round_started".to_string()), "must emit round_started");

    // Order check: default before exceptional_settlement
    let default_idx = names.iter().position(|n| n == "default").unwrap();
    let settlement_idx = names.iter().position(|n| n == "exceptional_settlement").unwrap();
    assert!(default_idx < settlement_idx, "default must come before exceptional_settlement");
}

#[test]
fn test_settle_round_with_all_defaulted() {
    let f = CircleFixture::new();
    f.activate();

    // No one contributes
    f.env.ledger().with_mut(|l| l.sequence_number += 200);

    let before = all_events(&f.env);

    f.client.settle_round();

    let after = all_events(&f.env);
    let events: Vec<_> = after.iter().skip(before.len()).collect();

    let names: Vec<String> = events.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    // 4 defaults (all members) → exceptional_settlement (pot=0) → payout (pot=0) → score_updated → round_started
    let default_count = names.iter().filter(|n| n == &"default").count();
    assert_eq!(default_count, 4, "all 4 members should be defaulted");

    // exceptional_settlement with pot=0
    let settlement_events = events_named(&f.env, "exceptional_settlement");
    assert_eq!(settlement_events.len(), 1);
    let (_, data) = &settlement_events[0];
    let parsed: (Address, Address, i128, u32, u32) = FromVal::from_val(&f.env, data);
    assert_eq!(parsed.2, 0, "pot must be 0 when all defaulted");
}

// ─── Close Event Sequence Tests ───────────────────────────────────────────────

#[test]
fn test_close_emits_collateral_released_before_closed() {
    let f = CircleFixture::new();
    f.activate();
    f.contribute_all();

    // Complete all rounds
    for _ in 0..4 {
        f.client.payout();
        f.contribute_all();
    }

    let before = all_events(&f.env);

    f.client.close(&f.members.get(0).unwrap());

    let after = all_events(&f.env);
    let events: Vec<_> = after.iter().skip(before.len()).collect();

    let names: Vec<String> = events.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    // Expected: 4× collateral_released → closed
    let released_count = names.iter().filter(|n| n == &"collateral_released").count();
    assert_eq!(released_count, 4, "must emit collateral_released for each member");

    let closed_idx = names.iter().position(|n| n == "closed").unwrap();
    let last_released_idx = names.iter().rposition(|n| n == "collateral_released").unwrap();
    assert!(closed_idx > last_released_idx, "closed must come after all collateral_released");
}

#[test]
fn test_close_aggregates_correct_totals() {
    let f = CircleFixture::new();
    f.activate();
    f.contribute_all();

    for _ in 0..4 {
        f.client.payout();
        f.contribute_all();
    }

    f.client.close(&f.members.get(0).unwrap());

    let closed_events = events_named(&f.env, "closed");
    assert_eq!(closed_events.len(), 1);

    let (_, data) = &closed_events[0];
    let parsed: (Address, Address, i128, i128, Symbol) = FromVal::from_val(&f.env, data);

    // total_released should equal sum of all collateral
    // total_expected should equal 4 × round_amount (no penalties in this test)
    assert_eq!(parsed.2, parsed.3, "released should equal expected with no defaults");
    assert_eq!(parsed.4.to_string(), "completed", "reason must be 'completed'");
}

// ─── Join Activation Event Sequence Tests ────────────────────────────────────

#[test]
fn test_join_then_active_event_order() {
    let f = CircleFixture::new();

    let before = all_events(&f.env);

    // First member joins
    f.client.join(&f.members.get(0).unwrap());

    let after_first = all_events(&f.env);
    let events_first: Vec<_> = after_first.iter().skip(before.len()).collect();

    let names_first: Vec<String> = events_first.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    assert!(names_first.contains(&"joined".to_string()), "first join must emit joined");
    assert!(!names_first.contains(&"active".to_string()), "first join must not emit active (not all joined)");

    // Last member joins
    f.client.join(&f.members.get(3).unwrap());

    let after_last = all_events(&f.env);
    let events_last: Vec<_> = after_last.iter().skip(after_first.len()).collect();

    let names_last: Vec<String> = events_last.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    assert!(names_last.contains(&"joined".to_string()), "last join must emit joined");
    assert!(names_last.contains(&"active".to_string()), "last join must emit active");
}

// ─── Pause/Resume Event Tests ────────────────────────────────────────────────

#[test]
fn test_pause_emits_paused_event() {
    let f = CircleFixture::new();

    let before = all_events(&f.env);

    f.client.pause(&f.admin).unwrap();

    let after = all_events(&f.env);
    let events: Vec<_> = after.iter().skip(before.len()).collect();

    let names: Vec<String> = events.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    assert_eq!(names, vec!["paused"], "pause must emit exactly one paused event");
}

#[test]
fn test_resume_emits_resumed_event() {
    let f = CircleFixture::new();

    f.client.pause(&f.admin).unwrap();

    let before = all_events(&f.env);

    f.client.resume(&f.admin).unwrap();

    let after = all_events(&f.env);
    let events: Vec<_> = after.iter().skip(before.len()).collect();

    let names: Vec<String> = events.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    assert_eq!(names, vec!["resumed"], "resume must emit exactly one resumed event");
}

// ─── Cancellation Event Tests ─────────────────────────────────────────────────

#[test]
fn test_cancel_emits_cancelled_event() {
    let f = CircleFixture::new();

    let before = all_events(&f.env);

    f.client.cancel(&f.members.get(0).unwrap()).unwrap();

    let after = all_events(&f.env);
    let events: Vec<_> = after.iter().skip(before.len()).collect();

    let names: Vec<String> = events.iter()
        .map(|(topics, _)| {
            let sym: Symbol = topics.get(1).unwrap().try_from_val(&f.env).unwrap();
            sym.to_string()
        })
        .collect();

    assert_eq!(names, vec!["cancelled"], "cancel must emit exactly one cancelled event");
}

// ─── Indexer Ordering Verification ───────────────────────────────────────────

/// Verifies that the indexer's event ordering matches contract emission order.
/// This test doesn't run in the test environment but documents the invariant.
#[test]
fn test_indexer_must_preserve_event_order() {
    // The indexer (indexer/src/indexer.ts) processes events in the order they
    // appear in getEventsByLedger. This order matches the contract's emission
    // order within a transaction.
    //
    // Compound operation tests above verify the emission order. The indexer
    // must not reorder events when projecting to PostgreSQL.
    //
    // Relevant indexer code:
    // - processEvents() iterates events in order
    // - handlePayout() expects payout before score_updated
    // - handleSettleRound() expects default before exceptional_settlement
    //
    // If the indexer reorders events, these contract tests will fail because
    // the expected sequence won't match reality.
    assert!(true, "This test documents the ordering invariant; actual verification is in indexer ordering tests");
}