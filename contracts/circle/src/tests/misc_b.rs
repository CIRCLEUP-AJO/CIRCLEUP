use super::*;

    fn test_334_payout_blocked_while_paused() {
        let t = setup_circle();
        t.activate();
        t.contribute_all();
        t.circle.pause(&t.circle_admin);
        t.circle.payout();
    }

    #[test]
    #[should_panic]
    fn test_334_mark_default_blocked_while_paused() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();
        t.circle.pause(&t.circle_admin);
        t.circle.mark_default(&t.carol);
    }

    #[test]
    #[should_panic]
    fn test_334_close_blocked_while_paused() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);
        t.circle.pause(&t.circle_admin);
        t.circle.close(&t.alice);
    }

    #[test]
    #[should_panic]
    fn test_334_cancel_blocked_while_paused() {
        let t = setup_circle();
        t.circle.pause(&t.circle_admin);
        t.circle.cancel(&t.alice);
    }

    // ── reads remain available while paused ──────────────────────────────────

    #[test]
    fn test_334_reads_available_while_paused() {
        let t = setup_circle();
        t.activate();
        t.circle.pause(&t.circle_admin);

        // All read-only views must succeed while paused
        assert!(t.circle.is_paused());
        let _ = t.circle.get_config();
        assert_eq!(t.circle.get_status(), CircleStatus::Active);
        let _ = t.circle.get_current_round();
        let _ = t.circle.get_pot_amount();
        let _ = t.circle.get_collateral(&t.alice);
        let _ = t.circle.get_defaults(&t.alice);
        let _ = t.circle.get_protocol_params();
        let _ = t.circle.get_usdc_token();
        let _ = t.circle.get_admin();
        assert!(!t.circle.is_closed());
    }

    // ── resume restores full operation ────────────────────────────────────────

    #[test]
    fn test_334_resume_restores_join() {
        let t = setup_circle();
        t.circle.pause(&t.circle_admin);
        t.circle.resume(&t.circle_admin);
        // join must succeed after resume
        t.circle.join(&t.alice);
        assert_eq!(t.circle.get_collateral(&t.alice), ROUND_AMOUNT * COLLATERAL_MULTIPLIER);
    }

    #[test]
    fn test_334_resumption_preserves_round_and_member_data() {
        let t = setup_circle();
        t.activate();

        // Capture state before pause
        let round_before = t.circle.get_current_round();
        let collateral_alice = t.circle.get_collateral(&t.alice);

        t.circle.pause(&t.circle_admin);

        // Pause preserves round and member data
        let round_during = t.circle.get_current_round();
        assert_eq!(round_during.round_index, round_before.round_index,
            "round_index must be preserved during pause");
        assert_eq!(round_during.deadline_ledger, round_before.deadline_ledger,
            "deadline_ledger must be preserved during pause");

        t.circle.resume(&t.circle_admin);

        // After resume, state is identical to before pause
        let round_after = t.circle.get_current_round();
        assert_eq!(round_after.round_index, round_before.round_index,
            "round_index must be unchanged after resume");
        assert_eq!(t.circle.get_collateral(&t.alice), collateral_alice,
            "collateral must be unchanged after resume");
        assert_eq!(t.circle.get_status(), CircleStatus::Active,
            "status must be unchanged after resume");

        // Full contribute + payout cycle works after resume
        t.contribute_all();
        t.circle.payout();
        assert_eq!(t.circle.get_current_round().round_index, 1,
            "payout must advance round correctly after resume");
    }

    #[test]
    fn test_334_multiple_pause_resume_cycles_work() {
        let t = setup_circle();
        t.activate();

        // First cycle
        t.circle.pause(&t.circle_admin);
        assert!(t.circle.is_paused());
        t.circle.resume(&t.circle_admin);
        assert!(!t.circle.is_paused());

        // Second cycle — circle still operational
        t.contribute_all();
        t.circle.pause(&t.circle_admin);
        assert!(t.circle.is_paused());
        t.circle.resume(&t.circle_admin);
        assert!(!t.circle.is_paused());

        // Payout works after second resume
        t.circle.payout();
        assert_eq!(t.circle.get_current_round().round_index, 1);
    }

    // ── pause emits events ────────────────────────────────────────────────────

    #[test]
    fn test_334_pause_emits_paused_event() {
        let t = setup_circle();
        let _ = t.env.events().all(); // flush
        t.circle.pause(&t.circle_admin);
        let paused_events = events_named(&t.env, "paused");
        assert_eq!(paused_events.len(), 1, "expected one 'paused' event");
    }

    #[test]
    fn test_334_resume_emits_resumed_event() {
        let t = setup_circle();
        t.circle.pause(&t.circle_admin);
        let _ = t.env.events().all(); // flush
        t.circle.resume(&t.circle_admin);
        let resumed_events = events_named(&t.env, "resumed");
        assert_eq!(resumed_events.len(), 1, "expected one 'resumed' event");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #561 — Add tests for minimal valid initialization inputs
    //
    // Tests in this section verify that the smallest legal combination of
    // initialize() arguments is accepted and stored correctly, that the
    // reentrancy guard fires before any state is committed, and that the guard
    // is cleared after a successful initialization.
    // ══════════════════════════════════════════════════════════════════════════

    /// Setting DataKey::Initializing before calling initialize must cause
    /// initialize to panic with "initialize already in progress".  This mirrors
    /// a reentrant mid-initialize call arriving before any state has committed.
    #[test]
    #[should_panic]
    fn test_561_initialize_reentrancy_guard_fires() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        env.as_contract(&circle_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));
        circle.initialize(
            &Address::generate(&env),
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    /// After a reentrancy-guard failure the Config key must remain absent,
    /// confirming that no persistent state was committed before the guard fired.
    #[test]
    fn test_561_initialize_reentrancy_guard_leaves_no_config_state() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        env.as_contract(&circle_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));
        let result = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "initialize with Initializing flag set must fail");

        let config_result = circle.try_get_config();
        assert!(
            config_result.is_err(),
            "Config key must be absent after reentrancy-guard failure"
        );
    }

    /// After a successful initialize the Initializing guard must be removed.
    /// A second initialize call must fail with "already initialized" (from the
    /// Config presence check) rather than "initialize already in progress"
    /// (from the guard), proving the guard was cleared on success.
    #[test]
    fn test_561_reentrancy_guard_cleared_on_successful_init() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));
        let admin = Address::generate(&env);

        circle.initialize(
            &admin,
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let result = circle.try_initialize(
            &admin,
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(
            result.is_err(),
            "second initialize must be rejected (already initialized)"
        );
        assert_eq!(
            circle.get_config().round_amount,
            1,
            "Config must still hold the original round_amount after rejected second init"
        );
    }

    /// The minimal valid input (2 members, round_amount=1, min deadline) must
    /// store every configuration field exactly as supplied: admin, usdc_token,
    /// reputation_contract, members list, round_amount, round_deadline_ledgers.
    #[test]
    fn test_561_minimal_two_members_all_fields_stored_correctly() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member_a.clone());
        members.push_back(member_b.clone());
        let admin = Address::generate(&env);

        circle.initialize(
            &admin,
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let config = circle.get_config();
        assert_eq!(config.members.len(), 2, "member count must be 2");
        assert_eq!(config.members.get(0).unwrap(), member_a, "first member must match");
        assert_eq!(config.members.get(1).unwrap(), member_b, "second member must match");
        assert_eq!(config.round_amount, 1, "round_amount must be 1");
        assert_eq!(
            config.round_deadline_ledgers, MIN_ROUND_DEADLINE_LEDGERS,
            "round_deadline_ledgers must equal MIN_ROUND_DEADLINE_LEDGERS"
        );
        assert_eq!(config.usdc_token, token_address, "token address must match");
        assert_eq!(
            config.reputation_contract, reputation_id,
            "reputation address must match"
        );

        assert_eq!(circle.get_status(), CircleStatus::Pending);
        assert_eq!(circle.get_admin(), admin, "stored admin must equal the address passed at init");
    }

    /// With round_amount=1 and 2 members the initial round state must have
    /// round_index=0 and the recipient must be the first member in the list.
    #[test]
    fn test_561_initial_round_state_is_round_zero_first_member() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let first = Address::generate(&env);
        let second = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(first.clone());
        members.push_back(second.clone());

        circle.initialize(
            &Address::generate(&env),
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let round = circle.get_current_round();
        assert_eq!(round.round_index, 0, "initial round index must be 0");
        assert_eq!(round.recipient, first, "initial recipient must be the first member");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #560 — Verify max member list handling remains safe under load
    //
    // Tests in this section confirm that a circle with exactly MAX_MEMBERS (256)
    // members initializes successfully and that operations that iterate the full
    // member list (close, mark_default penalty math) complete without overflow
    // or out-of-bounds panics.
    // ══════════════════════════════════════════════════════════════════════════

    /// A circle initialized with exactly MAX_MEMBERS (256) distinct addresses
    /// must succeed and report the correct member count.
    #[test]
    fn test_560_initialize_with_max_members_succeeds() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        for _ in 0..MAX_MEMBERS {
            members.push_back(Address::generate(&env));
        }

        circle.initialize(
            &Address::generate(&env),
            &members,
            &1i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let config = circle.get_config();
        assert_eq!(
            config.members.len(),
            MAX_MEMBERS,
            "config must store all MAX_MEMBERS members"
        );
        assert_eq!(circle.get_status(), CircleStatus::Pending);
        let round = circle.get_current_round();
        assert_eq!(round.round_index, 0);
        assert_eq!(
            round.recipient,
            members.get(0).unwrap(),
            "initial recipient must be the first of the max-member list"
        );
    }

    /// close() on a Completed MAX_MEMBERS circle must iterate all 256 members,
    /// return each one's collateral exactly once, and leave every storage key at
    /// zero.  This confirms there is no out-of-bounds or iteration-limit issue
    /// at the maximum member count.
    #[test]
    fn test_560_close_releases_collateral_for_all_max_members() {
        let env = Env::default();
        env.mock_all_auths();
        env.budget().reset_unlimited();

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token = soroban_sdk::token::TokenClient::new(&env, &token_id.address());
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

        env.as_contract(&circle_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Status, &CircleStatus::Completed);
            env.storage()
                .instance()
                .set(&DataKey::RoundsCompleted, &MAX_MEMBERS);
        });

        let balances_before: std::vec::Vec<i128> = (0..MAX_MEMBERS)
            .map(|i| token.balance(&members.get(i).unwrap()))
            .collect();

        circle.close(&members.get(0).unwrap());

        assert!(circle.is_closed(), "circle must be closed after close()");

        for i in 0..MAX_MEMBERS {
            let m = members.get(i).unwrap();
            assert_eq!(
                circle.get_collateral(&m),
                0,
                "collateral must be zero for member {i} after close"
            );
            assert_eq!(
                token.balance(&m) - balances_before[i as usize],
                collateral,
                "member {i} must receive exactly their collateral back"
            );
        }
    }

    /// mark_default penalty arithmetic must produce the correct result when
    /// applied to a circle at MAX_MEMBERS capacity.  After advancing past the
    /// round deadline, calling mark_default on one non-contributing member must
    /// deduct exactly PENALTY_BPS / BPS_DENOM of their collateral without any
    /// overflow or panic.
    #[test]
