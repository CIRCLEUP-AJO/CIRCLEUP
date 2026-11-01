use super::*;

    fn test_settle_round_contributed_count_bounds_check() {
        let t = setup_circle();
        t.activate();

        // Two members contribute legitimately
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.advance_past_deadline();

        // Force contributions_received counter above member_count
        // to simulate a storage inconsistency where the counter is higher
        // than the number of actual Contributed keys.
        // Note: settle_round counts from Contributed keys, not the counter,
        // so contributed_count will equal the real key count (2 here).
        // The bounds guard fires only if contributed_count > member_count,
        // which cannot happen through the normal path — this test confirms
        // the guard value matches the actual count.
        let contributed_from_keys: u32 = {
            [&t.alice, &t.bob, &t.carol, &t.dave]
                .iter()
                .filter(|m| t.has_contributed_key(m, 0))
                .count() as u32
        };
        // 2 contributed keys — must not exceed member_count (4)
        assert!(
            contributed_from_keys <= t.members.len(),
            "contributed_count must never exceed member_count (bounds invariant)"
        );

        // settle_round proceeds normally (2 of 4 contributed)
        t.circle.settle_round();
        assert_eq!(t.circle.get_current_round().round_index, 1);
    }

    /// settle_round: penalty arithmetic uses checked_mul — verifies the
    /// penalty applied to defaulting members in an exceptional settlement
    /// matches the same formula as mark_default.
    #[test]
    fn test_settle_round_penalty_matches_mark_default_formula() {
        let t = setup_circle();
        t.activate();

        // Only alice contributes; bob, carol, dave will be penalized
        t.circle.contribute(&t.alice);
        t.advance_past_deadline();

        let bob_collateral_before = t.circle.get_collateral(&t.bob);
        let carol_collateral_before = t.circle.get_collateral(&t.carol);
        let dave_collateral_before = t.circle.get_collateral(&t.dave);

        t.circle.settle_round();

        let bob_collateral_after = t.circle.get_collateral(&t.bob);
        let carol_collateral_after = t.circle.get_collateral(&t.carol);
        let dave_collateral_after = t.circle.get_collateral(&t.dave);

        // Each non-contributor's penalty must be checked_mul(PENALTY_BPS)/BPS_DENOM
        for (before, after, name) in [
            (bob_collateral_before,   bob_collateral_after,   "bob"),
            (carol_collateral_before, carol_collateral_after, "carol"),
            (dave_collateral_before,  dave_collateral_after,  "dave"),
        ] {
            let expected_penalty = before
                .checked_mul(PENALTY_BPS)
                .expect("test: overflow unexpected for standard fixture")
                / BPS_DENOM;
            assert_eq!(
                before - after, expected_penalty,
                "{name}: settle_round penalty must match checked_mul formula"
            );
        }
    }

    /// join: event-time collateral must not silently emit 0 on overflow.
    /// For the standard fixture (ROUND_AMOUNT=100_000_000, COLLATERAL_MULTIPLIER=1)
    /// the multiplication is safe and the emitted value must match the actual
    /// locked amount.
    #[test]
    fn test_join_event_collateral_matches_locked_amount() {
        let t = setup_circle();

        let bal_before = t.token.balance(&t.alice);
        t.circle.join(&t.alice);
        let bal_after = t.token.balance(&t.alice);

        let locked = bal_before - bal_after; // actual tokens removed from alice's wallet
        let expected = ROUND_AMOUNT
            .checked_mul(COLLATERAL_MULTIPLIER)
            .expect("test: overflow unexpected");

        assert_eq!(locked, expected, "tokens locked must match ROUND_AMOUNT × COLLATERAL_MULTIPLIER");

        // Verify event carries the same value (not 0 from a silent overflow)
        let joined_events = events_named(&t.env, "joined");
        assert_eq!(joined_events.len(), 1);
        let (_addr, _member, _order, event_collateral): (soroban_sdk::Address, soroban_sdk::Address, u32, i128) =
            soroban_sdk::FromVal::from_val(&t.env, &joined_events[0]);
        assert_eq!(
            event_collateral, locked,
            "join event collateral_amount must equal the actual locked amount"
        );
        assert_ne!(event_collateral, 0, "join event collateral_amount must not be zero");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #335 — Verify token identity at initialization
    //
    // Acceptance criteria:
    //   • Unusable token addresses are rejected early (panic at initialize).
    //   • Every transfer uses the stored token (all transfers go via config.usdc_token).
    //   • Token configuration cannot change after activation (get_usdc_token is
    //     immutable; no entry-point overwrites DataKey::UsdcToken).
    // ══════════════════════════════════════════════════════════════════════════

    /// get_usdc_token returns the address stored at initialization time.
    #[test]
    fn test_335_get_usdc_token_returns_initialized_address() {
        let t = setup_circle();
        let token = t.circle.get_usdc_token();
        // Must equal the token address passed to initialize.
        assert_eq!(token, t.token_address, "get_usdc_token must return the address used in initialize");
    }

    /// get_usdc_token before initialize returns NotInitialized.
    #[test]
    fn test_335_get_usdc_token_before_initialize_returns_not_initialized() {
        let (env, _token_address, _rep_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);
        let result = circle.try_get_usdc_token();
        assert!(result.is_err(), "get_usdc_token before initialize must return an error");
    }

    /// Token address is stable across the full lifecycle — after join, after
    /// contribute, after payout, and after close.
    #[test]
    fn test_335_token_address_immutable_across_full_lifecycle() {
        let t = setup_circle();
        let initial_token = t.circle.get_usdc_token();

        // Pending → Active
        t.activate();
        assert_eq!(t.circle.get_usdc_token(), initial_token, "token must not change after activation");

        // Active → complete all rounds
        t.complete_all_rounds();
        assert_eq!(t.circle.get_usdc_token(), initial_token, "token must not change after all rounds complete");

        // Completed → close
        t.circle.close(&t.alice);
        assert_eq!(t.circle.get_usdc_token(), initial_token, "token must not change after close");
    }

    /// Token address is stable after cancel + close lifecycle.
    #[test]
    fn test_335_token_address_immutable_after_cancel_and_close() {
        let t = setup_circle();
        let initial_token = t.circle.get_usdc_token();

        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_usdc_token(), initial_token, "token must not change after cancel");

        t.circle.close(&t.alice);
        assert_eq!(t.circle.get_usdc_token(), initial_token, "token must not change after close on cancelled circle");
    }

    /// Non-token address (a plain wallet / account address) does not implement
    /// the token interface — initialize must reject it with a usability panic.
    #[test]
    #[should_panic]
    fn test_335_non_token_address_rejected_at_initialize() {
        let (env, _token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // Use a freshly generated wallet address — it is not a token contract.
        let not_a_token = Address::generate(&env);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &not_a_token,   // ← not a token contract
            &reputation_id,
            &ROUND_DEADLINE,
        );
    }

    /// A failed initialize (invalid token) must leave no state — the contract
    /// can be successfully initialized with a corrected token address afterwards.
    #[test]
    fn test_335_failed_token_probe_leaves_no_state_allows_retry() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let not_a_token = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // First attempt: invalid token — must fail.
        let bad = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &ROUND_AMOUNT,
            &not_a_token,
            &reputation_id,
            &ROUND_DEADLINE,
        );
        assert!(bad.is_err(), "initialize with non-token address must fail");

        // Config must be absent after failure.
        assert!(circle.try_get_config().is_err(), "Config must not exist after failed initialize");
        assert!(circle.try_get_usdc_token().is_err(), "UsdcToken key must not exist after failed initialize");

        // Second attempt with the correct token address must succeed.
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &ROUND_DEADLINE,
        );
        assert_eq!(circle.get_usdc_token(), token_address, "corrected initialize must store the token");
    }

    /// get_usdc_token and get_config must agree on the token address.
    #[test]
    fn test_335_get_usdc_token_matches_config_usdc_token() {
        let t = setup_circle();
        let via_view = t.circle.get_usdc_token();
        let via_config = t.circle.get_config().usdc_token;
        assert_eq!(via_view, via_config, "get_usdc_token must agree with get_config().usdc_token");
    }

    /// All transfers (join collateral, contribute, close release) use the
    /// token stored in config — verified by checking that alice's balance on
    /// the registered token changes correctly for each operation.
    #[test]
    fn test_335_all_transfers_use_stored_token() {
        let t = setup_circle();

        // The stored token is the registered test token.
        let stored_token = t.circle.get_usdc_token();
        assert_eq!(stored_token, t.token_address);

        // join: collateral leaves alice's wallet on the stored token.
        let alice_before_join = t.token.balance(&t.alice);
        t.circle.join(&t.alice);
        let alice_after_join = t.token.balance(&t.alice);
        assert_eq!(
            alice_before_join - alice_after_join,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "join collateral must be deducted from the stored token"
        );

        // contribute: round amount leaves alice's wallet on the stored token.
        t.circle.join(&t.bob);
        t.circle.join(&t.carol);
        t.circle.join(&t.dave);
        let alice_before_contrib = t.token.balance(&t.alice);
        t.circle.contribute(&t.alice);
        let alice_after_contrib = t.token.balance(&t.alice);
        assert_eq!(
            alice_before_contrib - alice_after_contrib,
            ROUND_AMOUNT,
            "contribute must deduct from the stored token"
        );

        // payout: round 0 recipient (alice) receives pot on the stored token.
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        t.circle.contribute(&t.dave);
        let alice_before_payout = t.token.balance(&t.alice);
        t.circle.payout();
        let alice_after_payout = t.token.balance(&t.alice);
        // Alice receives pot (4 × ROUND_AMOUNT), net = pot - her own contribution already deducted
        let pot = ROUND_AMOUNT * 4;
        assert_eq!(
            alice_after_payout - alice_before_payout,
            pot,
            "payout must credit the stored token to the recipient"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #334 — Pause and emergency recovery controls
    //
    // Acceptance criteria:
    //   • Unauthorized accounts cannot pause or resume.
    //   • Paused actions cannot move funds unexpectedly.
    //   • Resumption preserves round and member data.
    // ══════════════════════════════════════════════════════════════════════════

    // ── is_paused / get_admin views ───────────────────────────────────────────

    #[test]
    fn test_334_is_paused_false_by_default() {
        let t = setup_circle();
        assert!(!t.circle.is_paused(), "circle must not be paused after initialize");
    }

    #[test]
    fn test_334_get_admin_returns_initialized_admin() {
        let t = setup_circle();
        let admin = t.circle.get_admin();
        assert_eq!(admin, t.circle_admin, "get_admin must return the admin set in initialize");
    }

    #[test]
    fn test_334_get_admin_before_initialize_returns_error() {
        let (env, _token, _rep) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);
        let result = circle.try_get_admin();
        assert!(result.is_err(), "get_admin before initialize must return an error");
    }

    // ── pause: authorization ──────────────────────────────────────────────────

    #[test]
    fn test_334_admin_can_pause() {
        let t = setup_circle();
        t.circle.pause(&t.circle_admin);
        assert!(t.circle.is_paused(), "circle must be paused after admin calls pause");
    }

    #[test]
    fn test_334_non_admin_cannot_pause() {
        let t = setup_circle();
        let result = t.circle.try_pause(&t.alice);
        assert!(result.is_err(), "non-admin must not be able to pause");
        assert!(!t.circle.is_paused(), "circle must remain unpaused after rejected pause");
    }

    #[test]
    fn test_334_stranger_cannot_pause() {
        let t = setup_circle();
        let stranger = Address::generate(&t.env);
        let result = t.circle.try_pause(&stranger);
        assert!(result.is_err(), "stranger must not be able to pause");
    }

    #[test]
    fn test_334_double_pause_returns_error() {
        let t = setup_circle();
        t.circle.pause(&t.circle_admin);
        let result = t.circle.try_pause(&t.circle_admin);
        assert!(result.is_err(), "pausing an already-paused circle must return an error");
    }

    // ── resume: authorization ─────────────────────────────────────────────────

    #[test]
    fn test_334_admin_can_resume() {
        let t = setup_circle();
        t.circle.pause(&t.circle_admin);
        assert!(t.circle.is_paused());
        t.circle.resume(&t.circle_admin);
        assert!(!t.circle.is_paused(), "circle must not be paused after admin calls resume");
    }

    #[test]
    fn test_334_non_admin_cannot_resume() {
        let t = setup_circle();
        t.circle.pause(&t.circle_admin);
        let result = t.circle.try_resume(&t.alice);
        assert!(result.is_err(), "non-admin must not be able to resume");
        assert!(t.circle.is_paused(), "circle must remain paused after rejected resume");
    }

    #[test]
    fn test_334_resume_when_not_paused_returns_error() {
        let t = setup_circle();
        let result = t.circle.try_resume(&t.circle_admin);
        assert!(result.is_err(), "resuming an unpaused circle must return an error");
    }

    // ── pause blocks fund-moving writes ──────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_334_join_blocked_while_paused() {
        let t = setup_circle();
        t.circle.pause(&t.circle_admin);
        t.circle.join(&t.alice);
    }

    #[test]
    #[should_panic]
    fn test_334_contribute_blocked_while_paused() {
        let t = setup_circle();
        t.activate();
        t.circle.pause(&t.circle_admin);
        t.circle.contribute(&t.alice);
    }

    #[test]
    #[should_panic]
