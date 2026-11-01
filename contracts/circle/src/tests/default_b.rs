use super::*;

    fn test_179_closed_event_reason_reflects_terminal_state() {
        // Completed case
        {
            let t = setup_circle();
            t.activate();
            t.complete_all_rounds();
            let _ = t.env.events().all();
            t.circle.close(&t.alice);

            let closed = events_named(&t.env, "closed");
            let (_circle, _closer, _released, _expected, reason): (Address, Address, i128, i128, soroban_sdk::Symbol) =
                soroban_sdk::FromVal::from_val(&t.env, &closed[0]);
            assert_eq!(
                reason,
                soroban_sdk::Symbol::new(&t.env, "completed"),
                "closed event reason must be 'completed' for a Completed circle"
            );
        }

        // Cancelled case
        {
            let t = setup_circle();
            t.circle.join(&t.alice);
            t.circle.cancel(&t.alice);
            let _ = t.env.events().all();
            t.circle.close(&t.alice);

            let closed = events_named(&t.env, "closed");
            let (_circle, _closer, _released, _expected, reason): (Address, Address, i128, i128, soroban_sdk::Symbol) =
                soroban_sdk::FromVal::from_val(&t.env, &closed[0]);
            assert_eq!(
                reason,
                soroban_sdk::Symbol::new(&t.env, "cancelled"),
                "closed event reason must be 'cancelled' for a Cancelled circle"
            );
        }
    }

    /// total_expected_collateral in the closed event must equal
    /// member_count × round_amount × COLLATERAL_MULTIPLIER regardless of how
    /// many penalties were applied.  Auditors subtract total_released from
    /// total_expected to compute the total amount forfeited as penalties.
    #[test]
    fn test_179_closed_event_total_expected_is_full_collateral_regardless_of_penalties() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        // Apply penalties to two members so total_released < total_expected
        let penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        t.force_collateral(&t.carol, ROUND_AMOUNT - penalty);
        t.force_collateral(&t.dave,  ROUND_AMOUNT - 2 * penalty); // two-default equivalent

        let _ = t.env.events().all();
        t.circle.close(&t.alice);

        let closed = events_named(&t.env, "closed");
        let (_circle, _closer, total_released, total_expected, _reason): (Address, Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed[0]);

        let full_expected = ROUND_AMOUNT * COLLATERAL_MULTIPLIER * 4; // 4 members
        assert_eq!(
            total_expected, full_expected,
            "total_expected_collateral must equal member_count × round_amount × COLLATERAL_MULTIPLIER"
        );
        // total_released must be less than total_expected because penalties were applied
        assert!(
            total_released < total_expected,
            "total_released must be less than total_expected when penalties were applied"
        );
        // The difference equals the penalties forfeited
        let forfeited = total_expected - total_released;
        assert!(forfeited > 0, "forfeited amount must be positive");
    }

    /// Verify that close() is callable by any circle member, not just the one
    /// who originally joined first or cancelled.  Member identity only gates
    /// the auth check — any listed member may trigger settlement.
    #[test]
    fn test_179_any_member_can_trigger_close() {
        // Dave (last member) triggers close on a Completed circle
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        t.circle.close(&t.dave); // dave, not alice, calls close
        assert!(t.circle.is_closed());
    }

    /// Non-members must be rejected from close() with CloseError::Unauthorized.
    #[test]
    fn test_179_non_member_cannot_close() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        let outsider = Address::generate(&t.env);
        assert_eq!(
            t.circle.try_close(&outsider),
            Err(Ok(CloseError::Unauthorized)),
            "non-member must be rejected with Unauthorized"
        );
    }

    /// Verify that the RoundsCompleted invariant check in close() catches corrupted state.
    #[test]
    fn test_179_close_completed_with_incomplete_rounds_panics() {
        let t = setup_circle();
        t.activate();

        t.env.as_contract(&t.circle_id, || {
            t.env
                .storage()
                .instance()
                .set(&DataKey::Status, &CircleStatus::Completed);
        });

        assert_eq!(
            t.circle.try_close(&t.alice),
            Err(Ok(CloseError::RoundsIncomplete)),
            "close must return RoundsIncomplete for corrupted Completed state"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #322 — Validate circle configuration before initialization
    //
    // These tests cover the new explicit validation guards added to `initialize`
    // as part of issue #322:
    //
    //   • Token address must not be the circle contract itself.
    //   • Reputation contract must not be the circle contract itself.
    //   • Reputation contract must not be the same address as the USDC token.
    //   • Rotation consistency defensive check (members.len() > 0 after all
    //     previous guards, which is guaranteed but asserted for documentation).
    //   • All guards leave NO persistent state on failure.
    //   • All existing valid-configuration tests continue to pass (regression).
    //
    // Acceptance criteria from issue #322:
    //   ✓ Invalid configuration makes no persistent state changes.
    //   ✓ Errors are deterministic and documented.
    //   ✓ Existing valid creation and deployment tests remain green.
    // ══════════════════════════════════════════════════════════════════════════

    // ── Smallest-valid configuration acceptance tests ─────────────────────────

    /// The smallest valid circle: 2 members, 1 stroop, minimum deadline.
    ///
    /// All three address parameters (token, reputation, circle) are distinct.
    /// After initialize the config, status, and current round must be correct.
    #[test]
    fn test_322_smallest_valid_configuration_initializes_correctly() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member_a.clone());
        members.push_back(member_b.clone());

        // Must not panic — all three addresses are distinct and all parameters
        // are at their minimum valid values.
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let config = circle.get_config();
        assert_eq!(config.members.len(), 2);
        assert_eq!(config.round_amount, 1i128);
        assert_eq!(config.round_deadline_ledgers, MIN_ROUND_DEADLINE_LEDGERS);

        assert_eq!(circle.get_status(), CircleStatus::Pending);

        let round = circle.get_current_round();
        assert_eq!(round.round_index, 0);
        assert_eq!(round.recipient, member_a);
    }

    /// Two distinct members with the largest valid round_amount that does not
    /// overflow the pot or penalty calculations.
    #[test]
    fn test_322_max_valid_round_amount_initializes_correctly() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // Largest amount that survives both checked_mul guards:
        //   amount * member_count (2) must not overflow i128
        //   amount * PENALTY_BPS  must not overflow i128
        // The binding constraint is PENALTY_BPS (10_000 > 2).
        let max_amount = i128::MAX / PENALTY_BPS;

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &max_amount,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let config = circle.get_config();
        assert_eq!(config.round_amount, max_amount);
    }

    /// Maximum deadline value initializes without error.
    #[test]
    fn test_322_max_valid_deadline_initializes_correctly() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &MAX_ROUND_DEADLINE_LEDGERS,
        );

        let config = circle.get_config();
        assert_eq!(config.round_deadline_ledgers, MAX_ROUND_DEADLINE_LEDGERS);
    }

    // ── Token address validation ───────────────────────────────────────────────

    /// `initialize` must reject a `usdc_token` that equals the circle contract
    /// address.  A self-referential token would make every USDC transfer a
    /// no-op (the contract cannot transfer tokens to itself as a token mint)
    /// and break the entire financial model.
    ///
    /// Guard message: "usdc_token must not be the circle contract itself"
    #[test]
    #[should_panic]
    fn test_322_usdc_token_equals_circle_address_panics() {
        let (env, _token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // Pass the circle's own address as the USDC token — must be rejected.
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &circle_id,       // ← circle contract used as token address
            &reputation_id,
            &ROUND_DEADLINE,
        );
    }

    /// When `usdc_token == circle_address`, no persistent state must be written.
    /// This confirms the guard fires before any storage mutation.
    #[test]
    fn test_322_usdc_token_equals_circle_leaves_no_state() {
        let (env, _token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // Attempt the invalid initialize — it panics.
        let result = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &ROUND_AMOUNT,
            &circle_id,
            &reputation_id,
            &ROUND_DEADLINE,
        );
        assert!(result.is_err(), "must fail when token == circle address");

        // The Config key must be absent — no state was committed.
        let config_result = circle.try_get_config();
        assert!(
            config_result.is_err(),
            "Config key must not exist after a failed initialize"
        );
    }

    // ── Reputation contract address validation ────────────────────────────────

    /// `initialize` must reject a `reputation_contract` that equals the circle
    /// contract address.  The reputation contract is invoked via a cross-contract
    /// call; if it pointed at the circle itself, `payout` would recurse into
    /// `initialize`-style entry-points and break the authorization model.
    ///
    /// Guard message: "reputation_contract must not be the circle contract itself"
    #[test]
    #[should_panic]
    fn test_322_reputation_contract_equals_circle_address_panics() {
        let (env, token_address, _reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // Pass the circle's own address as the reputation contract — must be rejected.
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &circle_id,       // ← circle contract used as reputation address
            &ROUND_DEADLINE,
        );
    }

    /// When `reputation_contract == circle_address`, no persistent state must be
    /// written — the guard fires before any storage mutation.
    #[test]
    fn test_322_reputation_contract_equals_circle_leaves_no_state() {
        let (env, token_address, _reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let result = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &circle_id,
            &ROUND_DEADLINE,
        );
        assert!(result.is_err(), "must fail when reputation == circle address");

        let config_result = circle.try_get_config();
        assert!(
            config_result.is_err(),
            "Config key must not exist after a failed initialize"
        );
    }

    // ── Reputation ≠ USDC token validation ────────────────────────────────────

    /// `initialize` must reject a configuration where `reputation_contract` and
    /// `usdc_token` point to the same address.  Sharing the two roles on a single
    /// contract is almost certainly a deployment-script error and would break both
    /// the financial model and the authorization invariants.
    ///
    /// Guard message: "reputation_contract must not be the same address as usdc_token"
    #[test]
    #[should_panic]
    fn test_322_reputation_equals_usdc_token_panics() {
        let (env, token_address, _reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // Both reputation and token point at token_address — must be rejected.
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &token_address,   // ← reputation == usdc token
            &ROUND_DEADLINE,
        );
    }

    /// When `reputation_contract == usdc_token`, no persistent state must be
    /// written.
    #[test]
    fn test_322_reputation_equals_usdc_token_leaves_no_state() {
        let (env, token_address, _reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let result = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &token_address,
            &ROUND_DEADLINE,
        );
        assert!(result.is_err(), "must fail when reputation == usdc_token");

        let config_result = circle.try_get_config();
        assert!(
            config_result.is_err(),
            "Config key must not exist after a failed initialize"
        );
    }

    // ── All three addresses must be distinct ──────────────────────────────────

    /// The three address parameters must all be distinct.  The previous tests
    /// cover individual pairs; this test confirms the happy-path where all three
    /// are distinct succeeds without error.
    #[test]
