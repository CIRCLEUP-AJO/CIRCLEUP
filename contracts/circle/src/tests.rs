//! Unit tests for the circle contract.

#[cfg(test)]
mod circle_tests {
    use crate::{
        CircleContract, CircleContractClient, CircleStatus, MAX_ROUND_DEADLINE_LEDGERS,
        MIN_ROUND_DEADLINE_LEDGERS,
    };
    use reputation::{ReputationContract, ReputationContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC in stroops (7 decimals)
    const ROUND_DEADLINE: u32 = 1000; // ledgers

    struct TestSetup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        token: TokenClient<'a>,
        token_address: Address,
        reputation_id: Address,
        #[allow(dead_code)]
        members: soroban_sdk::Vec<Address>,
        alice: Address,
        bob: Address,
        carol: Address,
        dave: Address,
    }

    fn setup_circle() -> TestSetup<'static> {
        let env = Env::default();
        env.mock_all_auths();

        // Deploy USDC mock token
        let _token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(_token_admin.clone());
        let token = TokenClient::new(&env, &token_id.address());
        let token_asset_client = StellarAssetClient::new(&env, &token_id.address());

        // Deploy reputation contract
        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);

        // Create 4 members
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);
        let dave = Address::generate(&env);

        // Fund each member: collateral (1×) + 4 rounds of contributions
        for m in [&alice, &bob, &carol, &dave] {
            token_asset_client.mint(m, &(ROUND_AMOUNT * 5));
        }

        // Deploy circle contract
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(alice.clone());
        members.push_back(bob.clone());
        members.push_back(carol.clone());
        members.push_back(dave.clone());

        circle.initialize(
            &members,
            &ROUND_AMOUNT,
            &token_id.address(),
            &rep_id,
            &ROUND_DEADLINE,
        );

        TestSetup {
            env,
            circle,
            token,
            token_address: token_id.address(),
            reputation_id: rep_id,
            members,
            alice,
            bob,
            carol,
            dave,
        }
    }

    // ── Join tests ────────────────────────────────────────────────────────────

    #[test]
    fn test_join_locks_collateral() {
        let t = setup_circle();
        let bal_before = t.token.balance(&t.alice);
        t.circle.join(&t.alice);
        let bal_after = t.token.balance(&t.alice);
        assert_eq!(bal_before - bal_after, ROUND_AMOUNT);
        assert_eq!(t.circle.get_collateral(&t.alice), ROUND_AMOUNT);
    }

    #[test]
    #[should_panic(expected = "already joined")]
    fn test_double_join_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.join(&t.alice);
    }

    #[test]
    fn test_all_join_activates_circle() {
        let t = setup_circle();
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.join(&t.carol);
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
        t.circle.join(&t.dave);
        assert_eq!(t.circle.get_status(), CircleStatus::Active);
    }

    // ── Contribution tests ────────────────────────────────────────────────────

    fn activate(t: &TestSetup) {
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.join(&t.carol);
        t.circle.join(&t.dave);
    }

    #[test]
    fn test_contribute_transfers_tokens() {
        let t = setup_circle();
        activate(&t);
        let bal_before = t.token.balance(&t.bob);
        t.circle.contribute(&t.bob);
        let bal_after = t.token.balance(&t.bob);
        assert_eq!(bal_before - bal_after, ROUND_AMOUNT);
    }

    #[test]
    #[should_panic(expected = "already contributed this round")]
    fn test_double_contribute_panics() {
        let t = setup_circle();
        activate(&t);
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.alice);
    }

    // ── Payout / rotation tests ───────────────────────────────────────────────

    #[test]
    fn test_full_round_payout_goes_to_round_recipient() {
        let t = setup_circle();
        activate(&t);

        let alice_bal_before = t.token.balance(&t.alice);

        // All contribute
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        t.circle.contribute(&t.dave);

        // Round 0 recipient is alice (index 0)
        t.circle.payout();

        let alice_bal_after = t.token.balance(&t.alice);
        // Alice paid 1 round_amount (contribute) but received 4 × round_amount (payout)
        assert_eq!(alice_bal_after - alice_bal_before, ROUND_AMOUNT * 3);
    }

    #[test]
    fn test_payout_advances_to_next_round() {
        let t = setup_circle();
        activate(&t);

        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        t.circle.contribute(&t.dave);
        t.circle.payout();

        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1);
        assert_eq!(round.recipient, t.bob);
    }

    #[test]
    fn test_payout_correct_rotation_order() {
        let t = setup_circle();
        activate(&t);

        let expected_order = [t.alice.clone(), t.bob.clone(), t.carol.clone(), t.dave.clone()];

        for (i, expected) in expected_order.iter().enumerate() {
            let round = t.circle.get_current_round();
            assert_eq!(round.round_index, i as u32);
            assert_eq!(&round.recipient, expected);

            t.circle.contribute(&t.alice);
            t.circle.contribute(&t.bob);
            t.circle.contribute(&t.carol);
            t.circle.contribute(&t.dave);
            t.circle.payout();
        }

        assert_eq!(t.circle.get_status(), CircleStatus::Completed);
    }

    #[test]
    #[should_panic(expected = "not all members have contributed yet")]
    fn test_payout_before_all_contribute_panics() {
        let t = setup_circle();
        activate(&t);
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        // carol and dave haven't contributed
        t.circle.payout();
    }

    // ── Default / penalty tests ───────────────────────────────────────────────

    #[test]
    fn test_mark_default_reduces_collateral_by_20_percent() {
        let t = setup_circle();
        activate(&t);

        // Advance ledger past deadline
        t.env.ledger().with_mut(|l| {
            l.sequence_number += ROUND_DEADLINE + 1;
        });

        // Carol didn't contribute — mark her default
        t.circle.mark_default(&t.carol);

        let collateral = t.circle.get_collateral(&t.carol);
        let expected = ROUND_AMOUNT - (ROUND_AMOUNT * 2000 / 10000);
        assert_eq!(collateral, expected);
    }

    #[test]
    fn test_mark_default_increments_default_counter() {
        let t = setup_circle();
        activate(&t);

        t.env.ledger().with_mut(|l| {
            l.sequence_number += ROUND_DEADLINE + 1;
        });

        assert_eq!(t.circle.get_defaults(&t.bob), 0);
        t.circle.mark_default(&t.bob);
        assert_eq!(t.circle.get_defaults(&t.bob), 1);
    }

    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn test_mark_default_before_deadline_panics() {
        let t = setup_circle();
        activate(&t);
        t.circle.mark_default(&t.carol);
    }

    #[test]
    #[should_panic(expected = "member did contribute")]
    fn test_mark_default_on_contributor_panics() {
        let t = setup_circle();
        activate(&t);
        t.circle.contribute(&t.carol);

        t.env.ledger().with_mut(|l| {
            l.sequence_number += ROUND_DEADLINE + 1;
        });

        t.circle.mark_default(&t.carol);
    }

    // ── Reputation tests ──────────────────────────────────────────────────────

    #[test]
    fn test_payout_updates_reputation() {
        let t = setup_circle();
        activate(&t);

        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        t.circle.contribute(&t.dave);

        let config = t.circle.get_config();
        let rep_client = ReputationContractClient::new(&t.env, &config.reputation_contract);

        assert_eq!(rep_client.score(&t.alice), 0);
        t.circle.payout();
        assert_eq!(rep_client.score(&t.alice), 1);
    }

    // ── Close tests ───────────────────────────────────────────────────────────

    #[test]
    fn test_close_returns_collateral() {
        let t = setup_circle();
        activate(&t);

        let expected_order = [t.alice.clone(), t.bob.clone(), t.carol.clone(), t.dave.clone()];
        for _ in expected_order.iter() {
            t.circle.contribute(&t.alice);
            t.circle.contribute(&t.bob);
            t.circle.contribute(&t.carol);
            t.circle.contribute(&t.dave);
            t.circle.payout();
        }

        assert_eq!(t.circle.get_status(), CircleStatus::Completed);

        let alice_bal_before = t.token.balance(&t.alice);
        t.circle.close();
        let alice_bal_after = t.token.balance(&t.alice);
        assert_eq!(alice_bal_after - alice_bal_before, ROUND_AMOUNT); // collateral returned
    }

    // ── Active transition / join gate tests ───────────────────────────────────

    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_contribute_before_all_joined_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        // carol and dave have not joined — still Pending
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
        t.circle.contribute(&t.alice);
    }

    #[test]
    #[should_panic(expected = "circle not accepting members")]
    fn test_join_after_active_panics() {
        let t = setup_circle();
        activate(&t);
        assert_eq!(t.circle.get_status(), CircleStatus::Active);
        // Status gate rejects further joins once Active (even for listed members)
        t.circle.join(&t.alice);
    }

    #[test]
    fn test_active_resets_round_deadline_from_activation() {
        let t = setup_circle();

        // Advance ledgers during the join window
        t.env.ledger().with_mut(|l| {
            l.sequence_number += 500;
        });

        let seq_before_last_join = t.env.ledger().sequence();
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.join(&t.carol);
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);

        t.circle.join(&t.dave);
        assert_eq!(t.circle.get_status(), CircleStatus::Active);

        let round = t.circle.get_current_round();
        assert_eq!(
            round.deadline_ledger,
            seq_before_last_join as u64 + ROUND_DEADLINE as u64
        );
    }

    // ── Cancel / Cancelled semantics tests ────────────────────────────────────

    #[test]
    fn test_cancel_pending_sets_cancelled() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
    }

    #[test]
    fn test_close_after_cancel_returns_joined_collateral() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.cancel(&t.carol);

        let alice_before = t.token.balance(&t.alice);
        let bob_before = t.token.balance(&t.bob);
        t.circle.close();
        assert_eq!(t.token.balance(&t.alice) - alice_before, ROUND_AMOUNT);
        assert_eq!(t.token.balance(&t.bob) - bob_before, ROUND_AMOUNT);
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        assert_eq!(t.circle.get_collateral(&t.bob), 0);
    }

    #[test]
    #[should_panic(expected = "can only cancel a pending circle")]
    fn test_cancel_active_panics() {
        let t = setup_circle();
        activate(&t);
        t.circle.cancel(&t.alice);
    }

    #[test]
    #[should_panic(expected = "not a circle member")]
    fn test_cancel_by_non_member_panics() {
        let t = setup_circle();
        let outsider = Address::generate(&t.env);
        t.circle.cancel(&outsider);
    }

    // ── round_deadline_ledgers bounds tests ───────────────────────────────────

    #[test]
    #[should_panic(expected = "round_deadline_ledgers below minimum")]
    fn test_initialize_deadline_below_minimum_panics() {
        let t = setup_circle();
        let circle_id = t.env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&t.env, &circle_id);
        circle.initialize(
            &t.members,
            &ROUND_AMOUNT,
            &t.token_address,
            &t.reputation_id,
            &(MIN_ROUND_DEADLINE_LEDGERS - 1),
        );
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers above maximum")]
    fn test_initialize_deadline_above_maximum_panics() {
        let t = setup_circle();
        let circle_id = t.env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&t.env, &circle_id);
        circle.initialize(
            &t.members,
            &ROUND_AMOUNT,
            &t.token_address,
            &t.reputation_id,
            &(MAX_ROUND_DEADLINE_LEDGERS + 1),
        );
    }

    #[test]
    fn test_initialize_deadline_at_bounds_succeeds() {
        let t = setup_circle();

        let circle_lo = t.env.register_contract(None, CircleContract);
        let client_lo = CircleContractClient::new(&t.env, &circle_lo);
        client_lo.initialize(
            &t.members,
            &ROUND_AMOUNT,
            &t.token_address,
            &t.reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert_eq!(
            client_lo.get_config().round_deadline_ledgers,
            MIN_ROUND_DEADLINE_LEDGERS
        );

        let circle_hi = t.env.register_contract(None, CircleContract);
        let client_hi = CircleContractClient::new(&t.env, &circle_hi);
        client_hi.initialize(
            &t.members,
            &ROUND_AMOUNT,
            &t.token_address,
            &t.reputation_id,
            &MAX_ROUND_DEADLINE_LEDGERS,
        );
        assert_eq!(
            client_hi.get_config().round_deadline_ledgers,
            MAX_ROUND_DEADLINE_LEDGERS
        );
    }

    // ── mark_default current-round-only tests ─────────────────────────────────

    #[test]
    #[should_panic(expected = "already marked default this round")]
    fn test_mark_default_twice_same_round_panics() {
        let t = setup_circle();
        activate(&t);

        t.env.ledger().with_mut(|l| {
            l.sequence_number += ROUND_DEADLINE + 1;
        });

        t.circle.mark_default(&t.carol);
        t.circle.mark_default(&t.carol); // second flag for same round must fail
    }

    #[test]
    fn test_mark_default_only_penalizes_non_contributors() {
        let t = setup_circle();
        activate(&t);

        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);

        t.env.ledger().with_mut(|l| {
            l.sequence_number += ROUND_DEADLINE + 1;
        });

        // Alice contributed — cannot be flagged
        // Carol did not — can be flagged
        t.circle.mark_default(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);
        assert_eq!(t.circle.get_defaults(&t.alice), 0);

        let expected = ROUND_AMOUNT - (ROUND_AMOUNT * 2000 / 10000);
        assert_eq!(t.circle.get_collateral(&t.carol), expected);
        assert_eq!(t.circle.get_collateral(&t.alice), ROUND_AMOUNT);
    }
}
