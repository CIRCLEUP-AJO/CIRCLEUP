use super::*;

    fn test_560_mark_default_penalty_arithmetic_safe_at_max_members() {
        let env = Env::default();
        env.mock_all_auths();
        env.budget().reset_unlimited();

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token_asset = soroban_sdk::token::StellarAssetClient::new(&env, &token_id.address());

        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        rep_client.initialize(&Address::generate(&env));

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);
        rep_client.add_authorized_caller(&rep_client.get_admin(), &circle_id);

        let round_amount: i128 = 1_000_000;
        let collateral = round_amount * COLLATERAL_MULTIPLIER;

        let mut members = Vec::new(&env);
        for _ in 0..MAX_MEMBERS {
            let m = Address::generate(&env);
            token_asset.mint(&m, &(collateral + round_amount));
            members.push_back(m);
        }

        circle.initialize(
            &Address::generate(&env),
            &members,
            &round_amount,
            &token_id.address(),
            &rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        for i in 0..MAX_MEMBERS {
            circle.join(&members.get(i).unwrap());
        }
        assert_eq!(circle.get_status(), CircleStatus::Active);

        env.ledger().with_mut(|l| {
            l.sequence_number += MIN_ROUND_DEADLINE_LEDGERS + 1;
        });

        let defaulter = members.get(0).unwrap();
        let collateral_before = circle.get_collateral(&defaulter);

        circle.mark_default(&defaulter);

        let collateral_after = circle.get_collateral(&defaulter);
        let expected_penalty = collateral_before * PENALTY_BPS / BPS_DENOM;
        assert_eq!(
            collateral_before - collateral_after,
            expected_penalty,
            "penalty must equal exactly PENALTY_BPS / BPS_DENOM of collateral"
        );
        assert_eq!(circle.get_defaults(&defaulter), 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #551 — Clarify cancelled state semantics and supported lifecycle paths
    //
    // Tests in this section document which operations are blocked on a Cancelled
    // circle and which reads remain available, providing a clear contract for
    // off-chain consumers and SDK implementors.
    // ══════════════════════════════════════════════════════════════════════════

    /// join() on a Cancelled circle must panic: the circle is no longer
    /// accepting members after cancellation.
    #[test]
    #[should_panic]
    fn test_551_join_on_cancelled_circle_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
        t.circle.join(&t.bob);
    }

    /// contribute() on a Cancelled circle must panic: only Active circles
    /// accept contributions.
    #[test]
    #[should_panic]
    fn test_551_contribute_on_cancelled_circle_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
        t.circle.contribute(&t.alice);
    }

    /// payout() on a Cancelled circle must panic: no round is in progress after
    /// cancellation.
    #[test]
    #[should_panic]
    fn test_551_payout_on_cancelled_circle_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
        t.circle.payout();
    }

    /// cancel() on an already-Cancelled circle must panic: only Pending circles
    /// may be cancelled.
    #[test]
    #[should_panic]
    fn test_551_cancel_already_cancelled_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
        t.circle.cancel(&t.bob);
    }

    /// All read-only views must remain callable on a Cancelled circle.
    /// `get_current_round` returns a typed `Err` (not a host trap) for terminal
    /// states — this is the correct, documented behavior.  All other views must
    /// succeed and return their last committed values.
    #[test]
    fn test_551_read_only_views_succeed_on_cancelled_circle() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

        let _ = t.circle.get_config();
        let _ = t.circle.get_status();
        // get_current_round returns a typed error for terminal states — must
        // not cause a host trap; a clean Err proves the path is handled.
        assert!(
            t.circle.try_get_current_round().is_err(),
            "get_current_round must return a typed Err (not a host trap) on Cancelled"
        );
        let _ = t.circle.get_pot_amount();
        let _ = t.circle.get_collateral(&t.alice);
        let _ = t.circle.get_defaults(&t.alice);
        let _ = t.circle.get_protocol_params();
        let _ = t.circle.get_usdc_token();
        let _ = t.circle.get_admin();
        assert!(!t.circle.is_closed(), "cancelled-but-not-closed must report is_closed = false");
    }

}


//! Join-order and address-mismatch tests (issue #572).
//!
//! # Invariants under test
//!
//! 1. **Join order never changes the rotation.**  The payout recipient of
//!    round `i` is always `members[i]` from `initialize`, no matter in which
//!    order members call `join`.
//! 2. **`joined.join_order` reflects join sequence, not member index.**
//! 3. **No round operation runs before activation.**  While any member has
//!    not joined, `contribute`, `payout`, `mark_default` and `settle_round`
//!    are rejected and move no funds.
//! 4. **Join is only open while Pending and unpaused.**  Joining after
//!    activation, after cancellation, before initialization or while paused
//!    is rejected.
//! 5. **The acting address must be the signing address and a configured
//!    member.**  Signing as one member while naming another, or naming an
//!    address outside `members`, is rejected with no state change.

#![cfg(test)]
extern crate std;

use crate::test_support::{fixture, Fixture, COLLATERAL, ROUND_AMOUNT};
use crate::{CircleContract, CircleContractClient, CircleStatus};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Env, FromVal, IntoVal,
};

/// Have `member` join and decode the single `joined` event it emits.
fn join_and_decode(t: &Fixture, member: &Address) -> (Address, Address, u32, i128) {
    let joined: std::vec::Vec<_> = t
        .circle_events_of(|| t.circle.join(member))
        .into_iter()
        .filter(|(topics, _)| {
            topics.len() == 2
                && soroban_sdk::Symbol::from_val(&t.env, &topics.get(1).unwrap())
                    == soroban_sdk::Symbol::new(&t.env, "joined")
        })
        .collect();
    assert_eq!(joined.len(), 1, "expected exactly one joined event");
    FromVal::from_val(&t.env, &joined[0].1)
}

// ── 1 & 2: join order vs rotation order ──────────────────────────────────────

#[test]
fn reverse_join_order_keeps_configured_rotation() {
    let t = fixture();
    // Join in the reverse of the configured order.
    for i in (0..4).rev() {
        t.circle.join(&t.member(i));
    }
    assert_eq!(t.circle.get_status(), CircleStatus::Active);

    // Every round pays members[i], not the i-th joiner.
    for i in 0..4u32 {
        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, i);
        assert_eq!(
            round.recipient,
            t.member(i),
            "round {i} recipient must follow members[], not join order"
        );
        let before = t.token.balance(&t.member(i));
        t.contribute_all();
        t.circle.payout();
        // Pot is 4 × round_amount; the recipient paid 1 × of it this round.
        assert_eq!(
            t.token.balance(&t.member(i)) - before,
            ROUND_AMOUNT * 3,
            "round {i} pot must reach members[{i}]"
        );
    }
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);
}

#[test]
fn interleaved_join_order_keeps_configured_rotation() {
    let t = fixture();
    for m in [&t.carol, &t.alice, &t.dave, &t.bob] {
        t.circle.join(m);
    }
    assert_eq!(t.circle.get_current_round().recipient, t.alice);
    t.contribute_all();
    t.circle.payout();
    assert_eq!(t.circle.get_current_round().recipient, t.bob);
}

#[test]
fn joined_event_order_is_join_sequence_not_member_index() {
    let t = fixture();
    let expected = [(&t.dave, 1u32), (&t.bob, 2), (&t.alice, 3), (&t.carol, 4)];
    for (member, order) in expected {
        let (circle_addr, who, join_order, collateral) = join_and_decode(&t, member);
        assert_eq!(circle_addr, t.circle_id);
        assert_eq!(&who, member);
        assert_eq!(join_order, order, "join_order must count joins, not index");
        assert_eq!(collateral, COLLATERAL);
    }
}

#[test]
fn circle_activates_only_on_last_join_regardless_of_order() {
    let t = fixture();
    for m in [&t.dave, &t.carol, &t.bob] {
        t.circle.join(m);
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
    }
    t.circle.join(&t.alice);
    assert_eq!(t.circle.get_status(), CircleStatus::Active);
}

// ── 3: round operations before activation ────────────────────────────────────

#[test]
fn round_operations_rejected_while_partially_joined() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.join(&t.bob);
    t.circle.join(&t.carol); // dave has not joined
    let circle_balance = t.token.balance(&t.circle_id);
    let alice_balance = t.token.balance(&t.alice);

    assert!(t.circle.try_contribute(&t.alice).is_err());
    assert!(t.circle.try_payout().is_err());
    t.advance_past_deadline();
    assert!(t.circle.try_mark_default(&t.dave).is_err());
    assert!(t.circle.try_settle_round().is_err());

    assert_eq!(t.circle.get_status(), CircleStatus::Pending);
    assert_eq!(t.token.balance(&t.circle_id), circle_balance);
    assert_eq!(t.token.balance(&t.alice), alice_balance);
    assert!(!t.circle.has_contributed(&t.alice, &0));
    assert_eq!(t.circle.get_defaults(&t.dave), 0);
}

#[test]
#[should_panic(expected = "circle is not active")]
fn contribute_before_all_joined_panics() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.contribute(&t.alice);
}

#[test]
#[should_panic(expected = "circle is not active")]
fn contribute_before_any_join_panics() {
    let t = fixture();
    t.circle.contribute(&t.alice);
}

// ── 4: join window ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "circle: join called before initialize")]
fn join_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, CircleContract);
    CircleContractClient::new(&env, &id).join(&Address::generate(&env));
}

#[test]
#[should_panic(expected = "circle not accepting members")]
fn rejoin_after_activation_panics() {
    let t = fixture();
    t.join_all();
    t.circle.join(&t.alice);
}

#[test]
fn join_after_cancel_rejected_without_taking_funds() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.cancel(&t.alice);
    let bob_balance = t.token.balance(&t.bob);

    assert!(t.circle.try_join(&t.bob).is_err());
    assert_eq!(t.token.balance(&t.bob), bob_balance);
    assert_eq!(t.circle.get_collateral(&t.bob), 0);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
}

#[test]
#[should_panic(expected = "circle not accepting members")]
fn join_after_cancel_panics() {
    let t = fixture();
    t.circle.cancel(&t.alice);
    t.circle.join(&t.bob);
}

#[test]
fn join_while_paused_rejected_then_accepted_after_resume() {
    let t = fixture();
    t.circle.pause(&t.admin);
    assert!(t.circle.try_join(&t.alice).is_err());
    assert_eq!(t.circle.get_collateral(&t.alice), 0);

    t.circle.resume(&t.admin);
    let (_, _, join_order, _) = join_and_decode(&t, &t.alice);
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
    assert_eq!(join_order, 1, "rejected paused join must not consume a slot");
}

// ── 5: address mismatches ────────────────────────────────────────────────────

#[test]
fn join_by_non_member_rejected_without_state_change() {
    let t = fixture();
    let stranger = Address::generate(&t.env);
    t.asset.mint(&stranger, &COLLATERAL);

    assert!(t.circle.try_join(&stranger).is_err());
    assert_eq!(t.token.balance(&stranger), COLLATERAL);
    assert_eq!(t.token.balance(&t.circle_id), 0);
    assert_eq!(t.circle.get_collateral(&stranger), 0);
    assert_eq!(t.circle.get_status(), CircleStatus::Pending);
}

#[test]
#[should_panic(expected = "not a circle member")]
fn join_by_non_member_panics() {
    let t = fixture();
    t.circle.join(&Address::generate(&t.env));
}

#[test]
#[should_panic(expected = "not a circle member")]
fn cancel_by_non_member_panics() {
    let t = fixture();
    t.circle.cancel(&Address::generate(&t.env));
}

#[test]
#[should_panic(expected = "not a member")]
fn contribute_by_non_member_panics() {
    let t = fixture();
    t.join_all();
    t.circle.contribute(&Address::generate(&t.env));
}

/// Alice signs, but the call names Bob: Bob's `require_auth` has no matching
/// signature, so the join is rejected and neither wallet is debited.
#[test]
fn join_signed_by_different_member_rejected() {
    let t = fixture();
    let alice_before = t.token.balance(&t.alice);
    let bob_before = t.token.balance(&t.bob);

    t.env.mock_auths(&[MockAuth {
        address: &t.alice,
        invoke: &MockAuthInvoke {
            contract: &t.circle_id,
            fn_name: "join",
            args: (t.bob.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(t.circle.try_join(&t.bob).is_err());

    t.env.mock_all_auths();
    assert_eq!(t.circle.get_collateral(&t.bob), 0);
    assert_eq!(t.token.balance(&t.alice), alice_before);
    assert_eq!(t.token.balance(&t.bob), bob_before);
    assert_eq!(t.token.balance(&t.circle_id), 0);
}

/// Control for the mismatch test: the same explicit-auth setup succeeds when
/// the signer and the named member are the same address.
#[test]
fn join_signed_by_same_member_succeeds() {
    let t = fixture();
    t.env.mock_auths(&[MockAuth {
        address: &t.alice,
        invoke: &MockAuthInvoke {
            contract: &t.circle_id,
            fn_name: "join",
            args: (t.alice.clone(),).into_val(&t.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &t.token.address,
                fn_name: "transfer",
                args: (t.alice.clone(), t.circle_id.clone(), COLLATERAL).into_val(&t.env),
                sub_invokes: &[],
            }],
        },
    }]);
    t.circle.join(&t.alice);
    t.env.mock_all_auths();
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
}

#[test]
fn contribute_signed_by_different_member_rejected() {
    let t = fixture();
    t.join_all();
    let bob_before = t.token.balance(&t.bob);

    t.env.mock_auths(&[MockAuth {
        address: &t.alice,
        invoke: &MockAuthInvoke {
            contract: &t.circle_id,
            fn_name: "contribute",
            args: (t.bob.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(t.circle.try_contribute(&t.bob).is_err());

    t.env.mock_all_auths();
    assert!(!t.circle.has_contributed(&t.bob, &0));
    assert_eq!(t.token.balance(&t.bob), bob_before);
    assert_eq!(t.circle.get_current_round().contributions_received, 0);
}

#[test]
fn close_by_non_member_rejected_and_collateral_kept() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.cancel(&t.alice);

    assert!(t.circle.try_close(&Address::generate(&t.env)).is_err());
    assert!(!t.circle.is_closed());
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
}
