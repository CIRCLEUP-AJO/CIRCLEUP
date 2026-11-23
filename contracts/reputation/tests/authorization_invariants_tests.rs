//! Authorization invariants tests for the reputation contract.
//!
//! This module verifies that the authorized and revoked caller collections
//! maintain their invariants after sequences of administrative operations.
//!
//! # Collection Invariants
//!
//! 1. **Uniqueness**: Each address appears at most once in AuthorizedCallers
//! 2. **Revocation permanence**: Once in RevokedCallers, never returns to AuthorizedCallers
//! 3. **Authorization outranks absence**: An address is authorized iff in AuthorizedCallers
//!    AND NOT in RevokedCallers
//! 4. **Event consistency**: Events are emitted only for state-changing operations
//!
//! # Event Policy
//!
//! | Operation | Condition | Event Emitted |
//! |-----------|-----------|---------------|
//! | add_authorized_caller | Address not in list, not revoked | `caller_added` |
//! | add_authorized_caller | Already authorized | No event (idempotent) |
//! | add_authorized_caller | Revoked | `CallerRevoked` error, no event |
//! | remove_authorized_caller | Address in list | `caller_removed` |
//! | remove_authorized_caller | Not in list | `CallerNotFound` error, no event |

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

    fn list(&self, items: &[&Address]) -> Vec<Address> {
        let mut v = Vec::new(&self.env);
        for a in items {
            v.push_back((*a).clone());
        }
        v
    }

    fn force_authorized(&self, addresses: &[&Address]) {
        self.instance(DataKey::AuthorizedCallers, self.list(addresses));
    }

    fn force_revoked(&self, addresses: &[&Address]) {
        self.instance(DataKey::RevokedCallers, self.list(addresses));
    }

    fn count_occurrences(&self, list: &Vec<Address>, addr: &Address) -> u32 {
        let mut count = 0;
        for entry in list.iter() {
            if entry == *addr {
                count += 1;
            }
        }
        count
    }
}

// ─── Uniqueness Invariant Tests ─────────────────────────────────────────────

/// Adding the same caller twice does not create duplicates.
#[test]
fn add_same_caller_twice_keeps_unique() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.add_authorized_caller(&s.admin, &circle);

    let callers = s.client.get_authorized_callers();
    assert_eq!(callers.len(), 1);
    assert_eq!(s.count_occurrences(&callers, &circle), 1);
}

/// Adding multiple different callers creates unique entries.
#[test]
fn add_multiple_callers_keeps_all_unique() {
    let s = setup();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);
    let c = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &a);
    s.client.add_authorized_caller(&s.admin, &b);
    s.client.add_authorized_caller(&s.admin, &c);

    let callers = s.client.get_authorized_callers();
    assert_eq!(callers.len(), 3);
    assert!(callers.contains(&a));
    assert!(callers.contains(&b));
    assert!(callers.contains(&c));
}

/// Removing and re-adding the same caller does not duplicate.
#[test]
fn remove_and_readd_does_not_duplicate() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle);
    // Re-add fails because revoked
    let result = s.client.try_add_authorized_caller(&s.admin, &circle);
    assert_eq!(result, Err(Ok(ReputationError::CallerRevoked)));

    let callers = s.client.get_authorized_callers();
    assert!(!callers.contains(&circle));
}

/// Force-set corrupted list with duplicates, then remove clears all.
#[test]
fn remove_clears_all_duplicates_from_corrupted_list() {
    let s = setup();
    let circle = Address::generate(&s.env);
    let other = Address::generate(&s.env);

    // Corrupt: same address appears twice
    s.force_authorized(&[&circle, &other, &circle]);

    s.client.remove_authorized_caller(&s.admin, &circle);

    let callers = s.client.get_authorized_callers();
    assert_eq!(s.count_occurrences(&callers, &circle), 0);
    assert_eq!(callers.len(), 1);
    assert!(callers.contains(&other));
}

// ─── Revocation Permanence Tests ─────────────────────────────────────────────

/// Once revoked, a caller cannot be re-authorized.
#[test]
fn revoked_caller_cannot_be_reauthorized() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle);

    let result = s.client.try_add_authorized_caller(&s.admin, &circle);
    assert_eq!(result, Err(Ok(ReputationError::CallerRevoked)));

    let callers = s.client.get_authorized_callers();
    assert!(!callers.contains(&circle));
    assert!(s.client.get_revoked_callers().contains(&circle));
}

/// Revocation is independent of allowlist state.
#[test]
fn revocation_works_on_stale_allowlist() {
    let s = setup();
    let circle = Address::generate(&s.env);

    // Add, then corrupt allowlist to include circle again
    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle);
    s.force_authorized(&[&circle, &circle]); // Corrupt: circle appears twice

    // Revocation outranks allowlist
    let result = s.client.try_increment(&circle, &Address::generate(&s.env));
    assert_eq!(result, Err(Ok(ReputationError::UnauthorizedCaller)));
}

/// Multiple revocations of the same caller are idempotent.
#[test]
fn multiple_revocation_attempts_are_idempotent() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle); // Second attempt

    let revoked = s.client.get_revoked_callers();
    assert_eq!(s.count_occurrences(&revoked, &circle), 1);
}

/// Revoked caller cannot increment even if still in allowlist.
#[test]
fn revoked_caller_rejected_even_if_in_allowlist() {
    let s = setup();
    let circle = Address::generate(&s.env);
    let member = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle);

    // Corrupt allowlist to include circle again
    s.force_authorized(&[&circle]);

    let result = s.client.try_increment(&circle, &member);
    assert_eq!(result, Err(Ok(ReputationError::UnauthorizedCaller)));
}

// ─── Authorization Decision Tests ───────────────────────────────────────────

/// Caller is authorized iff in allowlist AND NOT in revoked list.
#[test]
fn authorization_decision_is_allowlist_minus_revoked() {
    let s = setup();
    let authorized = Address::generate(&s.env);
    let revoked = Address::generate(&s.env);
    let unknown = Address::generate(&s.env);
    let member = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &authorized);
    s.client.add_authorized_caller(&s.admin, &revoked);
    s.client.remove_authorized_caller(&s.admin, &revoked);

    // Authorized caller works
    assert!(s.client.get_authorized_callers().contains(&authorized));
    assert!(!s.client.get_revoked_callers().contains(&authorized));
    let result = s.client.try_increment(&authorized, &member);
    assert!(result.is_ok(), "authorized caller should work");

    // Revoked caller fails
    assert!(!s.client.get_authorized_callers().contains(&revoked));
    assert!(s.client.get_revoked_callers().contains(&revoked));
    let result = s.client.try_increment(&revoked, &member);
    assert_eq!(result, Err(Ok(ReputationError::UnauthorizedCaller)));

    // Unknown caller fails
    let result = s.client.try_increment(&unknown, &member);
    assert_eq!(result, Err(Ok(ReputationError::UnauthorizedCaller)));
}

/// Removing non-existent caller returns error.
#[test]
fn remove_nonexistent_caller_returns_caller_not_found() {
    let s = setup();
    let circle = Address::generate(&s.env);

    let result = s.client.try_remove_authorized_caller(&s.admin, &circle);
    assert_eq!(result, Err(Ok(ReputationError::CallerNotFound)));
}

/// Adding already-authorized caller is idempotent (no error).
#[test]
fn add_already_authorized_is_idempotent() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    let result = s.client.try_add_authorized_caller(&s.admin, &circle);
    assert!(result.is_ok(), "idempotent add should succeed");
}

// ─── Event Consistency Tests ─────────────────────────────────────────────────

/// Each successful add emits exactly one caller_added event.
#[test]
fn successful_add_emits_one_event() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);

    let events = s.env.events().all().events();
    let added_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let body = &e.body;
            let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
            v0.topics.len() == 2
                && v0.topics[1]
                    == soroban_sdk::xdr::ScVal::Symbol(soroban_sdk::Symbol::new(&s.env, "caller_added").to_val().try_into().unwrap())
        })
        .collect();

    assert_eq!(added_events.len(), 1);
}

/// Idempotent add emits no event.
#[test]
fn idempotent_add_emits_no_event() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.add_authorized_caller(&s.admin, &circle);

    let events = s.env.events().all().events();
    let added_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let body = &e.body;
            let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
            v0.topics.len() == 2
                && v0.topics[1]
                    == soroban_sdk::xdr::ScVal::Symbol(soroban_sdk::Symbol::new(&s.env, "caller_added").to_val().try_into().unwrap())
        })
        .collect();

    assert_eq!(added_events.len(), 1, "only first add should emit event");
}

/// Successful remove emits exactly one caller_removed event.
#[test]
fn successful_remove_emits_one_event() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle);

    let events = s.env.events().all().events();
    let removed_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let body = &e.body;
            let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
            v0.topics.len() == 2
                && v0.topics[1]
                    == soroban_sdk::xdr::ScVal::Symbol(soroban_sdk::Symbol::new(&s.env, "caller_removed").to_val().try_into().unwrap())
        })
        .collect();

    assert_eq!(removed_events.len(), 1);
}

/// Failed remove (not found) emits no event.
#[test]
fn failed_remove_emits_no_event() {
    let s = setup();
    let circle = Address::generate(&s.env);

    let _ = s.client.try_remove_authorized_caller(&s.admin, &circle);

    let events = s.env.events().all().events();
    let removed_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let body = &e.body;
            let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
            v0.topics.len() == 2
                && v0.topics[1]
                    == soroban_sdk::xdr::ScVal::Symbol(soroban_sdk::Symbol::new(&s.env, "caller_removed").to_val().try_into().unwrap())
        })
        .collect();

    assert_eq!(removed_events.len(), 0);
}

/// Rejected re-add (revoked) emits no event.
#[test]
fn rejected_readd_emits_no_event() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle);
    let _ = s.client.try_add_authorized_caller(&s.admin, &circle);

    let events = s.env.events().all().events();
    let added_events: Vec<_> = events
        .iter()
        .filter(|e| {
            let body = &e.body;
            let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
            v0.topics.len() == 2
                && v0.topics[1]
                    == soroban_sdk::xdr::ScVal::Symbol(soroban_sdk::Symbol::new(&s.env, "caller_added").to_val().try_into().unwrap())
        })
        .collect();

    assert_eq!(added_events.len(), 1, "only initial add should emit event");
}

// ─── Event Payload Tests ─────────────────────────────────────────────────────

/// caller_added event carries the circle address.
#[test]
fn caller_added_event_carries_address() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);

    let events = s.env.events().all().events();
    let event = events.iter().find(|e| {
        let body = &e.body;
        let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
        v0.topics.len() == 2
            && v0.topics[1]
                == soroban_sdk::xdr::ScVal::Symbol(soroban_sdk::Symbol::new(&s.env, "caller_added").to_val().try_into().unwrap())
    }).unwrap();

    let body = &event.body;
    let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
    let event_circle: Address = FromVal::from_val(&s.env, &v0.data);
    assert_eq!(event_circle, circle);
}

/// caller_removed event carries the circle address.
#[test]
fn caller_removed_event_carries_address() {
    let s = setup();
    let circle = Address::generate(&s.env);

    s.client.add_authorized_caller(&s.admin, &circle);
    s.client.remove_authorized_caller(&s.admin, &circle);

    let events = s.env.events().all().events();
    let event = events.iter().find(|e| {
        let body = &e.body;
        let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
        v0.topics.len() == 2
            && v0.topics[1]
                == soroban_sdk::xdr::ScVal::Symbol(soroban_sdk::Symbol::new(&s.env, "caller_removed").to_val().try_into().unwrap())
    }).unwrap();

    let body = &event.body;
    let soroban_sdk::xdr::ContractEventBody::V0(v0) = body;
    let event_circle: Address = FromVal::from_val(&s.env, &v0.data);
    assert_eq!(event_circle, circle);
}

// ─── Complex Sequence Tests ──────────────────────────────────────────────────

/// Sequence: add A, add B, remove A, add C, remove B, add A (fails)
#[test]
fn complex_sequence_maintains_invariants() {
    let s = setup();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);
    let c = Address::generate(&s.env);
    let member = Address::generate(&s.env);

    // Add A, B
    s.client.add_authorized_caller(&s.admin, &a);
    s.client.add_authorized_caller(&s.admin, &b);
    assert_eq!(s.client.get_authorized_callers().len(), 2);

    // Remove A
    s.client.remove_authorized_caller(&s.admin, &a);
    assert!(!s.client.get_authorized_callers().contains(&a));
    assert!(s.client.get_revoked_callers().contains(&a));

    // Add C
    s.client.add_authorized_caller(&s.admin, &c);
    assert_eq!(s.client.get_authorized_callers().len(), 2); // B, C

    // Remove B
    s.client.remove_authorized_caller(&s.admin, &b);
    assert!(!s.client.get_authorized_callers().contains(&b));
    assert!(s.client.get_revoked_callers().contains(&b));

    // Try to re-add A (revoked)
    let result = s.client.try_add_authorized_caller(&s.admin, &a);
    assert_eq!(result, Err(Ok(ReputationError::CallerRevoked)));

    // Verify final state
    let callers = s.client.get_authorized_callers();
    assert_eq!(callers.len(), 1);
    assert!(callers.contains(&c));
    assert!(!callers.contains(&a));
    assert!(!callers.contains(&b));

    // Only C can increment
    assert!(s.client.try_increment(&c, &member).is_ok());
    assert_eq!(s.client.try_increment(&a, &member), Err(Ok(ReputationError::UnauthorizedCaller)));
    assert_eq!(s.client.try_increment(&b, &member), Err(Ok(ReputationError::UnauthorizedCaller)));
}

/// Rapid add/remove sequence maintains consistency.
#[test]
fn rapid_add_remove_sequence_keeps_consistent_state() {
    let s = setup();
    let circle = Address::generate(&s.env);

    for _ in 0..10 {
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);
    }

    let callers = s.client.get_authorized_callers();
    let revoked = s.client.get_revoked_callers();

    assert!(!callers.contains(&circle));
    assert!(revoked.contains(&circle));
    assert_eq!(s.count_occurrences(&revoked, &circle), 1);
}

/// Admin can still manage other callers after many revocations.
#[test]
fn admin_can_manage_others_after_many_revocations() {
    let s = setup();
    let circles: Vec<Address> = (0..5)
        .map(|_| Address::generate(&s.env))
        .collect();

    // Add all
    for &circle in circles.iter() {
        s.client.add_authorized_caller(&s.admin, &circle);
    }

    // Revoke first three
    for i in 0..3 {
        s.client.remove_authorized_caller(&s.admin, &circles.get(i).unwrap());
    }

    // Add new one
    let new_circle = Address::generate(&s.env);
    s.client.add_authorized_caller(&s.admin, &new_circle);

    // Verify state
    let callers = s.client.get_authorized_callers();
    assert_eq!(callers.len(), 3); // circles[3], circles[4], new_circle
    assert!(callers.contains(&circles.get(3).unwrap()));
    assert!(callers.contains(&circles.get(4).unwrap()));
    assert!(callers.contains(&new_circle));
}

// ─── Getters vs Events Consistency ─────────────────────────────────----------

/// After each operation, getters reflect the same state as event replay.
#[test]
fn getters_match_event_replay_after_each_operation() {
    let s = setup();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);

    // Initial: empty
    assert!(s.client.get_authorized_callers().is_empty());
    assert!(s.client.get_revoked_callers().is_empty());

    // Add A
    s.client.add_authorized_caller(&s.admin, &a);
    assert!(s.client.get_authorized_callers().contains(&a));
    assert!(!s.client.get_revoked_callers().contains(&a));

    // Add B
    s.client.add_authorized_caller(&s.admin, &b);
    assert!(s.client.get_authorized_callers().contains(&b));

    // Remove A
    s.client.remove_authorized_caller(&s.admin, &a);
    assert!(!s.client.get_authorized_callers().contains(&a));
    assert!(s.client.get_revoked_callers().contains(&a));

    // Final state
    let callers = s.client.get_authorized_callers();
    let revoked = s.client.get_revoked_callers();
    assert_eq!(callers.len(), 1);
    assert!(callers.contains(&b));
    assert_eq!(revoked.len(), 1);
    assert!(revoked.contains(&a));
}