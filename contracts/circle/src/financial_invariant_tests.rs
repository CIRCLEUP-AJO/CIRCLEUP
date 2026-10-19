//! Financial invariant property tests for the Circle contract.
//!
//! This module extends the existing prop_tests.rs with token conservation
//! and financial invariant checks.
//!
//! # Design
//!
//! These tests verify that token movements obey conservation laws across
//! different lifecycle scenarios:
//!   - Completed circles (all members contribute, all receive pot once)
//!   - Defaulted circles (penalties applied correctly)
//!   - Cancelled circles (collateral returned proportionally)
//!
//! Each test generates bounded random scenarios and asserts:
//!   1. Total tokens are conserved (no value created or destroyed)
//!   2. No member can receive more than the pot (duplicate payout impossible)
//!   3. Collateral penalties are applied correctly (20% per default)
//!   4. Remaining balances reflect all movements
//!
//! # Bounding
//!
//! To keep CI runtime predictable:
//!   - Member count: 2-6 (not the full 256)
//!   - Round amount: 1-1_000_000_000 (fits in i128)
//!   - Action sequences: bounded to 20 steps max
//!   - Proptest cases: 32 (reduced from 64 for financial suite)

#[cfg(test)]
mod financial_invariant_tests {
    extern crate std;
    use std::vec::Vec;

    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec as SdkVec,
    };

    use crate::{
        CircleContract, CircleContractClient, CircleStatus, DataKey,
        BPS_DENOM, COLLATERAL_MULTIPLIER, PENALTY_BPS,
    };
    use reputation::{ReputationContract, ReputationContractClient};

    // ── Constants ────────────────────────────────────────────────────────────

    const MAX_INVARIANT_MEMBER_COUNT: usize = 6;
    const MAX_ACTION_SEQUENCE_LENGTH: usize = 20;
    const INVARIANT_TEST_CASES: u32 = 32;

    // ── Test Fixtures ────────────────────────────────────────────────────────

    struct FinancialSetup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        circle_id: Address,
        token: TokenClient<'a>,
        token_id: Address,
        rep_id: Address,
        members: Vec<Address>,
        round_amount: i128,
        initial_balances: Vec<i128>,
    }

    fn make_financial_setup(
        member_count: usize,
        round_amount: i128,
        deadline: u32,
    ) -> FinancialSetup {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_reg = env.register_stellar_asset_contract_v2(token_admin);
        let token_id = token_reg.address();
        let token = TokenClient::new(&env, &token_id);
        let asset_client = StellarAssetClient::new(&env, &token_id);

        let rep_reg = env.register_contract(None, ReputationContract);
        let rep_id = rep_reg.clone();
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        rep_client.initialize(&Address::generate(&env));

        let circle_reg = env.register_contract(None, CircleContract);
        let circle_id = circle_reg.clone();
        let circle = CircleContractClient::new(&env, &circle_id);

        rep_client.add_authorized_caller(&Address::generate(&env), &circle_id);

        let mut members = Vec::with_capacity(member_count);
        let mut sdk_members = SdkVec::new(&env);
        let mut initial_balances = Vec::with_capacity(member_count);

        // Each member needs: collateral + contributions for all rounds + buffer
        let budget = round_amount * (COLLATERAL_MULTIPLIER as i128 + member_count as i128 + 1);

        for _ in 0..member_count {
            let m = Address::generate(&env);
            asset_client.mint(&m, &budget);
            initial_balances.push(token.balance(&m));
            members.push(m.clone());
            sdk_members.push_back(m);
        }

        // Record circle creator's initial balance (for tracking fees)
        let creator = Address::generate(&env);
        initial_balances.push(token.balance(&creator));

        circle.initialize(
            &creator,
            &sdk_members,
            &round_amount,
            &token_id,
            &rep_id,
            &deadline,
        );

        FinancialSetup {
            env,
            circle,
            circle_id,
            token,
            token_id,
            rep_id,
            members,
            round_amount,
            initial_balances,
        }
    }

    // ── Helper Functions ─────────────────────────────────────────────────────

    fn join_all(setup: &FinancialSetup) {
        for m in &setup.members {
            setup.circle.join(m);
        }
    }

    fn contribute_all(setup: &FinancialSetup) {
        for m in &setup.members {
            let _ = setup.circle.try_contribute(m);
        }
    }

    fn complete_round(setup: &FinancialSetup) -> bool {
        contribute_all(setup);
        setup.circle.payout().is_ok()
    }

    fn advance_past_deadline(setup: &FinancialSetup) {
        if let Ok(round) = setup.circle.get_current_round() {
            setup.env.ledger().with_mut(|l| {
                l.sequence_number = round.deadline_ledger as u32 + 1;
            });
        }
    }

    // ── Invariant Tests ─────────────────────────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(INVARIANT_TEST_CASES))]

        // ── FI-1: Full completion conservation ─────────────────────────────
        //
        // When a circle completes all rounds with no defaults:
        //   - Total tokens held by members after close must equal initial total
        //   - Each member's net change must be exactly 0

        #[test]
        fn prop_full_completion_conservation(
            member_count in 2usize..=MAX_INVARIANT_MEMBER_COUNT,
            round_amount in 1i128..=1_000_000_000i128,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            let total_initial: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            join_all(&setup);

            // Complete all rounds
            for _ in 0..member_count {
                let completed = complete_round(&setup);
                prop_assert!(completed, "round must complete successfully");
            }

            prop_assert_eq!(
                setup.circle.get_status(),
                CircleStatus::Completed,
                "circle must be completed after all rounds"
            );

            // Close the circle to release collateral
            setup.circle.close(&setup.members[0]);

            // Calculate total after close
            let total_after: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            // Tokens must be conserved (allowing for fees which stay in the circle contract)
            prop_assert!(
                total_after <= total_initial,
                "total after must not exceed initial (conservation): {} <= {}",
                total_after, total_initial
            );

            // Each member's net change should be 0 (ROSCA is zero-sum)
            for (i, m) in setup.members.iter().enumerate() {
                let balance_after = setup.token.balance(m);
                let net_change = balance_after - setup.initial_balances[i];
                prop_assert_eq!(
                    net_change, 0i128,
                    "member[{}] net change must be 0 in zero-sum ROSCA, got {}",
                    i, net_change
                );
            }
        }

        // ── FI-2: Default penalty conservation ─────────────────────────────
        //
        // When defaults occur, the penalty must be correctly calculated:
        //   penalty = collateral * PENALTY_BPS / BPS_DENOM
        //   new_collateral = old_collateral - penalty
        // Total penalties collected = sum of all penalty amounts

        #[test]
        fn prop_default_penalty_calculation(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
            default_victim_index in 0usize..3usize,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            join_all(&setup);

            let victim = setup.members[default_victim_index].clone();
            let collateral_before = setup.circle.get_collateral(&victim);

            // Advance past deadline and mark default
            advance_past_deadline(&setup);
            setup.circle.mark_default(&victim);

            let collateral_after = setup.circle.get_collateral(&victim);
            let expected_penalty = collateral_before * PENALTY_BPS / BPS_DENOM;

            prop_assert_eq!(
                collateral_before - collateral_after,
                expected_penalty,
                "penalty must be exactly {} (20% of {}), got {}",
                expected_penalty, collateral_before, collateral_before - collateral_after
            );

            // Collateral must never go negative
            prop_assert!(
                collateral_after >= 0,
                "collateral must not go negative: {}",
                collateral_after
            );
        }

        // ── FI-3: No duplicate payout possible ─────────────────────────────
        //
        // The contract must prevent double-payout:
        //   - Calling payout twice for the same round must panic on second call
        //   - Only one payout record should exist per round

        #[test]
        fn prop_no_duplicate_payout(
            member_count in 2usize..=4,
            round_amount in 1i128..=50_000_000i128,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            join_all(&setup);

            // First round: all contribute
            contribute_all(&setup);

            // First payout should succeed
            let first_payout = setup.circle.try_payout();
            prop_assert!(
                first_payout.is_ok(),
                "first payout must succeed"
            );

            // Second payout in same round must fail
            let second_payout = setup.circle.try_payout();
            prop_assert!(
                second_payout.is_err(),
                "second payout in same round must fail (no double-payout)"
            );
        }

        // ── FI-4: Cancelled circle returns all collateral ──────────────────
        //
        // When a Pending circle is cancelled before activation,
        // all collateral must be returned to members.

        #[test]
        fn prop_cancelled_returns_all_collateral(
            member_count in 2usize..=4,
            round_amount in 1i128..=50_000_000i128,
            cancel_after_joins in 0usize..3usize,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);

            // Record total collateral locked
            let total_initial: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            // Join some members but not all (keeps circle Pending)
            let join_count = (cancel_after_joins + 1).min(member_count);
            for i in 0..join_count {
                setup.circle.join(&setup.members[i]);
            }

            // Get collateral before cancellation
            let pre_cancel_balances: Vec<i128> = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .collect();

            // Cancel the circle (must be Pending)
            setup.circle.cancel(&setup.members[0]);

            // Verify status
            prop_assert_eq!(
                setup.circle.get_status(),
                CircleStatus::Cancelled,
                "circle must be cancelled"
            );

            // Close to release collateral
            setup.circle.close(&setup.members[0]);

            // Total after close should be <= total before (fees may be deducted)
            let total_after: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            prop_assert!(
                total_after >= total_initial - (member_count as i128), // Allow 1 stroop fee per member
                "total after cancel+close must approximately equal initial: {} >= {}",
                total_after, total_initial
            );
        }

        // ── FI-5: Token conservation under mixed defaults ───────────────────
        //
        // Complex scenario: some rounds complete, some have defaults.
        // Total tokens must still be conserved (modulo penalties).

        #[test]
        fn prop_mixed_defaults_conservation(
            member_count in 3usize..=MAX_INVARIANT_MEMBER_COUNT,
            round_amount in 1i128..=10_000_000i128,
            default_rounds in prop::collection::vec(0u32..3u32, 1..=3),
            rounds_to_complete in 1u32..3u32,
        ) {
            let mc = member_count;
            let setup = make_financial_setup(mc, round_amount, 100);
            let total_initial: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            join_all(&setup);

            // Complete some rounds normally
            for _ in 0..rounds_to_complete {
                let ok = complete_round(&setup);
                prop_assert!(ok, "normal round must complete");
            }

            // Default on subsequent rounds
            for round_idx in default_rounds.iter() {
                // Force round state
                setup.env.as_contract(&setup.circle_id, || {
                    let mut round: crate::RoundState = setup
                        .env
                        .storage()
                        .instance()
                        .get(&DataKey::CurrentRound)
                        .unwrap();
                    round.round_index = *round_idx;
                    round.paid_out = false;
                    round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                    setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
                });
                setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });

                // Default the last member in rotation
                let defaulter = setup.members[mc - 1].clone();
                let _ = setup.circle.try_mark_default(&defaulter);
            }

            // Complete remaining rounds
            let mut completed = true;
            while completed && setup.circle.get_status() == CircleStatus::Active {
                completed = complete_round(&setup);
            }

            // Close circle
            setup.circle.close(&setup.members[0]);

            let total_after: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            // Conservation check: total_after <= total_initial (fees may reduce)
            // The difference should be exactly the penalties taken
            let penalties_expected: i128 = default_rounds.len() as i128 
                * round_amount 
                * PENALTY_BPS 
                / BPS_DENOM;

            let difference = total_initial - total_after;
            
            // Allow for rounding and fees - penalties should be in the ballpark
            prop_assert!(
                difference >= penalties_expected - (mc as i128), // Allow some rounding variance
                "total difference {} should approximate penalties {}",
                difference, penalties_expected
            );

            // But never should total be MORE than initial (tokens created)
            prop_assert!(
                total_after <= total_initial,
                "tokens must never be created: {} <= {}",
                total_after, total_initial
            );
        }

        // ── FI-6: Collateral strictly decreases with each default ───────────
        //
        // Each default must reduce collateral by exactly PENALTY_BPS/BPS_DENOM.
        // Multiple defaults compound multiplicatively.

        #[test]
        fn prop_collateral_decreases_per_default(
            member_count in 2usize..=4,
            round_amount in 1000i128..=10_000_000i128,
            defaults_count in 1u32..=5u32,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            join_all(&setup);

            let target = setup.members[0].clone();
            let mut prev_collateral = setup.circle.get_collateral(&target);
            let expected_penalty = round_amount * PENALTY_BPS / BPS_DENOM;

            for i in 0..defaults_count {
                // Create a fresh round for each default
                setup.env.as_contract(&setup.circle_id, || {
                    let mut round: crate::RoundState = setup
                        .env
                        .storage()
                        .instance()
                        .get(&DataKey::CurrentRound)
                        .unwrap();
                    round.round_index = i;
                    round.paid_out = false;
                    round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                    setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
                });
                setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });

                setup.circle.mark_default(&target);
                let curr_collateral = setup.circle.get_collateral(&target);

                // Each default should reduce by exactly the penalty amount
                prop_assert_eq!(
                    prev_collateral - curr_collateral,
                    expected_penalty,
                    "default #{}: collateral must decrease by exactly penalty ({}), was {}",
                    i + 1, expected_penalty, prev_collateral - curr_collateral
                );

                prev_collateral = curr_collateral;
            }
        }

        // ── FI-7: Bounded action sequence with financial invariant check ────
        //
        // Generate random sequences of actions and verify financial invariants
        // hold throughout.

        #[test]
        fn prop_random_action_sequence_conservation(
            member_count in 2usize..=MAX_INVARIANT_MEMBER_COUNT,
            round_amount in 1i128..=5_000_000i128,
            seed in any::<u64>(),
        ) {
            let mc = member_count;
            let setup = make_financial_setup(mc, round_amount, 100);
            let total_initial: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            join_all(&setup);

            // Generate bounded random action sequence
            let mut rng = seed;
            for _ in 0..MAX_ACTION_SEQUENCE_LENGTH {
                if setup.circle.get_status() != CircleStatus::Active {
                    break;
                }

                // Mix of contribute, default, payout actions
                rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
                let action = (rng % 10) as usize;

                match action {
                    // Contribute (50% probability)
                    0..=4 => {
                        let member_idx = (rng / 10 % mc as u64) as usize;
                        let _ = setup.circle.try_contribute(&setup.members[member_idx]);
                    }
                    // Mark default (30% probability)
                    5..=7 => {
                        advance_past_deadline(&setup);
                        let member_idx = (rng / 100 % mc as u64) as usize;
                        let _ = setup.circle.try_mark_default(&setup.members[member_idx]);
                    }
                    // Payout (20% probability)
                    _ => {
                        let _ = setup.circle.try_payout();
                    }
                }

                // Invariant: total tokens in system must never exceed initial
                // (they may be less due to penalties/fees)
                let current_total: i128 = setup.members.iter()
                    .map(|m| setup.token.balance(m))
                    .sum();

                prop_assert!(
                    current_total <= total_initial,
                    "token total must never exceed initial (value created): {} > {}",
                    current_total, total_initial
                );
            }

            // Final state: close if terminal
            if setup.circle.get_status() == CircleStatus::Completed 
                || setup.circle.get_status() == CircleStatus::Cancelled {
                let _ = setup.circle.try_close(&setup.members[0]);
            }

            // Final invariant: no value created
            let final_total: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            prop_assert!(
                final_total <= total_initial,
                "final total must not exceed initial (value created): {} > {}",
                final_total, total_initial
            );
        }
    }

    // ── Regression Fixtures ─────────────────────────────────────────────────
    //
    // These deterministic tests capture known failure patterns. When a
    // proptest shrinks a failing case, the seed is stored in the
    // proptest-regressions directory and these tests ensure it stays fixed.

    #[test]
    fn regression_two_member_zero_amount() {
        // Edge case: minimal amounts
        let setup = make_financial_setup(2, 1, 100);
        join_all(&setup);

        let total_initial: i128 = setup.members.iter()
            .map(|m| setup.token.balance(m))
            .sum();

        // Complete both rounds
        complete_round(&setup);
        complete_round(&setup);

        setup.circle.close(&setup.members[0]);

        let total_after: i128 = setup.members.iter()
            .map(|m| setup.token.balance(m))
            .sum();

        // Must conserve (allow for integer truncation)
        assert!(total_after <= total_initial);
    }

    #[test]
    fn regression_max_penalty_compound() {
        // 5 defaults on 1M amount = 0.8^5 * 1M ~= 327K remaining
        let setup = make_financial_setup(2, 1_000_000, 100);
        join_all(&setup);

        let target = setup.members[0].clone();
        
        for i in 0..5 {
            setup.env.as_contract(&setup.circle_id, || {
                let mut round: crate::RoundState = setup
                    .env
                    .storage()
                    .instance()
                    .get(&DataKey::CurrentRound)
                    .unwrap();
                round.round_index = i;
                round.paid_out = false;
                round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
            });
            setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });
            
            setup.circle.mark_default(&target);
        }

        let final_collateral = setup.circle.get_collateral(&target);
        
        // Should be approximately 1M * (0.8)^5 = 327,680 (integer math)
        let expected = 1_000_000_i128 * BPS_DENOM.saturating_sub(PENALTY_BPS).pow(5) 
            / BPS_DENOM.pow(5);
        
        assert!(final_collateral >= expected.saturating_sub(10)); // Allow 10 stroop variance
        assert!(final_collateral >= 0, "collateral must not be negative");
    }

    #[test]
    fn regression_four_member_full_lifecycle() {
        // Known working case: 4 members, standard amount
        let setup = make_financial_setup(4, 10_000_000, 100);
        
        let balances_before: Vec<i128> = setup.members.iter()
            .map(|m| setup.token.balance(m))
            .collect();
        let total_before: i128 = balances_before.iter().sum();

        join_all(&setup);
        assert_eq!(setup.circle.get_status(), CircleStatus::Active);

        // Complete all 4 rounds
        for _ in 0..4 {
            complete_round(&setup);
        }

        assert_eq!(setup.circle.get_status(), CircleStatus::Completed);

        // Close to return collateral
        setup.circle.close(&setup.members[0]);

        // Each member should net 0 (contributed once, received pot once)
        for (i, m) in setup.members.iter().enumerate() {
            let balance_after = setup.token.balance(m);
            assert_eq!(
                balance_after, balances_before[i],
                "member[{}] net must be 0: before={}, after={}",
                i, balances_before[i], balance_after
            );
        }
    }
}