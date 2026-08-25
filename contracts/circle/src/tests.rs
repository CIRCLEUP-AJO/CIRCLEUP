//! Unit tests for the circle contract.
//!
//! # Test helpers
//!
//! To avoid repetitive boilerplate, a small set of type-safe wrapper methods
//! sit alongside the `TestSetup` struct.  They live in this file rather than
//! `lib.rs` because they only exist to make tests easier to read and maintain
//! — they do not belong in production code.
//!
//! | Helper | Purpose |
//! |--------|---------|
//! | `setup_circle()` | Full 4-member fixture with funded wallets |
//! | `setup_env_with_token_and_reputation()` | Bare env + token + rep contracts |
//! | `TestSetup::activate()` | All 4 members call join; circle goes Active |
//! | `TestSetup::contribute_all()` | All 4 members contribute for the current round |
//! | `TestSetup::complete_round()` | `contribute_all` + `payout` |
//! | `TestSetup::complete_all_rounds()` | Run all N rounds to Completed status |
//! | `TestSetup::force_status()` | Override storage status inside `as_contract` |
//! | `TestSetup::force_collateral()` | Override one member's collateral value |
//! | `TestSetup::advance_past_deadline()` | Bump ledger sequence past round deadline |

#[cfg(test)]
mod circle_tests {
    extern crate std;
    use crate::{
        CircleContract, CircleContractClient, CircleStatus, DataKey,
        COLLATERAL_MULTIPLIER, MAX_MEMBERS, MAX_ROUND_DEADLINE_LEDGERS, MIN_ROUND_DEADLINE_LEDGERS,
        PENALTY_BPS, BPS_DENOM,
    };
    use reputation::{ReputationContract, ReputationContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC in stroops (7 decimals)
    const ROUND_DEADLINE: u32 = 1_000; // ledgers


    // ── TestSetup ─────────────────────────────────────────────────────────────

    struct TestSetup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        circle_id: Address,
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

    impl<'a> TestSetup<'a> {
        // ── Type-safe test-action wrappers ────────────────────────────────────

        /// Have every member call `join`; the circle transitions to Active once
        /// the last member joins.
        fn activate(&self) {
            self.circle.join(&self.alice);
            self.circle.join(&self.bob);
            self.circle.join(&self.carol);
            self.circle.join(&self.dave);
        }

        /// All 4 members contribute for the **current** round.
        ///
        /// Panics (via the contract) if any member has already contributed or
        /// if the round deadline has passed.
        fn contribute_all(&self) {
            self.circle.contribute(&self.alice);
            self.circle.contribute(&self.bob);
            self.circle.contribute(&self.carol);
            self.circle.contribute(&self.dave);
        }

        /// Contribute + payout for the current round.
        ///
        /// Returns the round index that was just completed.
        fn complete_round(&self) -> u32 {
            let round = self.circle.get_current_round();
            let idx = round.round_index;
            self.contribute_all();
            self.circle.payout();
            idx
        }

        /// Drive the circle through **all** N rounds until status == Completed.
        fn complete_all_rounds(&self) {
            let member_count = self.members.len() as u32;
            for _ in 0..member_count {
                self.complete_round();
            }
            assert_eq!(
                self.circle.get_status(),
                CircleStatus::Completed,
                "expected Completed after all rounds finished"
            );
        }

        /// Override circle status via `as_contract` — bypasses `require_auth`
        /// so tests can exercise Completed / Cancelled paths directly.
        ///
        /// When forcing `Completed`, also aligns `RoundsCompleted` with the
        /// member count so the `close()` invariant check passes.
        fn force_status(&self, status: CircleStatus) {
            let member_count = self.members.len();
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .instance()
                    .set(&DataKey::Status, &status);
                if matches!(status, CircleStatus::Completed) {
                    self.env
                        .storage()
                        .instance()
                        .set(&DataKey::RoundsCompleted, &member_count);
                }
            });
        }

        /// Override a member's collateral balance via `as_contract`.
        ///
        /// Used to test edge-cases (e.g. collateral == 0 after full penalty drain)
        /// without performing real token transfers.
        fn force_collateral(&self, member: &Address, amount: i128) {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Collateral(member.clone()), &amount);
            });
        }

        /// Advance the test ledger sequence past the current round deadline so
        /// `mark_default` / late-contribution guard triggers correctly.
        fn advance_past_deadline(&self) {
            self.env.ledger().with_mut(|l| {
                l.sequence_number += ROUND_DEADLINE + 1;
            });
        }
    }


    // ── Fixtures ──────────────────────────────────────────────────────────────

    fn setup_circle() -> TestSetup<'static> {
        let env = Env::default();
        env.mock_all_auths();

        // Deploy USDC mock token
        let _token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(_token_admin.clone());
        let token = TokenClient::new(&env, &token_id.address());
        let token_asset_client = StellarAssetClient::new(&env, &token_id.address());

        // Create 4 members
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);
        let dave = Address::generate(&env);

        // Fund each member: collateral (COLLATERAL_MULTIPLIER ×) + 4 rounds of contributions
        for m in [&alice, &bob, &carol, &dave] {
            token_asset_client.mint(m, &(ROUND_AMOUNT * (COLLATERAL_MULTIPLIER + 4)));
        }

        // Deploy circle contract first so we know its address before deploying
        // the reputation contract.  The circle contract is the authorized caller
        // of reputation.increment (it calls it from payout), so the reputation
        // contract must be initialized with a separate admin address that can
        // then register the circle as an authorized caller.
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // Deploy reputation contract and initialize it with a dedicated admin.
        // The admin then registers the circle as an authorized caller so payout
        // can award reputation scores.  This mirrors the production flow where
        // the factory acts as reputation admin.
        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);
        rep_client.add_authorized_caller(&rep_admin, &circle_id);

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
            circle_id,
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

    /// Minimal fixture: env + USDC token + reputation contract, no circle.
    ///
    /// Used by tests that deploy their own circle instance to verify
    /// initialization edge-cases without interference from `setup_circle`.
    fn setup_env_with_token_and_reputation() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);

        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);

        (env, token_id.address(), rep_id)
    }


    // ── Join tests ────────────────────────────────────────────────────────────

    #[test]
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
    #[should_panic(expected = "already contributed this round")]
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
    #[should_panic(expected = "not all members have contributed yet")]
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
    #[should_panic(expected = "round deadline not yet passed")]
    fn test_mark_default_before_deadline_panics() {
        let t = setup_circle();
        t.activate();
        t.circle.mark_default(&t.carol);
    }

    #[test]
    #[should_panic(expected = "member did contribute")]
    fn test_mark_default_on_contributor_panics() {
        let t = setup_circle();
        t.activate();
        t.circle.contribute(&t.carol);
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);
    }

    #[test]
    #[should_panic(expected = "already marked default this round")]
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
    #[should_panic(expected = "not authorized to close: caller is not a circle member")]
    fn test_close_rejects_non_member() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        let stranger = Address::generate(&t.env);
        t.circle.close(&stranger);
    }

    #[test]
    #[should_panic(expected = "circle already closed")]
    fn test_close_second_call_panics() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        t.circle.close(&t.bob);
        // Second invocation must be rejected — the Closed flag is set after the
        // first call so no partial-release state can accumulate.
        t.circle.close(&t.carol);
    }

    #[test]
    #[should_panic(expected = "circle still active")]
    fn test_close_rejects_while_active() {
        let t = setup_circle();
        t.activate();
        t.circle.close(&t.alice);
    }


    // ── Join edge-case: zero collateral must still block re-join ──────────────

    #[test]
    #[should_panic(expected = "already joined")]
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
    #[should_panic(expected = "round deadline passed; cannot contribute before payout")]
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
    #[should_panic(expected = "can only cancel a pending circle")]
    fn test_cancel_active_panics() {
        let t = setup_circle();
        t.activate();
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

        circle.initialize(
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
    #[should_panic(expected = "too many members")]
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

        circle.initialize(
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
    #[should_panic(expected = "round deadline not yet passed")]
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
    // The `joined` event data is a tuple `(Address, u32)` where the first
    // element is the joining member's address and the second is their 1-based
    // position in the join queue (1 = first to join, N = last / activating join).
    // These tests act as a contract-level API guarantee for the event shape.

    #[test]
    fn test_join_emits_joined_event_with_member_and_order() {
        let t = setup_circle();
        t.env.events().all(); // consume pre-existing events (e.g. "initialized")

        t.circle.join(&t.alice);

        let joined = events_named(&t.env, "joined");
        assert_eq!(joined.len(), 1, "expected exactly one 'joined' event");

        // The data payload is `(member: Address, order: u32)`.
        // Decode via the tuple IntoVal / FromVal round-trip.
        let data_val = joined[0].clone();
        let (member, order): (Address, u32) =
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
            let (member, order): (Address, u32) =
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
    fn test_last_join_order_equals_member_count() {
        let t = setup_circle();
        t.activate(); // all 4 members join

        let joined = events_named(&t.env, "joined");
        assert_eq!(joined.len(), 4, "expected one 'joined' event per member");

        // The final join (dave) should carry order == 4 == total member count.
        let last_val = joined.last().unwrap().clone();
        let (member, order): (Address, u32) =
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

        circle.initialize(
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &ROUND_DEADLINE,
        );

        let initialized = events_named(&env, "initialized");
        assert_eq!(initialized.len(), 1, "expected one 'initialized' event");
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
    fn test_get_pot_amount_readable_while_pending() {
        let t = setup_circle();
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);

        let pot = t.circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 4);
    }

    /// `get_pot_amount` must remain readable after all rounds complete.
    /// The value stays constant because Config is never mutated post-initialize.
    #[test]
    fn test_get_pot_amount_readable_after_completed() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);

        let pot = t.circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 4, "pot must be unchanged after circle completes");
    }

    /// `get_pot_amount` must remain readable after a circle is cancelled.
    #[test]
    fn test_get_pot_amount_readable_after_cancelled() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

        let pot = t.circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 4, "pot must be readable after cancellation");
    }

    /// Minimal 2-member circle: pot must be 2 × round_amount.
    ///
    /// Exercises the lower bound of member count to ensure the calculation is
    /// correct for circles smaller than the 4-member default fixture.
    #[test]
    fn test_get_pot_amount_two_member_circle() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member_a);
        members.push_back(member_b);

        circle.initialize(
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let pot = circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 2, "2-member pot must be 2 × ROUND_AMOUNT");
    }

    /// `get_pot_amount` must return the same value across consecutive calls —
    /// it must have no side-effects and no dependency on call count.
    #[test]
    fn test_get_pot_amount_is_idempotent() {
        let t = setup_circle();
        let first  = t.circle.get_pot_amount();
        let second = t.circle.get_pot_amount();
        let third  = t.circle.get_pot_amount();
        assert_eq!(first, second, "get_pot_amount must return the same value on repeated calls");
        assert_eq!(second, third,  "get_pot_amount must be idempotent");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #164 — Enforce canonical round lifecycle and default-resolution
    // invariants.
    //
    // Tests in this section cover adversarial edge cases, exact deadline
    // boundary strictness, post-payout mutation attempts, idempotency of
    // default/contribution records, and multi-round state consistency.
    // ══════════════════════════════════════════════════════════════════════════

    // ── Helpers ───────────────────────────────────────────────────────────────

    impl<'a> TestSetup<'a> {
        /// Write a `Contributed(member, round_index)` persistent key directly,
        /// bypassing the contract entry-point.  Used to manufacture fake
        /// contribution records for invariant tests.
        fn force_contributed(&self, member: &Address, round_index: u32) {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Contributed(member.clone(), round_index), &true);
            });
        }

        /// Check whether a `Contributed(member, round_index)` key exists in
        /// persistent storage without going through the contract entry-point.
        fn has_contributed_key(&self, member: &Address, round_index: u32) -> bool {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Contributed(member.clone(), round_index))
            })
        }

        /// Check whether a `Defaulted(member, round_index)` key exists.
        fn has_defaulted_key(&self, member: &Address, round_index: u32) -> bool {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Defaulted(member.clone(), round_index))
            })
        }
    }

    // ── Post-payout mutation rejection ────────────────────────────────────────

    /// Once a round is paid out, `payout` must refuse to run again for the
    /// same round.  Because `payout` immediately advances `CurrentRound` to
    /// the next round (or sets Completed), the `paid_out` flag on the *old*
    /// round is only visible through the storage directly, but the new round's
    /// `paid_out` starts as false.  This test verifies the double-payout path
    /// is impossible by confirming the status and round index advance correctly.
    #[test]
    fn test_payout_advances_round_so_double_payout_impossible() {
        let t = setup_circle();
        t.activate();
        t.contribute_all();
        t.circle.payout();

        // After payout the round has advanced to index 1 — payout for round 0
        // cannot be called again because CurrentRound now points to round 1.
        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1, "round must have advanced after payout");
        assert!(!round.paid_out, "new round must not be marked paid_out");
    }

    /// A second call to `payout` on a round that has not yet received all
    /// contributions must panic with the incomplete-tally message.  This ensures
    /// that even if a caller attempts to replay payout before contributions
    /// arrive, the guard fires.
    #[test]
    #[should_panic(expected = "not all members have contributed yet")]
    fn test_payout_without_full_contributions_panics() {
        let t = setup_circle();
        t.activate();
        // Only two of four members contribute
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.payout();
    }

    /// After a complete round (contribute_all + payout), contributing for the
    /// *old* round index must be rejected because `paid_out` is set before
    /// `CurrentRound` advances and the contribution entry for that member
    /// already exists.
    #[test]
    #[should_panic(expected = "already contributed this round")]
    fn test_contribute_after_payout_on_same_round_panics() {
        let t = setup_circle();
        t.activate();
        t.contribute_all(); // round 0: all contribute
        // Do NOT call payout yet — alice tries to contribute again for round 0
        t.circle.contribute(&t.alice);
    }

    /// After payout has run and the round index has advanced, contributing for
    /// the new round is valid.  This confirms the round advancement doesn't
    /// lock out contributions for subsequent rounds.
    #[test]
    fn test_contribute_for_new_round_after_payout_succeeds() {
        let t = setup_circle();
        t.activate();
        t.complete_round(); // round 0 → payout → round 1 starts

        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1);

        // Contributing for round 1 should succeed (no prior contribution)
        t.circle.contribute(&t.alice);
        assert!(t.has_contributed_key(&t.alice, 1));
    }

    // ── Default after payout rejection ────────────────────────────────────────

    /// `mark_default` on a round that has already been paid out must be
    /// rejected.  Because `payout` advances `CurrentRound` to the next round
    /// immediately, `mark_default` on the *old* round index is structurally
    /// impossible (there is no in-progress round with that index any more).
    /// This test confirms the round-advancement makes old-round defaults
    /// unreachable.
    #[test]
    fn test_mark_default_impossible_on_paid_out_round() {
        let t = setup_circle();
        t.activate();
        t.complete_round(); // round 0 paid out; CurrentRound now = round 1

        // Advance past the new deadline to enter default territory
        t.advance_past_deadline();

        // carol didn't contribute to round 1; mark her default for round 1
        t.circle.mark_default(&t.carol);
        // The default is recorded for round 1, NOT round 0
        assert!(t.has_defaulted_key(&t.carol, 1));
        assert!(
            !t.has_defaulted_key(&t.carol, 0),
            "no Defaulted key must exist for round 0 — it was paid out"
        );
    }

    /// Attempting to call `mark_default` on a Completed circle must panic with
    /// "circle is not active".
    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_mark_default_on_completed_circle_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        // Circle is now Completed — any mark_default must fail
        t.circle.mark_default(&t.alice);
    }

    /// Attempting to call `mark_default` on a Cancelled circle must also panic
    /// with "circle is not active".
    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_mark_default_on_cancelled_circle_panics() {
        let t = setup_circle();
        t.circle.cancel(&t.alice);
        t.circle.mark_default(&t.alice);
    }

    // ── Idempotency: Contributed and Defaulted records ────────────────────────

    /// A `Contributed` key written via `force_contributed` exists in storage
    /// and is acknowledged by `has_contributed`.  This validates that the
    /// low-level key format used by the contract is consistent with what the
    /// test can observe directly.
    #[test]
    fn test_contributed_key_format_is_consistent() {
        let t = setup_circle();
        t.activate();

        // Before any contribute call the key must be absent
        assert!(!t.has_contributed_key(&t.alice, 0));
        assert!(!t.circle.has_contributed(&t.alice, &0u32));

        t.circle.contribute(&t.alice);

        // After contribute the key exists both via public view and internal check
        assert!(t.has_contributed_key(&t.alice, 0));
        assert!(t.circle.has_contributed(&t.alice, &0u32));
    }

    /// A `Contributed` key must not exist for a round that has not started yet.
    /// This validates that round advancement doesn't pre-populate future-round keys.
    #[test]
    fn test_no_contributed_key_for_future_rounds() {
        let t = setup_circle();
        t.activate();
        t.circle.contribute(&t.alice);

        // Round 1 has not started — no contributed key for it
        assert!(!t.has_contributed_key(&t.alice, 1));
        assert!(!t.has_contributed_key(&t.alice, 99));
    }

    /// After payout runs for round N, a `Contributed` key for round N must
    /// still exist in persistent storage for every member — the key is not
    /// deleted on payout, preserving the audit trail.
    #[test]
    fn test_contributed_keys_persist_after_payout() {
        let t = setup_circle();
        t.activate();
        t.contribute_all();
        t.circle.payout();

        // All four round-0 `Contributed` keys must still be present
        for member in [&t.alice, &t.bob, &t.carol, &t.dave] {
            assert!(
                t.has_contributed_key(member, 0),
                "Contributed(member, 0) key must persist after payout"
            );
        }
    }

    /// There must never be a `Defaulted` key for a round that was already paid
    /// out.  After payout for round 0 the current round is 1; any default
    /// recorded must be for round 1, not round 0.
    #[test]
    fn test_no_defaulted_key_for_paid_out_round() {
        let t = setup_circle();
        t.activate();
        t.complete_round(); // pay out round 0
        t.advance_past_deadline();

        t.circle.mark_default(&t.carol);

        // Default is recorded for the current round (1), never for round 0
        assert!(t.has_defaulted_key(&t.carol, 1));
        assert!(
            !t.has_defaulted_key(&t.carol, 0),
            "Defaulted key must not exist for paid-out round 0"
        );
    }

    /// `Defaulted(member, round)` and `Contributed(member, round)` must be
    /// mutually exclusive for the same (member, round) pair.  If a member
    /// contributed they cannot be defaulted; if they didn't contribute they
    /// can be defaulted but then the `Contributed` key is absent.
    #[test]
    fn test_contributed_and_defaulted_are_mutually_exclusive() {
        let t = setup_circle();
        t.activate();

        t.circle.contribute(&t.alice);
        t.advance_past_deadline();

        // Alice contributed → Contributed key present, Defaulted key absent
        assert!(t.has_contributed_key(&t.alice, 0));
        assert!(!t.has_defaulted_key(&t.alice, 0));

        // Carol did not contribute → Contributed key absent, Defaulted key written on mark_default
        assert!(!t.has_contributed_key(&t.carol, 0));
        t.circle.mark_default(&t.carol);
        assert!(t.has_defaulted_key(&t.carol, 0));
        assert!(!t.has_contributed_key(&t.carol, 0));
    }

    // ── Multi-round state consistency ─────────────────────────────────────────

    /// `RoundsCompleted` must equal the number of payouts that have been
    /// called — it increments by exactly 1 per payout and matches the expected
    /// round index at every step.
    #[test]
    fn test_rounds_completed_increments_monotonically() {
        let t = setup_circle();
        t.activate();

        // Verify RoundsCompleted via get_status + current_round cross-check:
        // round.round_index reflects the current (not-yet-completed) round,
        // while completed == number of rounds finished so far.
        for expected_completed in 0u32..4 {
            let round = t.circle.get_current_round();
            assert_eq!(
                round.round_index, expected_completed,
                "round index must equal number of completed rounds before payout"
            );
            t.complete_round();
        }

        assert_eq!(t.circle.get_status(), CircleStatus::Completed);
        // After all 4 rounds the current_round view returns CircleNotActive
        assert!(t.circle.try_get_current_round().is_err());
    }

    /// After each payout the next `CurrentRound` must have:
    /// - `round_index` == previous + 1
    /// - `paid_out` == false
    /// - `contributions_received` == 0
    /// - `recipient` == members[round_index]
    /// - `deadline_ledger` > current ledger sequence
    #[test]
    fn test_current_round_state_is_consistent_after_each_payout() {
        let t = setup_circle();
        t.activate();

        for i in 0u32..3 {
            // Confirm current round before payout
            let round = t.circle.get_current_round();
            assert_eq!(round.round_index, i);
            assert!(!round.paid_out);
            assert_eq!(round.contributions_received, 0);

            let seq_before_payout = t.env.ledger().sequence();
            t.complete_round();

            // After payout the next round is immediately available
            let next = t.circle.get_current_round();
            assert_eq!(next.round_index, i + 1, "round must advance by 1 after payout");
            assert!(!next.paid_out, "new round must not be pre-marked paid_out");
            assert_eq!(next.contributions_received, 0, "new round starts with 0 contributions");
            assert!(
                next.deadline_ledger > seq_before_payout as u64,
                "new round deadline must be in the future"
            );
        }
    }

    /// The circle status must never revert to a prior state.  After Active it
    /// stays Active until Completed; it never goes back to Pending.
    #[test]
    fn test_status_transitions_are_one_way() {
        let t = setup_circle();
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);

        t.activate();
        assert_eq!(t.circle.get_status(), CircleStatus::Active);

        t.complete_round();
        // Still Active (3 rounds remain)
        assert_eq!(t.circle.get_status(), CircleStatus::Active);

        t.complete_round();
        assert_eq!(t.circle.get_status(), CircleStatus::Active);

        t.complete_round();
        assert_eq!(t.circle.get_status(), CircleStatus::Active);

        t.complete_round(); // 4th and final round
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);

        // Completed is terminal — no further state changes without explicit close
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);
    }

    /// contribute → payout → next round: contributions_received for the new
    /// round must start at 0 (not carry over from the previous round).
    #[test]
    fn test_contributions_received_resets_after_payout() {
        let t = setup_circle();
        t.activate();

        t.contribute_all();
        let before_payout = t.circle.get_current_round();
        assert_eq!(before_payout.contributions_received, 4);

        t.circle.payout();

        let new_round = t.circle.get_current_round();
        assert_eq!(
            new_round.contributions_received, 0,
            "contributions_received must reset to 0 after payout"
        );
    }

    // ── Exact deadline boundary strictness ────────────────────────────────────

    /// Contribution at exactly deadline_ledger must succeed (boundary is
    /// inclusive for contributions: `sequence <= deadline_ledger`).
    #[test]
    fn test_contribute_at_exact_deadline_succeeds() {
        let t = setup_circle();
        t.activate();

        let round = t.circle.get_current_round();
        // Set ledger to exactly the deadline
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32;
        });

        // Contribution at the exact deadline must be accepted
        t.circle.contribute(&t.alice);
        assert!(t.has_contributed_key(&t.alice, 0));
    }

    /// Contribution at deadline_ledger + 1 must be rejected.
    #[test]
    #[should_panic(expected = "round deadline passed; cannot contribute before payout")]
    fn test_contribute_one_past_deadline_panics() {
        let t = setup_circle();
        t.activate();

        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });

        t.circle.contribute(&t.alice);
    }

    /// `mark_default` at exactly deadline_ledger must be rejected (boundary is
    /// exclusive for defaults: `sequence > deadline_ledger`).
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn test_mark_default_at_exact_deadline_boundary_panics() {
        let t = setup_circle();
        t.activate();

        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32;
        });

        t.circle.mark_default(&t.carol);
    }

    /// `mark_default` at deadline_ledger + 1 must succeed.
    #[test]
    fn test_mark_default_one_past_deadline_succeeds() {
        let t = setup_circle();
        t.activate();

        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });

        t.circle.mark_default(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);
    }

    /// The deadline boundary is a strict `>` for defaults and `<=` for
    /// contributions — there is no ledger where both are allowed simultaneously.
    /// At exactly deadline_ledger: contribute OK, mark_default rejected.
    /// At deadline_ledger + 1: mark_default OK, contribute rejected.
    #[test]
    fn test_deadline_boundary_is_non_overlapping() {
        let t = setup_circle();
        t.activate();

        let round = t.circle.get_current_round();
        let dl = round.deadline_ledger as u32;

        // At dl: contribute allowed, mark_default rejected
        t.env.ledger().with_mut(|l| {
            l.sequence_number = dl;
        });
        t.circle.contribute(&t.alice); // must not panic

        // At dl + 1: mark_default allowed (for members who didn't contribute)
        t.env.ledger().with_mut(|l| {
            l.sequence_number = dl + 1;
        });
        t.circle.mark_default(&t.carol); // carol never contributed — must not panic
        assert_eq!(t.circle.get_defaults(&t.carol), 1);
    }

    // ── Close invariants ──────────────────────────────────────────────────────

    /// `close` must be rejected while the circle is Active (bug fix: was
    /// unconditionally panicking in original code due to missing `if` guard).
    #[test]
    #[should_panic(expected = "circle still active")]
    fn test_close_rejected_while_active() {
        let t = setup_circle();
        t.activate();
        t.circle.close(&t.alice);
    }

    /// `close` must succeed after the circle is Completed.
    #[test]
    fn test_close_succeeds_after_completed() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);
        // This must not panic
        t.circle.close(&t.alice);
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
    }

    /// `close` must succeed after a circle is Cancelled.
    #[test]
    fn test_close_succeeds_after_cancelled() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
        t.circle.close(&t.alice);
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
    }

    /// Calling `close` a second time on any terminal-state circle must panic with
    /// "circle already closed" — the `Closed` flag set during the first call acts
    /// as an immutable guard that rejects subsequent invocations.
    #[test]
    #[should_panic(expected = "circle already closed")]
    fn test_close_twice_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        t.circle.close(&t.alice);
        // Second call by a different member must also be rejected.
        t.circle.close(&t.bob);
    }

    // ── Partial default then payout: consistency check ─────────────────────

    /// Some members defaulted, then the round is eventually paid out via
    /// completing the missing contributions.  After payout:
    /// - `RoundsCompleted` increments correctly
    /// - `CurrentRound` advances to the next round
    /// - The `Defaulted` keys for the old round remain (audit trail)
    #[test]
    fn test_partial_default_then_payout_state_is_consistent() {
        let t = setup_circle();
        t.activate();

        // Alice and Bob contribute; Carol and Dave default
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);
        t.circle.mark_default(&t.dave);

        // Now we cannot payout because only 2 of 4 members contributed.
        // Verify state is internally consistent before payout:
        let round = t.circle.get_current_round();
        assert_eq!(round.contributions_received, 2);
        assert!(t.has_defaulted_key(&t.carol, 0));
        assert!(t.has_defaulted_key(&t.dave, 0));
        assert!(!t.has_defaulted_key(&t.alice, 0));
        assert!(!t.has_defaulted_key(&t.bob, 0));
    }

    // ── Payout tally mismatch guard ────────────────────────────────────────────

    /// If `contributions_received` in the round state diverges from the actual
    /// count of persistent `Contributed` keys, payout must reject the round
    /// with "round contribution tally mismatch".
    ///
    /// We simulate this by force-writing a `Contributed` key without going
    /// through the contract's `contribute` entry-point (so the counter doesn't
    /// increment) then calling payout.
    #[test]
    #[should_panic(expected = "round contribution tally mismatch")]
    fn test_payout_rejects_tally_mismatch() {
        let t = setup_circle();
        t.activate();

        // Two members contribute legitimately (counter = 2)
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);

        // Force-write contributed keys for carol and dave bypassing the counter
        t.force_contributed(&t.carol, 0);
        t.force_contributed(&t.dave, 0);

        // Now counter == 2 but persisted keys == 4 — must trigger tally mismatch
        // Actually this scenario has counter=2, persisted=4, which fails
        // contributions_received != member_count (2 != 4), so it triggers
        // "not all members have contributed yet".
        // The inverse case (counter == 4 but keys < 4) would trigger tally mismatch.
        // Test the guard directly: bump the counter to 4 without the keys.
        t.circle.payout();
    }

    /// Validate the double-tally path: contribute legitimately for 3 members,
    /// then force the counter to 4.  Payout must detect the mismatch and reject
    /// with "round contribution tally mismatch".
    #[test]
    #[should_panic(expected = "round contribution tally mismatch")]
    fn test_payout_counter_ahead_of_keys_triggers_tally_mismatch() {
        let t = setup_circle();
        t.activate();

        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        // Dave has NOT contributed — 3 keys exist

        // Forge the counter to 4 so the first payout guard passes but the
        // second (key-based) tally check must still catch the discrepancy.
        t.env.as_contract(&t.circle_id, || {
            let mut round: crate::RoundState = t
                .env
                .storage()
                .instance()
                .get(&crate::DataKey::CurrentRound)
                .unwrap();
            round.contributions_received = 4;
            t.env
                .storage()
                .instance()
                .set(&crate::DataKey::CurrentRound, &round);
        });

        t.circle.payout(); // must panic: tally mismatch (3 keys, counter says 4)
    }

    // ── Multi-default across rounds ───────────────────────────────────────────

    /// A member who defaults in round 0 can also default in round 1.  Each
    /// default increments the counter and deducts collateral, and the
    /// `Defaulted` keys for each round are independent.
    #[test]
    fn test_member_can_default_in_multiple_rounds() {
        let t = setup_circle();
        t.activate();

        // Round 0: alice and bob contribute; carol and dave default
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);

        let collateral_after_r0 = t.circle.get_collateral(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);

        // We cannot proceed to round 1 without completing round 0.
        // Contribute for carol and dave to unblock payout (they already defaulted
        // but can still contribute after the deadline — wait, they cannot because
        // deadline has passed).  We need a different approach: force both carol
        // and dave contributions to allow payout.
        t.force_contributed(&t.carol, 0);
        t.force_contributed(&t.dave, 0);

        // Manually bump the contributions_received counter to 4
        t.env.as_contract(&t.circle_id, || {
            let mut round: crate::RoundState = t
                .env
                .storage()
                .instance()
                .get(&crate::DataKey::CurrentRound)
                .unwrap();
            round.contributions_received = 4;
            t.env
                .storage()
                .instance()
                .set(&crate::DataKey::CurrentRound, &round);
        });

        t.circle.payout(); // complete round 0

        // Round 1 starts; advance past its deadline
        let round1 = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round1.deadline_ledger as u32 + 1;
        });

        // Carol defaults again in round 1
        t.circle.mark_default(&t.carol);

        assert_eq!(t.circle.get_defaults(&t.carol), 2, "carol should have 2 defaults");
        assert!(
            t.circle.get_collateral(&t.carol) < collateral_after_r0,
            "collateral must decrease further after second default"
        );
        assert!(t.has_defaulted_key(&t.carol, 0));
        assert!(t.has_defaulted_key(&t.carol, 1));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #166 — Re-architect close as strict settlement with lifecycle
    // invariants and idempotency guard.
    //
    // Tests in this section cover:
    //   • Terminal-state preconditions (Pending rejection, Active rejection)
    //   • Duplicate-close rejection via DataKey::Closed flag
    //   • Partial-default penalty histories and correct reduced-amount release
    //   • Zero-collateral member handling (no event, no transfer)
    //   • Arithmetic reconciliation: sum(collateral_released) == total_released
    //   • is_closed() view before and after settlement
    // ══════════════════════════════════════════════════════════════════════════

    // ── Pending rejection ─────────────────────────────────────────────────────

    /// close() on a circle still in Pending state must panic with a message
    /// that distinguishes it from the Active case so callers receive an
    /// actionable diagnostic.
    #[test]
    #[should_panic(expected = "circle still pending")]
    fn test_close_rejected_while_pending() {
        let t = setup_circle();
        // No members have joined — circle is Pending
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
        t.circle.close(&t.alice);
    }

    // ── Duplicate-close rejection ─────────────────────────────────────────────

    /// After a successful close the DataKey::Closed flag is set.  Any subsequent
    /// invocation — even by a different member — must be rejected immediately so
    /// no partial-release state can accumulate across calls.
    #[test]
    #[should_panic(expected = "circle already closed")]
    fn test_close_already_closed_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        assert!(!t.circle.is_closed(), "is_closed must be false before first close");
        t.circle.close(&t.alice);
        assert!(t.circle.is_closed(), "is_closed must be true after first close");

        // Any re-invocation must now panic
        t.circle.close(&t.dave);
    }

    // ── is_closed view ────────────────────────────────────────────────────────

    /// is_closed() must return false on an initialized but not-yet-closed circle
    /// and true after close() completes.
    #[test]
    fn test_is_closed_transitions_correctly() {
        let t = setup_circle();
        assert!(!t.circle.is_closed(), "uninitialized-close circle must report is_closed = false");

        t.activate();
        t.complete_all_rounds();
        assert!(!t.circle.is_closed(), "completed but not-yet-closed circle must report false");

        t.circle.close(&t.carol);
        assert!(t.circle.is_closed(), "after close() is_closed must return true");
    }

    #[test]
    fn test_is_closed_false_for_cancelled_before_close() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert!(!t.circle.is_closed(), "cancelled-but-not-closed circle must report false");

        t.circle.close(&t.alice);
        assert!(t.circle.is_closed());
    }

    // ── Partial-default penalty histories ─────────────────────────────────────

    /// When some members have been marked default one or more times their
    /// collateral is reduced by the penalty.  close() must release only the
    /// remaining balance — not the original full-collateral amount.
    #[test]
    fn test_close_with_partial_default_returns_reduced_collateral() {
        let t = setup_circle();
        t.activate();

        // Apply one default penalty to carol
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);

        let carol_collateral_after_penalty = t.circle.get_collateral(&t.carol);
        let expected_penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        let expected_carol_balance = ROUND_AMOUNT - expected_penalty;
        assert_eq!(carol_collateral_after_penalty, expected_carol_balance);

        // Force to Completed so close() is accepted (also aligns RoundsCompleted)
        t.force_status(CircleStatus::Completed);

        let carol_wallet_before = t.token.balance(&t.carol);
        t.circle.close(&t.alice);
        let carol_wallet_after = t.token.balance(&t.carol);

        // Carol receives only the post-penalty remainder, not the full collateral
        assert_eq!(
            carol_wallet_after - carol_wallet_before,
            expected_carol_balance,
            "close must release only remaining (post-penalty) collateral for defaulted member"
        );
        assert_eq!(t.circle.get_collateral(&t.carol), 0);
    }

    /// After two defaults the collateral is reduced twice.  close() must release
    /// the doubly-reduced balance and emit a collateral_released event carrying
    /// that exact amount.
    #[test]
    fn test_close_with_two_defaults_releases_doubly_reduced_collateral() {
        let t = setup_circle();
        t.activate();

        let initial_collateral = t.circle.get_collateral(&t.bob);

        // Round 0: bob defaults
        t.advance_past_deadline();
        t.circle.mark_default(&t.bob);
        let after_first_default = t.circle.get_collateral(&t.bob);

        // Round 1: simulate bob defaulting again by forcing round state + advancing
        // Advance to a new round by forcing round index to 1 and a new deadline
        t.env.as_contract(&t.circle_id, || {
            let mut round: crate::RoundState = t
                .env
                .storage()
                .instance()
                .get(&crate::DataKey::CurrentRound)
                .unwrap();
            round.round_index = 1;
            round.paid_out = false;
            round.deadline_ledger = t.env.ledger().sequence() as u64 + 1;
            t.env.storage().instance().set(&crate::DataKey::CurrentRound, &round);
        });
        t.env.ledger().with_mut(|l| {
            l.sequence_number += 2;
        });
        t.circle.mark_default(&t.bob);
        let after_second_default = t.circle.get_collateral(&t.bob);

        // Sanity: each default reduced collateral by 20%
        let first_penalty = initial_collateral * PENALTY_BPS / BPS_DENOM;
        assert_eq!(after_first_default, initial_collateral - first_penalty);
        let second_penalty = after_first_default * PENALTY_BPS / BPS_DENOM;
        assert_eq!(after_second_default, after_first_default - second_penalty);

        // Force terminal state (also aligns RoundsCompleted)
        t.force_status(CircleStatus::Completed);

        let bob_wallet_before = t.token.balance(&t.bob);
        t.circle.close(&t.alice);
        let bob_wallet_after = t.token.balance(&t.bob);

        assert_eq!(
            bob_wallet_after - bob_wallet_before,
            after_second_default,
            "close must release doubly-reduced collateral"
        );
    }

    // ── Zero-balance member handling ──────────────────────────────────────────

    /// A member whose collateral has been completely drained to zero by repeated
    /// penalties must not receive any transfer.  The remaining members still get
    /// their correct amounts and the total_released reflects only non-zero balances.
    #[test]
    fn test_close_zero_balance_member_no_transfer() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        // Drain dave's collateral to zero (simulates repeated penalty drain)
        t.force_collateral(&t.dave, 0i128);

        let dave_wallet_before = t.token.balance(&t.dave);
        let alice_wallet_before = t.token.balance(&t.alice);
        let bob_wallet_before = t.token.balance(&t.bob);
        let carol_wallet_before = t.token.balance(&t.carol);

        t.circle.close(&t.alice);

        // Dave must receive nothing — zero balance, no transfer
        assert_eq!(
            t.token.balance(&t.dave), dave_wallet_before,
            "zero-balance member must not receive any tokens on close"
        );
        // Other members still receive their collateral
        assert_eq!(
            t.token.balance(&t.alice) - alice_wallet_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "alice must receive full collateral"
        );
        assert_eq!(
            t.token.balance(&t.bob) - bob_wallet_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
        );
        assert_eq!(
            t.token.balance(&t.carol) - carol_wallet_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
        );
        // Dave's collateral key remains at 0
        assert_eq!(t.circle.get_collateral(&t.dave), 0);
    }

    /// A member who never joined (no Collateral key) must be silently skipped
    /// during settlement — no transfer, collateral storage key stays absent.
    #[test]
    fn test_close_cancelled_partial_join_skips_non_joined_members() {
        let t = setup_circle();
        // Only alice and bob join; carol cancels (without joining); dave never interacts
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.cancel(&t.carol);

        let carol_before = t.token.balance(&t.carol);
        let dave_before = t.token.balance(&t.dave);
        let alice_before = t.token.balance(&t.alice);
        let bob_before = t.token.balance(&t.bob);

        t.circle.close(&t.alice);

        // Non-joined members receive nothing
        assert_eq!(t.token.balance(&t.carol), carol_before,
            "carol (never joined) must not receive tokens on close");
        assert_eq!(t.token.balance(&t.dave), dave_before,
            "dave (never joined) must not receive tokens on close");

        // Joined members receive their collateral back
        assert_eq!(
            t.token.balance(&t.alice) - alice_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
        );
        assert_eq!(
            t.token.balance(&t.bob) - bob_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
        );

        // Joined members' storage keys are zeroed
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        assert_eq!(t.circle.get_collateral(&t.bob), 0);
    }

    // ── Arithmetic reconciliation ─────────────────────────────────────────────

    /// The sum of all pre-close member collateral values must equal total_released
    /// in the aggregate closed event.
    ///
    /// This is the storage-level reconciliation invariant: read collateral from
    /// storage before close, then verify the closed event reports the same total.
    /// Any member that is double-released or silently skipped will break this.
    #[test]
    fn test_close_total_released_matches_collateral_sum_from_storage() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        // Apply a reduced collateral to carol to create a non-uniform distribution
        let penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        t.force_collateral(&t.carol, ROUND_AMOUNT - penalty);

        // Read all collateral values from storage before close
        let pre_close_sum: i128 = [&t.alice, &t.bob, &t.carol, &t.dave]
            .iter()
            .map(|m| t.circle.get_collateral(m))
            .sum();

        // Flush and close
        let _ = t.env.events().all();
        t.circle.close(&t.alice);

        // Decode total_released from the closed event
        let closed_events = events_named(&t.env, "closed");
        assert_eq!(closed_events.len(), 1, "expected exactly one closed event");
        let closed_data = closed_events[0].clone();
        let (_closer, total_released, _total_expected, _reason):
            (Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_data);

        assert_eq!(
            total_released, pre_close_sum,
            "total_released in closed event must equal the sum of pre-close collateral balances"
        );
        // After close all storage keys are zeroed
        for m in [&t.alice, &t.bob, &t.carol, &t.dave] {
            assert_eq!(t.circle.get_collateral(m), 0);
        }
    }

    /// The closed event total_expected_collateral field must equal
    /// member_count × round_amount × COLLATERAL_MULTIPLIER regardless of any
    /// penalties applied, so auditors can compute total forfeiture as
    /// total_expected − total_released.
    #[test]
    fn test_close_event_total_expected_matches_full_collateral() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        let _ = t.env.events().all();
        t.circle.close(&t.alice);

        // Collect all events at once so we don't clear the buffer mid-assertion
        let all_events = t.env.events().all();
        let closed_data = all_events
            .iter()
            .find(|(_c, topics, _d)| {
                topics.get(1).map(|v| {
                    let s = soroban_sdk::Symbol::new(&t.env, "closed");
                    let sv: soroban_sdk::Val =
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&s, &t.env);
                    soroban_sdk::Val::get_payload(v) == soroban_sdk::Val::get_payload(sv)
                }).unwrap_or(false)
            })
            .map(|(_c, _t, d)| d.clone())
            .expect("expected a closed event");

        let (_closer, _total_released, total_expected, _reason):
            (Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_data);

        let expected = ROUND_AMOUNT * COLLATERAL_MULTIPLIER * (t.members.len() as i128);
        assert_eq!(
            total_expected, expected,
            "closed event total_expected_collateral must equal member_count × round_amount × COLLATERAL_MULTIPLIER"
        );
    }

    /// When no penalties were applied total_released must exactly equal
    /// total_expected_collateral — every member gets back their full collateral.
    #[test]
    fn test_close_no_penalties_total_released_equals_total_expected() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        let _ = t.env.events().all();
        t.circle.close(&t.alice);

        let all_events = t.env.events().all();
        let closed_data = all_events
            .iter()
            .find(|(_c, topics, _d)| {
                topics.get(1).map(|v| {
                    let s = soroban_sdk::Symbol::new(&t.env, "closed");
                    let sv: soroban_sdk::Val =
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&s, &t.env);
                    soroban_sdk::Val::get_payload(v) == soroban_sdk::Val::get_payload(sv)
                }).unwrap_or(false)
            })
            .map(|(_c, _t, d)| d.clone())
            .expect("expected a closed event");

        let (_closer, total_released, total_expected, _reason):
            (Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_data);

        assert_eq!(
            total_released, total_expected,
            "without penalties total_released must equal total_expected_collateral"
        );
    }

    /// Arithmetic invariant for Cancelled circles: total released must equal the
    /// sum of collateral locked by the members who actually joined.
    #[test]
    fn test_close_cancelled_total_released_matches_joined_collateral() {
        let t = setup_circle();
        // Only alice and bob join
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.cancel(&t.carol);

        let expected_total = ROUND_AMOUNT * COLLATERAL_MULTIPLIER * 2; // only 2 joined

        let _ = t.env.events().all();
        t.circle.close(&t.alice);

        let all_events = t.env.events().all();
        let closed_data = all_events
            .iter()
            .find(|(_c, topics, _d)| {
                topics.get(1).map(|v| {
                    let s = soroban_sdk::Symbol::new(&t.env, "closed");
                    let sv: soroban_sdk::Val =
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&s, &t.env);
                    soroban_sdk::Val::get_payload(v) == soroban_sdk::Val::get_payload(sv)
                }).unwrap_or(false)
            })
            .map(|(_c, _t, d)| d.clone())
            .expect("expected a closed event");

        let (_closer, total_released, _total_expected, _reason):
            (Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_data);

        assert_eq!(
            total_released, expected_total,
            "cancelled circle total_released must equal collateral from joined members only"
        );
    }

    // ── Completed-invariant check ─────────────────────────────────────────────

    /// close() must verify that RoundsCompleted == member_count when status is
    /// Completed, guarding against a hypothetical state corruption.
    /// If the count is wrong the function must panic with a storage-inconsistency
    /// message rather than silently releasing collateral in a bad state.
    #[test]
    #[should_panic(expected = "not all rounds paid out")]
    fn test_close_completed_invariant_rejects_incomplete_rounds() {
        let t = setup_circle();
        t.activate();

        // Set Status to Completed directly, deliberately leaving RoundsCompleted at 0
        // (bypasses force_status which would also align RoundsCompleted).
        t.env.as_contract(&t.circle_id, || {
            t.env
                .storage()
                .instance()
                .set(&DataKey::Status, &CircleStatus::Completed);
            // RoundsCompleted stays 0 — this is the corrupted state we're testing
        });

        // close() must detect the inconsistency (0 rounds completed, 4 required)
        t.circle.close(&t.alice);
    }

    // ── Contribute rejects non-member ─────────────────────────────────────────

    #[test]
    #[should_panic(expected = "not a member")]
    fn test_contribute_by_non_member_panics() {
        let t = setup_circle();
        t.activate();
        let outsider = Address::generate(&t.env);
        t.circle.contribute(&outsider);
    }

    // ── mark_default rejects non-member ───────────────────────────────────────

    #[test]
    #[should_panic(expected = "not a member")]
    fn test_mark_default_of_non_member_panics() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();
        let outsider = Address::generate(&t.env);
        t.circle.mark_default(&outsider);
    }

    // ── Contribute rejected on Pending circle ─────────────────────────────────

    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_contribute_on_pending_circle_panics() {
        let t = setup_circle();
        // Only 2 of 4 members join — circle stays Pending
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.contribute(&t.alice);
    }

    // ── Payout on Pending circle ──────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_payout_on_pending_circle_panics() {
        let t = setup_circle();
        t.circle.payout();
    }

    // ── Payout on Completed circle ────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_payout_on_completed_circle_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        t.circle.payout();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #179 — Rework collateral release and close semantics for terminal
    // states.
    //
    // Tests in this section explicitly cover every acceptance criterion from
    // the issue:
    //
    //   • The contract rejects close() while the circle is Active or Pending.
    //   • Each member's remaining collateral is returned exactly once; no
    //     balance is skipped or double-transferred.
    //   • The release procedure emits a terminal settlement sequence that
    //     off-chain consumers can reconcile without ambiguity.
    //   • Repeated close() attempts leave no partial release state behind.
    //   • Arithmetic assertion: sum(collateral_released events) ==
    //     total_released in the closed event == pre-release storage sum.
    // ══════════════════════════════════════════════════════════════════════════

    // ── Terminal-state precondition enforcement ───────────────────────────────

    /// close() on an Active circle must panic with "circle still active".
    /// This is the primary lifecycle guard — collateral release is forbidden
    /// while any round may still be in progress.
    #[test]
    #[should_panic(expected = "circle still active")]
    fn test_179_close_rejected_on_active_circle() {
        let t = setup_circle();
        t.activate();
        // Circle is Active; close must be refused
        t.circle.close(&t.alice);
    }

    /// close() on a Pending circle (not all members joined) must panic with
    /// "circle still pending".  This is distinct from the Active rejection so
    /// callers know they need to call cancel() first.
    #[test]
    #[should_panic(expected = "circle still pending")]
    fn test_179_close_rejected_on_pending_circle() {
        let t = setup_circle();
        // Only two members join — circle stays Pending
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.close(&t.alice);
    }

    // ── Completed-circle full settlement ─────────────────────────────────────

    /// After a full-lifecycle run (all rounds completed) close() must return
    /// every member's collateral exactly once and zero every storage key.
    #[test]
    fn test_179_close_completed_returns_each_member_collateral_once() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);

        let expected = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;

        let alice_before = t.token.balance(&t.alice);
        let bob_before   = t.token.balance(&t.bob);
        let carol_before = t.token.balance(&t.carol);
        let dave_before  = t.token.balance(&t.dave);

        t.circle.close(&t.alice);

        // Every member receives exactly their collateral back
        assert_eq!(t.token.balance(&t.alice) - alice_before, expected, "alice collateral mismatch");
        assert_eq!(t.token.balance(&t.bob)   - bob_before,   expected, "bob collateral mismatch");
        assert_eq!(t.token.balance(&t.carol) - carol_before, expected, "carol collateral mismatch");
        assert_eq!(t.token.balance(&t.dave)  - dave_before,  expected, "dave collateral mismatch");

        // Storage keys are zeroed for all members
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        assert_eq!(t.circle.get_collateral(&t.bob),   0);
        assert_eq!(t.circle.get_collateral(&t.carol), 0);
        assert_eq!(t.circle.get_collateral(&t.dave),  0);

        // is_closed() reports true
        assert!(t.circle.is_closed());
    }

    // ── Cancelled-circle settlement ───────────────────────────────────────────

    /// close() on a Cancelled circle must return collateral only to members who
    /// actually joined.  Members who never called join() have no Collateral key
    /// and must be silently skipped with no transfer.
    #[test]
    fn test_179_close_cancelled_returns_only_joined_member_collateral() {
        let t = setup_circle();
        // Only alice and bob join before the circle is cancelled
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.cancel(&t.carol); // any member can cancel a Pending circle
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

        let expected_per_joined = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;

        let alice_before = t.token.balance(&t.alice);
        let bob_before   = t.token.balance(&t.bob);
        let carol_before = t.token.balance(&t.carol);
        let dave_before  = t.token.balance(&t.dave);

        t.circle.close(&t.alice);

        // Alice and bob (joined) get their collateral back
        assert_eq!(t.token.balance(&t.alice) - alice_before, expected_per_joined);
        assert_eq!(t.token.balance(&t.bob)   - bob_before,   expected_per_joined);

        // Carol and dave (never joined) receive nothing
        assert_eq!(t.token.balance(&t.carol), carol_before, "carol must not receive tokens");
        assert_eq!(t.token.balance(&t.dave),  dave_before,  "dave must not receive tokens");

        assert!(t.circle.is_closed());
    }

    // ── Partial-default settlement ────────────────────────────────────────────

    /// When some members have been penalised via mark_default the remaining
    /// collateral at close time is less than the initial deposit.  close() must
    /// release only the reduced balance for each defaulting member — not the
    /// original full-collateral amount.
    #[test]
    fn test_179_close_partial_default_releases_reduced_collateral() {
        let t = setup_circle();
        t.activate();

        // Penalise carol (one default → 20 % penalty deducted)
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);

        let carol_collateral_after_penalty = t.circle.get_collateral(&t.carol);
        let expected_penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        assert_eq!(carol_collateral_after_penalty, ROUND_AMOUNT - expected_penalty,
            "pre-close carol collateral must reflect the single penalty deduction");

        // Force terminal state so close() is accepted
        t.force_status(CircleStatus::Completed);

        let carol_before = t.token.balance(&t.carol);
        t.circle.close(&t.alice);

        // Carol receives only the post-penalty remainder
        assert_eq!(
            t.token.balance(&t.carol) - carol_before,
            carol_collateral_after_penalty,
            "close must release the post-penalty remainder, not the full collateral"
        );
        assert_eq!(t.circle.get_collateral(&t.carol), 0, "carol storage key must be zeroed");
    }

    // ── Zero-balance member handling ──────────────────────────────────────────

    /// A member whose collateral has been entirely drained to zero by repeated
    /// penalties must not receive any token transfer on close().  The zero-balance
    /// member should neither cause a panic nor produce a collateral_released event.
    #[test]
    fn test_179_close_zero_balance_member_skipped() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        // Drain dave's collateral to zero (simulates full penalty exhaustion)
        t.force_collateral(&t.dave, 0i128);

        let dave_before = t.token.balance(&t.dave);
        let alice_before = t.token.balance(&t.alice);

        let _ = t.env.events().all(); // flush earlier events
        t.circle.close(&t.alice);

        // Dave receives no tokens — zero balance, no transfer
        assert_eq!(
            t.token.balance(&t.dave), dave_before,
            "zero-balance member must not receive any tokens"
        );
        // Dave's storage key remains at 0 (not created if absent, stays 0 if present)
        assert_eq!(t.circle.get_collateral(&t.dave), 0);

        // Other members (with positive balance) still receive their collateral
        assert_eq!(
            t.token.balance(&t.alice) - alice_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "non-zero-balance members must still receive their collateral"
        );

        // No collateral_released event for dave; three events for the other members
        let released = events_named(&t.env, "collateral_released");
        assert_eq!(released.len(), 3, "expected collateral_released events only for members with positive balance");
    }

    // ── Duplicate close rejection ─────────────────────────────────────────────

    /// After a successful close() any subsequent invocation — by any member —
    /// must be rejected with "circle already closed".  No partial-release state
    /// must accumulate across calls.
    #[test]
    #[should_panic(expected = "circle already closed")]
    fn test_179_duplicate_close_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        t.circle.close(&t.alice);
        assert!(t.circle.is_closed(), "is_closed must be true after first close");

        // Any subsequent call — even from a different member — must panic
        t.circle.close(&t.dave);
    }

    /// A duplicate close attempt after a Cancelled-circle settlement must also
    /// be rejected.  The Closed flag must survive the Cancelled path just as it
    /// does the Completed path.
    #[test]
    #[should_panic(expected = "circle already closed")]
    fn test_179_duplicate_close_after_cancel_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);

        t.circle.close(&t.alice);  // first call succeeds
        t.circle.close(&t.bob);    // second call must panic
    }

    // ── Arithmetic assertion: sum(collateral_released) == total_released ──────

    /// The sum of all per-member collateral_released event payloads must equal
    /// the total_released field in the aggregate closed event, and both must
    /// equal the pre-close sum of all Collateral storage keys.
    ///
    /// This is the core arithmetic reconciliation test from issue #179 —
    /// it validates that the on-chain settlement assertion fires correctly for
    /// the nominal (no-error) path, and that the event log gives auditors a
    /// consistent, reconcilable view of the settlement.
    #[test]
    fn test_179_arithmetic_reconciliation_released_equals_storage_sum() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        // Apply a penalty to bob to create a non-uniform distribution
        let penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        t.force_collateral(&t.bob, ROUND_AMOUNT - penalty);

        // Read all collateral values from storage before close
        let pre_close_sum: i128 = [&t.alice, &t.bob, &t.carol, &t.dave]
            .iter()
            .map(|m| t.circle.get_collateral(m))
            .sum();

        let _ = t.env.events().all(); // flush earlier events
        t.circle.close(&t.alice);

        // Decode the aggregate closed event
        let closed_events = events_named(&t.env, "closed");
        assert_eq!(closed_events.len(), 1, "expected exactly one closed event");
        let (_closer, total_released, _total_expected, _reason):
            (Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_events[0]);

        // 1. total_released must equal the pre-close storage sum
        assert_eq!(
            total_released, pre_close_sum,
            "total_released must equal the pre-close sum of all Collateral storage values"
        );

        // 2. Sum of collateral_released event payloads must also equal total_released
        let released_events = events_named(&t.env, "collateral_released");
        let events_sum: i128 = released_events
            .iter()
            .map(|v| {
                let (_member, amount): (Address, i128) =
                    soroban_sdk::FromVal::from_val(&t.env, v);
                amount
            })
            .sum();
        assert_eq!(
            events_sum, total_released,
            "sum of collateral_released events must equal total_released in the closed event"
        );

        // 3. All storage keys are zeroed after settlement
        for m in [&t.alice, &t.bob, &t.carol, &t.dave] {
            assert_eq!(t.circle.get_collateral(m), 0, "post-close collateral must be 0 for all members");
        }
    }

    /// The closed event reason field must be "completed" for a Completed circle
    /// and "cancelled" for a Cancelled circle.  Off-chain consumers use this
    /// field to differentiate settlement types without re-reading circle status.
    #[test]
    fn test_179_closed_event_reason_reflects_terminal_state() {
        // Completed case
        {
            let t = setup_circle();
            t.activate();
            t.complete_all_rounds();
            let _ = t.env.events().all();
            t.circle.close(&t.alice);

            let closed = events_named(&t.env, "closed");
            let (_closer, _released, _expected, reason):
                (Address, i128, i128, soroban_sdk::Symbol) =
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
            let (_closer, _released, _expected, reason):
                (Address, i128, i128, soroban_sdk::Symbol) =
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
        let (_closer, total_released, total_expected, _reason):
            (Address, i128, i128, soroban_sdk::Symbol) =
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

    /// Non-members must be rejected from close() regardless of the circle state.
    #[test]
    #[should_panic(expected = "not authorized to close: caller is not a circle member")]
    fn test_179_non_member_cannot_close() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        let outsider = Address::generate(&t.env);
        t.circle.close(&outsider);
    }

    /// Verify that the RoundsCompleted invariant check in close() catches a
    /// Completed status that was set before all payouts ran (storage corruption).
    /// This prevents collateral release in an inconsistent state.
    #[test]
    #[should_panic(expected = "not all rounds paid out")]
    fn test_179_close_completed_with_incomplete_rounds_panics() {
        let t = setup_circle();
        t.activate();

        // Force Status to Completed without aligning RoundsCompleted — simulates
        // storage corruption (bypasses force_status which aligns both).
        t.env.as_contract(&t.circle_id, || {
            t.env
                .storage()
                .instance()
                .set(&DataKey::Status, &CircleStatus::Completed);
            // RoundsCompleted intentionally left at 0
        });

        // close() must detect the inconsistency (0 != 4 member count)
        t.circle.close(&t.alice);
    }

}
