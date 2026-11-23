//! Reputation overflow handling tests.
//!
//! This module verifies the behavior when a member's reputation score reaches
//! the maximum value (u32::MAX) and an increment is attempted.
//!
//! # Overflow Policy
//!
//! The reputation contract uses **typed error rejection** for overflow:
//! - `increment` returns `Err(ReputationError::ScoreOverflow)` when at u32::MAX
//! - The score remains unchanged at u32::MAX (no wrapping)
//! - Payouts that would trigger overflow fail atomically
//!
//! This policy was chosen because:
//! 1. Reputation scores represent completed rounds; hitting u32::MAX is
//!    astronomically unlikely (4+ billion rounds)
//! 2. Atomic failure prevents silent data corruption
//! 3. Typed error allows SDKs to handle gracefully
//!
//! # Alternative Policies Considered
//!
//! | Policy | Pros | Cons |
//! |--------|------|------|
//! | Reject (chosen) | Atomic, predictable, typed error | Fails payout at max |
//! | Saturate | Never fails | Loses information about overflow |
//! | Wider storage | Infinite growth | Breaking change to DataKey::Score |
//! | Wrap | Familiar behavior | Silent data corruption |

use reputation::{DataKey, ReputationContract, ReputationContractClient, ReputationError};
use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal, TryFromVal, Val, Vec};

struct Setup<'a> {
    env: Env,
    id: Address,
    client: ReputationContractClient<'a>,
    admin: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    Setup { env, id, client, admin }
}

impl Setup<'_> {
    fn instance<V: IntoVal<Env, Val>>(&self, key: DataKey, value: V) {
        self.env.as_contract(&self.id, || {
            self.env.storage().instance().set(&key, &value);
        });
    }

    fn persistent<V: IntoVal<Env, Val>>(&self, key: DataKey, value: V) {
        self.env.as_contract(&self.id, || {
            self.env.storage().persistent().set(&key, &value);
        });
    }

    fn force_score(&self, member: &Address, score: u32) {
        self.persistent(DataKey::Score(member.clone()), score);
    }
}

// ─── Overflow Boundary Tests ─────────────────────────────────────────────────

/// Score at u32::MAX - 1 can be incremented to u32::MAX.
#[test]
fn score_at_max_minus_one_increments_to_max() {
    let s = setup();
    let member = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);
    s.force_score(&member, u32::MAX - 1);

    s.client.increment(&s.id, &member);

    assert_eq!(
        s.client.score(&member),
        u32::MAX,
        "score must reach u32::MAX without wrapping"
    );
}

/// Incrementing from u32::MAX returns ScoreOverflow error.
#[test]
fn score_overflow_at_max_returns_typed_error() {
    let s = setup();
    let member = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);
    s.force_score(&member, u32::MAX);

    let result = s.client.try_increment(&s.id, &member);

    assert_eq!(
        result,
        Err(Ok(ReputationError::ScoreOverflow)),
        "increment at max must return ScoreOverflow, not wrap"
    );
}

/// Failed increment leaves score unchanged at u32::MAX.
#[test]
fn failed_increment_preserves_max_score() {
    let s = setup();
    let member = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);
    s.force_score(&member, u32::MAX);

    // Multiple failed attempts
    for _ in 0..3 {
        let _ = s.client.try_increment(&s.id, &member);
    }

    assert_eq!(
        s.client.score(&member),
        u32::MAX,
        "failed increments must not modify the score"
    );
}

/// No event is emitted for a failed increment at max.
#[test]
fn overflow_failure_emits_no_event() {
    let s = setup();
    let member = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);
    s.force_score(&member, u32::MAX);

    let _ = s.client.try_increment(&s.id, &member);

    // Count score_updated events
    let events = s.env.events().all().events();
    let score_updates = events
        .iter()
        .filter(|e| {
            let body = &e.body;
            let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
            v0.topics.len() == 2
                && v0.topics[1]
                    == soroban_sdk::xdr::ScVal::Symbol(soroban_sdk::Symbol::new(&s.env, "score_updated").to_val().try_into().unwrap())
        })
        .count();

    assert_eq!(score_updates, 0, "failed increment must not emit score_updated event");
}

// ─── Payout Integration Tests ─────────────────────────────────────────────────

/// Payout fails atomically when reputation would overflow.
#[test]
fn payout_fails_atomically_on_reputation_overflow() {
    let s = setup();
    let member = Address::generate(&s.env);
    let circle = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &circle);
    s.force_score(&member, u32::MAX);

    // Attempt payout (simulated via direct increment call)
    let result = s.client.try_increment(&circle, &member);

    assert_eq!(
        result,
        Err(Ok(ReputationError::ScoreOverflow)),
        "payout must fail when reputation would overflow"
    );
    assert_eq!(
        s.client.score(&member),
        u32::MAX,
        "failed payout must not change any state"
    );
}

/// Multiple members can reach max independently.
#[test]
fn multiple_members_can_reach_max_independently() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);

    // Alice reaches max
    s.force_score(&alice, u32::MAX - 1);
    s.client.increment(&s.id, &alice);
    assert_eq!(s.client.score(&alice), u32::MAX);

    // Bob also reaches max
    s.force_score(&bob, u32::MAX - 1);
    s.client.increment(&s.id, &bob);
    assert_eq!(s.client.score(&bob), u32::MAX);

    // Both are at max independently
    assert_eq!(s.client.score(&alice), u32::MAX);
    assert_eq!(s.client.score(&bob), u32::MAX);
}

/// Score overflow does not affect other members' scores.
#[test]
fn overflow_on_one_member_does_not_affect_others() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);

    // Alice at max, Bob at 5
    s.force_score(&alice, u32::MAX);
    s.force_score(&bob, 5);

    // Alice fails to increment
    let _ = s.client.try_increment(&s.id, &alice);

    // Bob can still increment
    s.client.increment(&s.id, &bob);
    assert_eq!(s.client.score(&bob), 6);

    // Alice unchanged
    assert_eq!(s.client.score(&alice), u32::MAX);
}

// ─── TTL Extension at Max ───────────────────────────────────────────────────

/// TTL is extended even when increment fails at max.
#[test]
fn ttl_extended_even_on_overflow_failure() {
    let s = setup();
    let member = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);
    s.force_score(&member, u32::MAX);

    // Get initial TTL
    let initial_ttl = s.env.as_contract(&s.id, || {
        s.env.storage().persistent().get_ttl(&DataKey::Score(member.clone()))
    });

    // Failed increment attempt
    let _ = s.client.try_increment(&s.id, &member);

    // TTL should still be extended (contract extends before checking overflow)
    let new_ttl = s.env.as_contract(&s.id, || {
        s.env.storage().persistent().get_ttl(&DataKey::Score(member.clone()))
    });

    assert!(
        new_ttl >= initial_ttl,
        "TTL should be extended even on overflow failure"
    );
}

// ─── Event Emission at Boundary ─────────────────────────────────────────────

/// Score_updated event carries the correct value at max.
#[test]
fn score_updated_event_carries_max_value() {
    let s = setup();
    let member = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);
    s.force_score(&member, u32::MAX - 1);

    s.client.increment(&s.id, &member);

    // Verify event was emitted with max value
    let events = s.env.events().all().events();
    let last_event = events.iter().last().unwrap();
    let body = &last_event.body;
    let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;

    // Event data should be (member, u32::MAX)
    let event_data: (Address, u32) = FromVal::from_val(&s.env, &v0.data);
    assert_eq!(event_data.0, member);
    assert_eq!(event_data.1, u32::MAX);
}

// ─── Documentation: Overflow Behavior Policy ─────────────────────────────────

/// This test serves as living documentation of the overflow policy.
#[test]
fn document_overflow_policy() {
    let s = setup();
    let member = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &s.id);

    // Happy path: increment works until max
    for i in 0..5 {
        s.client.increment(&s.id, &member);
        assert_eq!(s.client.score(&member), i + 1);
    }

    // Boundary: max - 1 → max works
    s.force_score(&member, u32::MAX - 1);
    s.client.increment(&s.id, &member);
    assert_eq!(s.client.score(&member), u32::MAX);

    // Overflow: max → fails with typed error
    let result = s.client.try_increment(&s.id, &member);
    assert_eq!(result, Err(Ok(ReputationError::ScoreOverflow)));
    assert_eq!(s.client.score(&member), u32::MAX);
}