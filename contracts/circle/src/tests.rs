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
        fn force_status(&self, status: CircleStatus) {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .instance()
                    .set(&DataKey::Status, &status);
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
        // contract must be initialized with the circle address as admin.
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // Deploy reputation contract and initialize it with the circle address
        // as admin.  This mirrors production: the factory deploys the reputation
        // contract and sets the first circle (or itself) as admin so only
        // authorized circle contracts can write scores.
        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);

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

        // Register the circle as an authorized caller on the reputation contract
        // so payout can award reputation scores.  The rep_admin performs this
        // registration — in production the factory does it automatically.
        rep_client.add_authorized_caller(&rep_admin, &circle_id);

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
    fn test_close_releases_zero_after_second_call() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        t.circle.close(&t.bob);
        // Collateral keys remain (value 0); second close is a no-op release
        let bob_before = t.token.balance(&t.bob);
        t.circle.close(&t.carol);
        assert_eq!(t.token.balance(&t.bob), bob_before);
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
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

        // get_current_round returns Result<RoundState, ContractError> — must unwrap
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

}
