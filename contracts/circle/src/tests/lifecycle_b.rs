use super::*;

    fn test_close_after_completion_returns_collateral() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        let carol_before = t.token.balance(&t.carol);
        t.circle.close(&t.carol);
        assert_eq!(t.token.balance(&t.carol) - carol_before, ROUND_AMOUNT * COLLATERAL_MULTIPLIER);
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        assert_eq!(t.circle.get_collateral(&t.bob), 0);
        assert_eq!(t.circle.get_collateral(&t.carol), 0);
        assert_eq!(t.circle.get_collateral(&t.dave), 0);
    }

    #[test]
    #[should_panic]
    fn test_cancel_active_panics() {
        let t = setup_circle();
        t.activate();
        t.circle.cancel(&t.alice);
    }

    #[test]
    #[should_panic]
    fn test_cancel_by_non_member_panics() {
        let t = setup_circle();
        let outsider = Address::generate(&t.env);
        t.circle.cancel(&outsider);
    }


    // ── round_deadline_ledgers bounds tests ───────────────────────────────────

    #[test]
    fn test_initialize_deadline_below_minimum_returns_typed_error() {
        let t = setup_circle();
        let circle_id = t.env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&t.env, &circle_id);
        let result = circle.try_initialize(
            &t.circle_admin,
            &t.members,
            &ROUND_AMOUNT,
            &t.token_address,
            &t.reputation_id,
            &(MIN_ROUND_DEADLINE_LEDGERS - 1),
        );
        let Err(Ok(sdk_err)) = result else {
            panic!("expected contract error, got success or invoke error");
        };
        assert_eq!(
            InitError::try_from(sdk_err).expect("must be a typed InitError"),
            InitError::DeadlineBelowMinimum,
            "deadline below minimum must return InitError::DeadlineBelowMinimum"
        );
    }

    #[test]
    fn test_initialize_deadline_above_maximum_returns_typed_error() {
        let t = setup_circle();
        let circle_id = t.env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&t.env, &circle_id);
        let result = circle.try_initialize(
            &t.circle_admin,
            &t.members,
            &ROUND_AMOUNT,
            &t.token_address,
            &t.reputation_id,
            &(MAX_ROUND_DEADLINE_LEDGERS + 1),
        );
        let Err(Ok(sdk_err)) = result else {
            panic!("expected contract error, got success or invoke error");
        };
        assert_eq!(
            InitError::try_from(sdk_err).expect("must be a typed InitError"),
            InitError::DeadlineAboveMaximum,
            "deadline above maximum must return InitError::DeadlineAboveMaximum"
        );
    }

    #[test]
    fn test_initialize_deadline_at_bounds_succeeds() {
        let t = setup_circle();

        let circle_lo = t.env.register_contract(None, CircleContract);
        let client_lo = CircleContractClient::new(&t.env, &circle_lo);
        client_lo.initialize(
            &Address::generate(&t.env),
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
            &Address::generate(&t.env),
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

    #[test]
    fn test_initialize_accepts_minimal_valid_input() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member_a.clone());
        members.push_back(member_b.clone());

        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        // get_config returns Result<CircleConfig, ContractError> — must unwrap
        let config = circle.get_config();
        assert_eq!(config.members.len(), 2);
        assert_eq!(config.round_amount, 1);
        assert_eq!(circle.get_status(), CircleStatus::Pending);

        // get_current_round returns RoundState directly (panics on error)
        let round = circle.get_current_round();
        assert_eq!(round.round_index, 0);
        assert_eq!(round.recipient, member_a);
    }

    #[test]
    #[should_panic]
    fn test_initialize_rejects_member_count_above_maximum() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        let mut i: u32 = 0;
        while i <= MAX_MEMBERS {
            members.push_back(Address::generate(&env));
            i += 1;
        }

        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &ROUND_DEADLINE,
        );
    }


    // ── complete_round / complete_all_rounds helper tests ─────────────────────

    #[test]
    fn test_complete_round_helper_returns_round_index() {
        let t = setup_circle();
        t.activate();
        let idx = t.complete_round();
        assert_eq!(idx, 0);
        // After one completed round, the circle is on round 1
        let current = t.circle.get_current_round();
        assert_eq!(current.round_index, 1);
    }

    #[test]
    fn test_complete_all_rounds_helper_reaches_completed_status() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);
    }

    #[test]
    fn test_complete_all_rounds_helper_pays_each_member_once() {
        let t = setup_circle();
        t.activate();

        // Record balances before any round starts (after collateral lock)
        let alice_start = t.token.balance(&t.alice);
        let bob_start = t.token.balance(&t.bob);
        let carol_start = t.token.balance(&t.carol);
        let dave_start = t.token.balance(&t.dave);

        t.complete_all_rounds();

        // Over 4 rounds each member contributes 3 ROUND_AMOUNT net
        // (contributes 4×, receives pot 1×, pot = 4 × ROUND_AMOUNT).
        // Net per member = −4 contributions + 1 pot = 0 (break-even ignoring collateral).
        // Collateral is still locked at this point (close not called yet).
        let members = [
            (&t.alice, alice_start),
            (&t.bob, bob_start),
            (&t.carol, carol_start),
            (&t.dave, dave_start),
        ];
        for (m, start) in members {
            let end = t.token.balance(m);
            // Each member receives exactly 0 net change from contributions +
            // payout (they put in 4 × ROUND_AMOUNT over 4 rounds and receive
            // 4 × ROUND_AMOUNT in the round they are recipient).
            assert_eq!(end, start, "member balance should be unchanged across all rounds");
        }
    }

    // ── mark_default: deadline boundary at exactly deadline_ledger ────────────

    #[test]
    #[should_panic]
    fn test_mark_default_at_exact_deadline_panics() {
        // The contract uses `sequence > deadline_ledger` (strict greater than),
        // so calling at exactly deadline_ledger must still be rejected.
        let t = setup_circle();
        t.activate();

        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32;
        });

        t.circle.mark_default(&t.carol);
    }

    #[test]
    fn test_mark_default_at_deadline_plus_one_succeeds() {
        let t = setup_circle();
        t.activate();

        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });

        t.circle.mark_default(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);
    }

    // ── get_protocol_params tests ─────────────────────────────────────────────

    /// Verify that get_protocol_params returns a struct whose fields exactly
    /// match the compile-time constants in lib.rs.  If a constant is changed
    /// the test catches any divergence between the constant and the view.
    #[test]
    fn test_get_protocol_params_matches_constants() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // get_protocol_params works even before initialize (no storage reads)
        let params = circle.get_protocol_params();

        assert_eq!(params.penalty_bps, PENALTY_BPS);
        assert_eq!(params.bps_denom, BPS_DENOM);
        assert_eq!(params.collateral_multiplier, COLLATERAL_MULTIPLIER);
        assert_eq!(params.min_round_deadline_ledgers, MIN_ROUND_DEADLINE_LEDGERS);
        assert_eq!(params.max_round_deadline_ledgers, MAX_ROUND_DEADLINE_LEDGERS);
        assert_eq!(params.max_members, MAX_MEMBERS);

        // Suppress unused-variable warning by noting that token/rep were needed
        // to construct a proper env for contract registration.
        let _ = token_address;
        let _ = reputation_id;
    }

    /// Verify the penalty arithmetic used in mark_default is consistent with
    /// the ProtocolParams values returned by get_protocol_params.
    ///
    /// This test acts as a regression guard: if PENALTY_BPS is changed the
    /// on-chain penalty deduction and this calculation must both be updated.
    #[test]
    fn test_penalty_math_matches_protocol_params() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();

        let params = t.circle.get_protocol_params();

        let collateral_before = t.circle.get_collateral(&t.dave);
        t.circle.mark_default(&t.dave);
        let collateral_after = t.circle.get_collateral(&t.dave);

        // Penalty must equal exactly: collateral × penalty_bps / bps_denom
        let expected_penalty = collateral_before * params.penalty_bps / params.bps_denom;
        assert_eq!(
            collateral_before - collateral_after,
            expected_penalty,
            "on-chain penalty deduction must match protocol_params calculation"
        );
    }

    /// Verify that the collateral locked by join equals
    /// collateral_multiplier × round_amount as advertised by get_protocol_params.
    #[test]
    fn test_collateral_locked_matches_protocol_params() {
        let t = setup_circle();
        let params = t.circle.get_protocol_params();

        let bal_before = t.token.balance(&t.bob);
        t.circle.join(&t.bob);
        let bal_after = t.token.balance(&t.bob);

        let expected_collateral = ROUND_AMOUNT * params.collateral_multiplier;
        assert_eq!(
            bal_before - bal_after,
            expected_collateral,
            "collateral locked must equal collateral_multiplier × round_amount"
        );
        assert_eq!(t.circle.get_collateral(&t.bob), expected_collateral);
    }

    // ── Event emission tests ──────────────────────────────────────────────────
    //
    // Soroban's test env records every published event.  We use
    // `env.events().all()` to verify that the correct events are emitted with
    // the right topics and data payloads.
    //
    // Return type of events().all():
    //   Vec<(Address, Vec<Val>, Val)>
    //     [0] contract_id  — the Address of the emitting contract
    //     [1] topics       — Vec<Val>, e.g. [Symbol("circle"), Symbol("joined")]
    //     [2] data         — Val, the value passed as the second arg to publish
    //
    // These tests act as a contract-level API guarantee: if an event is
    // renamed or its payload shape changes, the test will catch the regression
    // before the indexer or front-end breaks.

    /// Collect the data payloads of all events whose second topic symbol
    /// matches `name`.  Returns a plain Rust Vec so test assertions can use
    /// `.len()` without any Soroban SDK conversions.
    fn events_named(env: &Env, name: &str) -> std::vec::Vec<soroban_sdk::Val> {
        let target = soroban_sdk::Symbol::new(env, name);
        let target_val: soroban_sdk::Val =
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&target, env);
        let target_bits = soroban_sdk::Val::get_payload(target_val);
        env.events()
            .all()
            .into_iter()
            .filter(|(_contract, topics, _data)| {
                // topics is Vec<Val>; index 1 is the event-name symbol
                topics
                    .get(1)
                    .map(|v| soroban_sdk::Val::get_payload(v) == target_bits)
                    .unwrap_or(false)
            })
            .map(|(_contract, _topics, data)| data)
            .collect()
    }

    // ── circle.joined event ───────────────────────────────────────────────────
    //
    // The `joined` event data is `(circle_address, member, join_order,
    // collateral_amount)`.  `join_order` is the member's 1-based position in
    // the join queue (1 = first to join, N = last / activating join).
    // These tests act as a contract-level API guarantee for the event shape.

    #[test]
    fn test_join_emits_joined_event_with_member_and_order() {
        let t = setup_circle();
        t.env.events().all(); // consume pre-existing events (e.g. "initialized")

        t.circle.join(&t.alice);

        let joined = events_named(&t.env, "joined");
        assert_eq!(joined.len(), 1, "expected exactly one 'joined' event");

        // The data payload is `(circle_address, member, join_order, collateral)`.
        // Decode via the tuple IntoVal / FromVal round-trip.
        let data_val = joined[0].clone();
        let (_circle, member, order, _collateral): (Address, Address, u32, i128) =
            soroban_sdk::FromVal::from_val(&t.env, &data_val);
        assert_eq!(member, t.alice, "event member must be the joining address");
        assert_eq!(order, 1u32, "alice is the first to join — order must be 1");
    }

    #[test]
    fn test_join_order_increments_per_member() {
        let t = setup_circle();
        // Join all four members one by one and verify order 1..=4.
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.join(&t.carol);
        t.circle.join(&t.dave);

        let joined = events_named(&t.env, "joined");
        assert_eq!(joined.len(), 4, "expected one 'joined' event per member");

        let expected_members = [&t.alice, &t.bob, &t.carol, &t.dave];
        for (i, (val, &expected_member)) in joined.iter().zip(expected_members.iter()).enumerate() {
            let (_circle, member, order, _collateral): (Address, Address, u32, i128) =
                soroban_sdk::FromVal::from_val(&t.env, val);
            assert_eq!(
                member, *expected_member,
                "event[{i}] member mismatch"
            );
            assert_eq!(
                order,
                (i + 1) as u32,
                "event[{i}] order must be 1-based index into join queue"
            );
        }
    }

    #[test]
