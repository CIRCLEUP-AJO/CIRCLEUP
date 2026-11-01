use super::*;

    fn test_join_locks_collateral() {
        let t = setup_circle();
        let bal_before = t.token.balance(&t.alice);
        t.circle.join(&t.alice);
        let bal_after = t.token.balance(&t.alice);
        // Collateral is COLLATERAL_MULTIPLIER × round_amount
        let expected_collateral = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;
        assert_eq!(bal_before - bal_after, expected_collateral);
        assert_eq!(t.circle.get_collateral(&t.alice), expected_collateral);
    }

    #[test]
    #[should_panic]
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

    #[test]
    fn test_contribute_transfers_tokens() {
        let t = setup_circle();
        t.activate();
        let bal_before = t.token.balance(&t.bob);
        t.circle.contribute(&t.bob);
        let bal_after = t.token.balance(&t.bob);
        assert_eq!(bal_before - bal_after, ROUND_AMOUNT);
    }

    #[test]
    #[should_panic]
    fn test_double_contribute_panics() {
        let t = setup_circle();
        t.activate();
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.alice);
    }


    // ── Payout / rotation tests ───────────────────────────────────────────────

    #[test]
    fn test_full_round_payout_goes_to_round_recipient() {
        let t = setup_circle();
        t.activate();

        let alice_bal_before = t.token.balance(&t.alice);
        t.contribute_all();

        // Round 0 recipient is alice (index 0)
        t.circle.payout();

        let alice_bal_after = t.token.balance(&t.alice);
        // Alice paid 1 round_amount (contribute) but received 4 × round_amount (payout)
        assert_eq!(alice_bal_after - alice_bal_before, ROUND_AMOUNT * 3);
    }

    #[test]
    fn test_payout_advances_to_next_round() {
        let t = setup_circle();
        t.activate();
        t.contribute_all();
        t.circle.payout();

        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1);
        assert_eq!(round.recipient, t.bob);
    }

    #[test]
    fn test_payout_correct_rotation_order() {
        let t = setup_circle();
        t.activate();

        let expected_order = [t.alice.clone(), t.bob.clone(), t.carol.clone(), t.dave.clone()];

        for (i, expected) in expected_order.iter().enumerate() {
            let round = t.circle.get_current_round();
            assert_eq!(round.round_index, i as u32);
            assert_eq!(&round.recipient, expected);
            t.contribute_all();
            t.circle.payout();
        }

        assert_eq!(t.circle.get_status(), CircleStatus::Completed);
    }

    #[test]
    #[should_panic]
    fn test_payout_before_all_contribute_panics() {
        let t = setup_circle();
        t.activate();
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        // carol and dave haven't contributed
        t.circle.payout();
    }


    // ── Default / penalty tests ───────────────────────────────────────────────

    #[test]
    fn test_mark_default_reduces_collateral_by_20_percent() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();

        // Carol didn't contribute — mark her default
        t.circle.mark_default(&t.carol);

        let collateral = t.circle.get_collateral(&t.carol);
        let expected = ROUND_AMOUNT - (ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM);
        assert_eq!(collateral, expected);
    }

    #[test]
    fn test_mark_default_increments_default_counter() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();

        assert_eq!(t.circle.get_defaults(&t.bob), 0);
        t.circle.mark_default(&t.bob);
        assert_eq!(t.circle.get_defaults(&t.bob), 1);
    }

    #[test]
    #[should_panic]
    fn test_mark_default_before_deadline_panics() {
        let t = setup_circle();
        t.activate();
        t.circle.mark_default(&t.carol);
    }

    #[test]
    #[should_panic]
    fn test_mark_default_on_contributor_panics() {
        let t = setup_circle();
        t.activate();
        t.circle.contribute(&t.carol);
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);
    }

    #[test]
    #[should_panic]
    fn test_mark_default_twice_same_round_panics() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);
        t.circle.mark_default(&t.carol); // second flag for same round must fail
    }

    #[test]
    fn test_mark_default_only_penalizes_non_contributors() {
        let t = setup_circle();
        t.activate();

        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.advance_past_deadline();

        // Alice contributed — cannot be flagged; Carol did not — can be flagged
        t.circle.mark_default(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);
        assert_eq!(t.circle.get_defaults(&t.alice), 0);

        let expected = ROUND_AMOUNT - (ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM);
        assert_eq!(t.circle.get_collateral(&t.carol), expected);
        assert_eq!(t.circle.get_collateral(&t.alice), ROUND_AMOUNT);
    }


    // ── Reputation tests ──────────────────────────────────────────────────────

    #[test]
    fn test_payout_updates_reputation() {
        let t = setup_circle();
        t.activate();
        t.contribute_all();

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
        t.activate();
        t.force_status(CircleStatus::Completed);

        let alice_bal_before = t.token.balance(&t.alice);
        t.circle.close(&t.alice);
        let alice_bal_after = t.token.balance(&t.alice);
        // Collateral (COLLATERAL_MULTIPLIER × round_amount) is returned on close
        assert_eq!(alice_bal_after - alice_bal_before, ROUND_AMOUNT * COLLATERAL_MULTIPLIER);
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        assert_eq!(t.circle.get_collateral(&t.bob), 0);
    }

    #[test]
    fn test_close_rejects_non_member() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        let stranger = Address::generate(&t.env);
        let result = t.circle.try_close(&stranger);
        assert_eq!(
            result,
            Err(Ok(CloseError::Unauthorized)),
            "non-member non-admin must receive CloseError::Unauthorized"
        );
    }

    #[test]
    fn test_close_second_call_returns_already_closed() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        t.circle.close(&t.bob);
        // Second invocation must return CloseError::AlreadyClosed.
        let result = t.circle.try_close(&t.carol);
        assert_eq!(
            result,
            Err(Ok(CloseError::AlreadyClosed)),
            "second close must return CloseError::AlreadyClosed"
        );
    }

    #[test]
    fn test_close_rejects_while_active() {
        let t = setup_circle();
        t.activate();
        let result = t.circle.try_close(&t.alice);
        assert_eq!(
            result,
            Err(Ok(CloseError::NotTerminalState)),
            "closing an active circle must return CloseError::NotTerminalState"
        );
    }

    #[test]
    fn test_close_admin_can_close() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        // The circle_admin is NOT a circle member but holds admin authority.
        // The dedicated close authorization rule must allow this call.
        assert!(!t.members.contains(&t.circle_admin), "circle_admin must not be a member");
        t.circle.close(&t.circle_admin);
        assert!(t.circle.is_closed(), "circle must be closed after admin-triggered close");
    }


    // ── Join edge-case: zero collateral must still block re-join ──────────────

    #[test]
    #[should_panic]
    fn test_join_rejects_when_collateral_key_exists_even_if_zero() {
        let t = setup_circle();
        t.circle.join(&t.alice);

        // Drain collateral to 0 while keeping the storage key, then verify the
        // `has` check (not `value > 0`) still prevents re-entry.
        t.force_collateral(&t.alice, 0i128);

        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        t.circle.join(&t.alice);
    }

    // ── force_collateral helper test ──────────────────────────────────────────

    #[test]
    fn test_force_collateral_helper_sets_value() {
        let t = setup_circle();
        t.activate();
        // Collateral is ROUND_AMOUNT after joining; override it to a custom value.
        t.force_collateral(&t.alice, 42i128);
        assert_eq!(t.circle.get_collateral(&t.alice), 42i128);
    }

    // ── Contribute after deadline (before payout) ─────────────────────────────

    #[test]
    #[should_panic]
    fn test_contribute_after_deadline_before_payout_panics() {
        let t = setup_circle();
        t.activate();

        // One member contributes on time; others wait past the deadline
        t.circle.contribute(&t.alice);
        t.advance_past_deadline();

        // Late contribution must be rejected even though payout has not run
        t.circle.contribute(&t.bob);
    }

    // ── Active transition / join gate tests ───────────────────────────────────

    #[test]
    #[should_panic]
    fn test_contribute_before_all_joined_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        // carol and dave have not joined — still Pending
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
        t.circle.contribute(&t.alice);
    }

    #[test]
    #[should_panic]
    fn test_join_after_active_panics() {
        let t = setup_circle();
        t.activate();
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
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

        let alice_before = t.token.balance(&t.alice);
        let bob_before = t.token.balance(&t.bob);
        t.circle.close(&t.alice);
        let expected_collateral = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;
        assert_eq!(t.token.balance(&t.alice) - alice_before, expected_collateral);
        assert_eq!(t.token.balance(&t.bob) - bob_before, expected_collateral);
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        assert_eq!(t.circle.get_collateral(&t.bob), 0);
    }

    #[test]
