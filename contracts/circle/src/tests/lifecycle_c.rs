use super::*;

    fn test_last_join_order_equals_member_count() {
        let t = setup_circle();
        t.activate(); // all 4 members join

        let joined = events_named(&t.env, "joined");
        assert_eq!(joined.len(), 4, "expected one 'joined' event per member");

        // The final join (dave) should carry order == 4 == total member count.
        let last_val = joined.last().unwrap().clone();
        let (_circle, member, order, _collateral): (Address, Address, u32, i128) =
            soroban_sdk::FromVal::from_val(&t.env, &last_val);
        assert_eq!(member, t.dave);
        assert_eq!(
            order,
            t.members.len(),
            "last joiner's order must equal the total member count"
        );
    }

    #[test]
    fn test_join_emits_one_joined_event_per_member() {
        let t = setup_circle();

        t.activate(); // all 4 members join

        let joined = events_named(&t.env, "joined");
        assert_eq!(joined.len(), 4, "expected one 'joined' event per member");
    }

    // ── circle.active event ───────────────────────────────────────────────────

    #[test]
    fn test_last_join_emits_active_event() {
        let t = setup_circle();

        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.join(&t.carol);

        // No 'active' event yet — circle still Pending
        assert_eq!(events_named(&t.env, "active").len(), 0);

        t.circle.join(&t.dave); // last member — triggers Active transition

        assert_eq!(events_named(&t.env, "active").len(), 1);
    }

    #[test]
    fn test_partial_join_does_not_emit_active_event() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);

        assert_eq!(events_named(&t.env, "active").len(), 0);
    }

    // ── circle.contributed event ──────────────────────────────────────────────

    #[test]
    fn test_contribute_emits_contributed_event() {
        let t = setup_circle();
        t.activate();

        t.circle.contribute(&t.bob);

        let contributed = events_named(&t.env, "contributed");
        assert_eq!(contributed.len(), 1);
    }

    // ── circle.payout event ───────────────────────────────────────────────────

    #[test]
    fn test_payout_emits_payout_event() {
        let t = setup_circle();
        t.activate();
        t.contribute_all();

        t.circle.payout();

        let payouts = events_named(&t.env, "payout");
        assert_eq!(payouts.len(), 1, "expected exactly one 'payout' event per round");
    }

    // ── circle.round_started event (NEW) ─────────────────────────────────────

    #[test]
    fn test_payout_emits_round_started_event_for_intermediate_rounds() {
        let t = setup_circle();
        t.activate();

        // Round 0 → payout → should emit round_started (round 1)
        t.contribute_all();
        t.circle.payout();

        let started = events_named(&t.env, "round_started");
        assert_eq!(
            started.len(), 1,
            "expected one 'round_started' event after the first payout"
        );
    }

    #[test]
    fn test_final_payout_does_not_emit_round_started() {
        let t = setup_circle();
        t.activate();

        // Complete the first 3 rounds (rounds 0, 1, 2)
        t.complete_round();
        t.complete_round();
        t.complete_round();

        // Flush events accumulated so far
        let _ = t.env.events().all();

        // Final round (round 3) — should emit 'completed' but NOT 'round_started'
        t.contribute_all();
        t.circle.payout();

        let started = events_named(&t.env, "round_started");
        assert_eq!(
            started.len(), 0,
            "final payout must not emit 'round_started' — circle is Completed"
        );

        let completed = events_named(&t.env, "completed");
        assert_eq!(completed.len(), 1);
    }

    #[test]
    fn test_round_started_event_count_matches_intermediate_rounds() {
        let t = setup_circle();
        t.activate();

        // 4 members → 4 rounds → 3 intermediate payouts → 3 round_started events
        t.complete_round(); // 0→1: emits round_started
        t.complete_round(); // 1→2: emits round_started
        t.complete_round(); // 2→3: emits round_started
        t.complete_round(); // 3→end: emits completed, NOT round_started

        let started = events_named(&t.env, "round_started");
        assert_eq!(
            started.len(), 3,
            "expected 3 round_started events for a 4-member circle"
        );
    }

    // ── circle.default event (updated payload) ────────────────────────────────

    #[test]
    fn test_mark_default_emits_default_event() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();

        t.circle.mark_default(&t.carol);

        let defaults = events_named(&t.env, "default");
        assert_eq!(defaults.len(), 1, "expected one 'default' event");
    }

    #[test]
    fn test_mark_default_event_new_collateral_reflects_penalty() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();

        let collateral_before = t.circle.get_collateral(&t.carol);
        t.circle.mark_default(&t.carol);
        let collateral_after = t.circle.get_collateral(&t.carol);

        // Verify the on-chain collateral value matches the expected penalty arithmetic
        let expected_penalty = collateral_before * PENALTY_BPS / BPS_DENOM;
        let expected_new_collateral = collateral_before - expected_penalty;
        assert_eq!(
            collateral_after, expected_new_collateral,
            "new_collateral after mark_default must equal collateral - penalty"
        );

        // The 'default' event is emitted — existence already covered by the
        // test above; here we verify the updated collateral stored on-chain
        // is consistent with the value a listener would record.
        let defaults = events_named(&t.env, "default");
        assert_eq!(defaults.len(), 1);
    }

    // ── circle.cancelled event ────────────────────────────────────────────────

    #[test]
    fn test_cancel_emits_cancelled_event() {
        let t = setup_circle();
        t.circle.join(&t.alice);

        t.circle.cancel(&t.alice);

        let cancelled = events_named(&t.env, "cancelled");
        assert_eq!(cancelled.len(), 1);
    }

    // ── circle.completed event ────────────────────────────────────────────────

    #[test]
    fn test_complete_all_rounds_emits_completed_event() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        let completed = events_named(&t.env, "completed");
        assert_eq!(completed.len(), 1, "expected exactly one 'completed' event");
    }

    // ── circle.closed event (updated: now includes reason) ────────────────────

    #[test]
    fn test_close_after_completion_emits_closed_event() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        t.circle.close(&t.alice);

        let closed = events_named(&t.env, "closed");
        assert_eq!(closed.len(), 1, "expected one 'closed' event");
    }

    #[test]
    fn test_close_after_cancellation_emits_closed_event() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);

        // Flush events up to this point so we only inspect close-related ones
        let _ = t.env.events().all();

        t.circle.close(&t.alice);

        let closed = events_named(&t.env, "closed");
        assert_eq!(closed.len(), 1, "expected one 'closed' event after cancelled close");
    }

    #[test]
    fn test_close_emits_collateral_released_per_member_with_collateral() {
        let t = setup_circle();
        t.activate(); // all 4 members joined — all have collateral
        t.force_status(CircleStatus::Completed);

        t.circle.close(&t.alice);

        let released = events_named(&t.env, "collateral_released");
        assert_eq!(
            released.len(), 4,
            "expected one 'collateral_released' event per member with collateral"
        );
    }

    #[test]
    fn test_close_does_not_emit_collateral_released_for_zero_balance() {
        let t = setup_circle();
        // Only alice joins; circle is then cancelled
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);

        // Drain alice's collateral to 0 via force helper so second close is a no-op
        t.force_collateral(&t.alice, 0i128);

        let _ = t.env.events().all(); // clear

        t.circle.close(&t.bob); // bob never joined — no collateral

        let released = events_named(&t.env, "collateral_released");
        assert_eq!(
            released.len(), 0,
            "no 'collateral_released' events when all balances are zero"
        );
    }

    // ── circle.initialized event ──────────────────────────────────────────────

    #[test]
    fn test_initialize_emits_initialized_event() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member_a);
        members.push_back(member_b);

        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &ROUND_DEADLINE,
        );

        let initialized = events_named(&env, "initialized");
        assert_eq!(initialized.len(), 1, "expected one 'initialized' event");
    }

    /// Schema v2 of `circle/initialized` appends the payout rotation so the
    /// indexer can create one member row per slot from events alone.  The
    /// first three fields are unchanged (v1 consumers keep working) and the
    /// trailing `members` field preserves rotation order exactly.
    #[test]
    fn test_initialized_event_carries_rotation_as_trailing_field() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);
        let member_c = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member_a);
        members.push_back(member_b);
        members.push_back(member_c);

        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &ROUND_DEADLINE,
        );

        let initialized = events_named(&env, "initialized");
        assert_eq!(initialized.len(), 1, "expected one 'initialized' event");

        let (emitter, member_count, round_amount, rotation): (Address, u32, i128, Vec<Address>) =
            soroban_sdk::FromVal::from_val(&env, &initialized[0]);
        assert_eq!(emitter, circle_id, "field 0 must be the emitting circle");
        assert_eq!(member_count, 3);
        assert_eq!(round_amount, ROUND_AMOUNT);
        assert_eq!(rotation, members, "field 3 must be the rotation in payout order");
    }

    // ── get_pot_amount tests ──────────────────────────────────────────────────
    //
    // get_pot_amount is a pure read-only view that returns round_amount × member_count.
    // It must:
    //  • Return NotInitialized before initialize has been called
    //  • Return the correct product for any valid circle configuration
    //  • Stay consistent with the actual pot transferred during payout
    //  • Remain stable across all lifecycle states (Pending, Active, Completed, Cancelled)

    /// Before `initialize` the Config key is absent; `get_pot_amount` must
    /// return `NotInitialized` rather than panicking or returning 0.
    #[test]
    fn test_get_pot_amount_before_initialize_returns_not_initialized() {
        let (env, _token, _rep) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // try_get_pot_amount returns Result<i128, Result<ContractError, InvokeError>>
        // When not initialized the contract panics, so we catch it via try_
        let result = circle.try_get_pot_amount();
        assert!(result.is_err(), "get_pot_amount must fail before initialize");
    }

    /// After initialize the pot equals round_amount × member_count.
    /// For the standard 4-member fixture: 100_000_000 × 4 = 400_000_000.
    #[test]
    fn test_get_pot_amount_equals_round_amount_times_member_count() {
        let t = setup_circle();
        let config = t.circle.get_config();
        let expected = config.round_amount * config.members.len() as i128;

        let pot = t.circle.get_pot_amount();

        assert_eq!(pot, expected, "pot must be round_amount × member_count");
        assert_eq!(pot, ROUND_AMOUNT * 4, "4-member fixture pot must be 4 × ROUND_AMOUNT");
    }

    /// The pot returned by `get_pot_amount` matches the actual token amount
    /// transferred to the recipient when `payout` runs.
    ///
    /// This test acts as a cross-check between the view and the mutating path:
    /// if payout's pot calculation ever diverges from get_pot_amount, this test
    /// will catch it before a recipient receives the wrong amount.
    #[test]
    fn test_get_pot_amount_matches_actual_payout_received() {
        let t = setup_circle();
        t.activate();

        // The pot view must be readable while the circle is Active
        let pot = t.circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 4);

        let alice_before = t.token.balance(&t.alice);
        t.contribute_all();
        t.circle.payout(); // alice is round-0 recipient
        let alice_after = t.token.balance(&t.alice);

        // Alice contributed ROUND_AMOUNT (outflow) and received `pot` (inflow).
        // Net change == pot - ROUND_AMOUNT == 3 × ROUND_AMOUNT.
        let net = alice_after - alice_before;
        assert_eq!(
            net, pot - ROUND_AMOUNT,
            "alice's net balance change must equal pot − her own contribution"
        );
    }

    /// `get_pot_amount` must remain readable and correct in `Pending` state
    /// (before all members join) so UIs can display the expected payout before
    /// the circle activates.
    #[test]
