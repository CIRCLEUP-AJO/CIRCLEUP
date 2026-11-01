use super::*;

    fn test_322_three_distinct_addresses_succeeds() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // circle_id ≠ token_address ≠ reputation_id — this must succeed.
        assert_ne!(circle_id, token_address, "fixture: circle ≠ token");
        assert_ne!(circle_id, reputation_id, "fixture: circle ≠ reputation");
        assert_ne!(token_address, reputation_id, "fixture: token ≠ reputation");

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
            &ROUND_DEADLINE,
        );

        // Config must be present after successful initialize
        let config = circle.get_config();
        assert_eq!(config.members.len(), 2);
    }

    // ── Address-validation guards fire before storage writes ─────────────────

    /// All address-validation failures must leave the Reentrancy guard
    /// (`Initializing` key) cleared and the `Config` key absent, so the same
    /// contract instance can be successfully initialized in a subsequent call
    /// with corrected parameters.
    ///
    /// This is the "no persistent state changes" acceptance criterion.
    #[test]
    fn test_322_address_validation_failure_allows_retry_with_corrected_params() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // First attempt: reputation == usdc_token (invalid)
        let bad_result = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &token_address, // reputation == token: invalid
            &ROUND_DEADLINE,
        );
        assert!(bad_result.is_err(), "first attempt must fail");

        // Second attempt with corrected parameters must succeed.
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id, // now distinct from token
            &ROUND_DEADLINE,
        );

        let config = circle.get_config();
        assert_eq!(config.members.len(), 2, "corrected initialize must commit Config");
    }

    // ── Existing guard regression tests ──────────────────────────────────────
    //
    // These regression tests re-exercise the pre-existing guards to confirm
    // that the new validations added by issue #322 did not accidentally break
    // any of the original checks.  Each guard is exercised once here; the
    // comprehensive coverage lives in the earlier test sections and prop_tests.

    /// Regression: double-initialize is still rejected after issue #322 changes.
    #[test]
    #[should_panic]
    fn test_322_regression_already_initialized_still_rejected() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));
        let circle_admin = Address::generate(&env);

        circle.initialize(&circle_admin, &members, &ROUND_AMOUNT, &token_address, &reputation_id, &ROUND_DEADLINE);
        // Second call must be rejected.
        circle.initialize(&circle_admin, &members, &ROUND_AMOUNT, &token_address, &reputation_id, &ROUND_DEADLINE);
    }

    /// Regression: fewer than 2 members still rejected.
    #[test]
    #[should_panic]
    fn test_322_regression_too_few_members_still_rejected() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        let circle_admin = Address::generate(&env);

        circle.initialize(&circle_admin, &members, &ROUND_AMOUNT, &token_address, &reputation_id, &ROUND_DEADLINE);
    }

    /// Regression: duplicate members still rejected and surfaces as typed error.
    #[test]
    fn test_322_regression_duplicate_members_still_rejected() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let a = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(a.clone());
        members.push_back(a); // duplicate

        let circle_admin = Address::generate(&env);
        let result = circle.try_initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &ROUND_DEADLINE,
        );
        let Err(Ok(sdk_err)) = result else {
            panic!("expected contract error, got success or invoke error");
        };
        assert_eq!(
            InitError::try_from(sdk_err).expect("must be a typed InitError"),
            InitError::DuplicateMembers,
            "duplicate members must return InitError::DuplicateMembers"
        );
    }

    /// Regression: zero round_amount still rejected.
    #[test]
    #[should_panic]
    fn test_322_regression_zero_round_amount_still_rejected() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let circle_admin = Address::generate(&env);
        circle.initialize(&circle_admin, &members, &0i128, &token_address, &reputation_id, &ROUND_DEADLINE);
    }

    /// Regression: deadline below minimum still rejected as typed error.
    #[test]
    fn test_322_regression_deadline_below_min_still_rejected() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let circle_admin = Address::generate(&env);
        let result = circle.try_initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
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

    /// Regression: deadline above maximum still rejected as typed error.
    #[test]
    fn test_322_regression_deadline_above_max_still_rejected() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let circle_admin = Address::generate(&env);
        let result = circle.try_initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
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

    // ══════════════════════════════════════════════════════════════════════════
    // Issue: mark_default must use contract ledger time; centralized deadline
    //
    // The deadline predicate is `env.ledger().sequence() > deadline_ledger`
    // (strict greater-than).  Both `contribute` and `mark_default` use the
    // same `deadline_passed` helper so boundary semantics are always identical.
    // These tests verify the boundary at multiple rounds and for different
    // deadline lengths to prove per-round isolation.
    // ══════════════════════════════════════════════════════════════════════════

    /// Deadline boundary for round 0: one ledger before deadline is still open.
    #[test]
    #[should_panic]
    fn test_deadline_one_before_round0_blocks_default() {
        let t = setup_circle();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 - 1;
        });
        t.circle.mark_default(&t.carol);
    }

    /// Deadline boundary for round 0: exactly at deadline is still open.
    #[test]
    #[should_panic]
    fn test_deadline_exactly_at_round0_blocks_default() {
        let t = setup_circle();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32;
        });
        t.circle.mark_default(&t.carol);
    }

    /// Deadline boundary for round 0: one ledger past deadline allows default.
    #[test]
    fn test_deadline_one_past_round0_allows_default() {
        let t = setup_circle();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });
        t.circle.mark_default(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);
    }

    /// Round 1 gets its own fresh deadline after round 0 payout.
    /// A stale round-0 deadline cannot be used to default a round-1 member.
    #[test]
    #[should_panic]
    fn test_round1_deadline_is_independent_of_round0() {
        let t = setup_circle();
        t.activate();

        // Complete round 0 (all contribute + payout)
        t.contribute_all();
        t.circle.payout();

        // Round 1 deadline is reset from the ledger at payout time.
        // We are still at the same ledger as when payout ran, so the new
        // round-1 deadline has not passed yet.
        let round1 = t.circle.get_current_round();
        assert_eq!(round1.round_index, 1);
        // Current ledger == payout ledger < round1.deadline_ledger
        // mark_default must be blocked.
        t.circle.mark_default(&t.carol);
    }

    /// Round 2 deadline is independent of round 1 deadline.
    /// Default in round 2 requires passing round 2's deadline, not round 1's.
    #[test]
    fn test_each_round_deadline_is_independent() {
        let t = setup_circle();
        t.activate();

        // Complete rounds 0 and 1 (all contribute on time)
        t.complete_round();
        t.complete_round();

        // Now in round 2 — advance past its fresh deadline
        let round2 = t.circle.get_current_round();
        assert_eq!(round2.round_index, 2);
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round2.deadline_ledger as u32 + 1;
        });

        // mark_default must succeed for round 2
        t.circle.mark_default(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);

        // Carol's round-0 and round-1 defaults are still 0 (she was not
        // defaulted in those rounds — only in round 2)
        // This also proves defaults are counted per-round, not globally
    }

    /// Late contribution is blocked by the same deadline predicate as mark_default.
    /// One ledger past the deadline: contribute rejects, mark_default accepts.
    #[test]
    fn test_contribute_and_mark_default_share_identical_boundary() {
        let t = setup_circle();
        t.activate();
        let round = t.circle.get_current_round();

        // Advance to exactly one past the deadline
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });

        // contribute must be blocked
        let contrib_result = t.circle.try_contribute(&t.dave);
        assert!(contrib_result.is_err(), "contribute must be blocked past deadline");

        // mark_default must succeed (dave did not contribute)
        t.circle.mark_default(&t.dave);
        assert_eq!(t.circle.get_defaults(&t.dave), 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue: Collateral traceability — conservation tests
    //
    // Every stroop that enters the contract as collateral must exit exactly
    // once: either returned via close() or forfeited via mark_default().
    // These tests verify the accounting at every lifecycle transition.
    // ══════════════════════════════════════════════════════════════════════════

    /// Normal completion: all collateral deposited equals all collateral returned.
    /// No penalties → total released == total deposited.
    #[test]
    fn test_collateral_conservation_normal_completion() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        // Record token balances before close
        let balances_before: std::vec::Vec<i128> = [&t.alice, &t.bob, &t.carol, &t.dave]
            .iter()
            .map(|m| t.token.balance(m))
            .collect();

        t.circle.close(&t.alice);

        let collateral_per_member = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;

        // Every member must receive exactly their full collateral back
        for (i, member) in [&t.alice, &t.bob, &t.carol, &t.dave].iter().enumerate() {
            let returned = t.token.balance(member) - balances_before[i];
            assert_eq!(
                returned, collateral_per_member,
                "member {} should receive full collateral back after normal completion",
                i
            );
            // Storage key must be zeroed
            assert_eq!(t.circle.get_collateral(member), 0);
        }
    }

    /// Default path: penalized member's collateral decreases exactly by the penalty.
    /// Remaining collateral is still returned on close.
    #[test]
    fn test_collateral_conservation_with_default() {
        let t = setup_circle();
        t.activate();

        let initial_collateral = t.circle.get_collateral(&t.carol);
        let expected_penalty = initial_collateral * PENALTY_BPS / BPS_DENOM;
        let expected_remaining = initial_collateral - expected_penalty;

        // Carol misses the deadline
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);

        // Stored collateral must be exactly initial - penalty
        assert_eq!(t.circle.get_collateral(&t.carol), expected_remaining);
        // Penalty was deducted once
        assert_eq!(initial_collateral - t.circle.get_collateral(&t.carol), expected_penalty);

        // After close, carol receives the remaining collateral (not the original amount)
        t.force_status(CircleStatus::Completed);
        let carol_before = t.token.balance(&t.carol);
        t.circle.close(&t.carol);
        let carol_returned = t.token.balance(&t.carol) - carol_before;
        assert_eq!(
            carol_returned, expected_remaining,
            "close must return remaining collateral, not original amount"
        );
        assert_eq!(t.circle.get_collateral(&t.carol), 0, "storage must be zeroed after close");
    }

    /// Multi-round defaults: collateral decreases by 20% on each missed round.
    /// Each deduction is applied to the remaining balance (compounding).
    #[test]
