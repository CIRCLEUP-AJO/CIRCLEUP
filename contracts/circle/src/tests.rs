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
        CircleContract, CircleContractClient, CircleStatus, CloseError, DataKey, InitError,
        COLLATERAL_MULTIPLIER, MAX_MEMBERS, MAX_ROUND_DEADLINE_LEDGERS, MIN_ROUND_DEADLINE_LEDGERS,
        PENALTY_BPS, BPS_DENOM,
    };
    use reputation::{ReputationContract, ReputationContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    pub const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC in stroops (7 decimals)
    pub const ROUND_DEADLINE: u32 = 1_000; // ledgers


    // ── TestSetup ─────────────────────────────────────────────────────────────

    pub struct TestSetup<'a> {
        pub env: Env,
        pub circle: CircleContractClient<'a>,
        pub circle_id: Address,
        pub token: TokenClient<'a>,
        pub token_address: Address,
        pub reputation_id: Address,
        #[allow(dead_code)]
        pub members: soroban_sdk::Vec<Address>,
        pub alice: Address,
        pub bob: Address,
        pub carol: Address,
        pub dave: Address,
        /// Address with pause/resume authority over this circle.
        pub circle_admin: Address,
    }

    impl<'a> TestSetup<'a> {
        // ── Type-safe test-action wrappers ────────────────────────────────────

        /// Have every member call `join`; the circle transitions to Active once
        /// the last member joins.
        pub fn activate(&self) {
            self.circle.join(&self.alice);
            self.circle.join(&self.bob);
            self.circle.join(&self.carol);
            self.circle.join(&self.dave);
        }

        /// All 4 members contribute for the **current** round.
        ///
        /// Panics (via the contract) if any member has already contributed or
        /// if the round deadline has passed.
        pub fn contribute_all(&self) {
            self.circle.contribute(&self.alice);
            self.circle.contribute(&self.bob);
            self.circle.contribute(&self.carol);
            self.circle.contribute(&self.dave);
        }

        /// Contribute + payout for the current round.
        ///
        /// Returns the round index that was just completed.
        pub fn complete_round(&self) -> u32 {
            let round = self.circle.get_current_round();
            let idx = round.round_index;
            self.contribute_all();
            self.circle.payout();
            idx
        }

        /// Drive the circle through **all** N rounds until status == Completed.
        pub fn complete_all_rounds(&self) {
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
        pub fn force_status(&self, status: CircleStatus) {
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
        pub fn force_collateral(&self, member: &Address, amount: i128) {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Collateral(member.clone()), &amount);
            });
        }

        /// Advance the test ledger sequence past the current round deadline so
        /// `mark_default` / late-contribution guard triggers correctly.
        pub fn advance_past_deadline(&self) {
            self.env.ledger().with_mut(|l| {
                l.sequence_number += ROUND_DEADLINE + 1;
            });
        }
    }


    // ── Fixtures ──────────────────────────────────────────────────────────────

    pub fn setup_circle() -> TestSetup<'static> {
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

        // Circle admin — the address with pause/resume authority
        let circle_admin = Address::generate(&env);

        let mut members = Vec::new(&env);
        members.push_back(alice.clone());
        members.push_back(bob.clone());
        members.push_back(carol.clone());
        members.push_back(dave.clone());

        circle.initialize(
            &circle_admin,
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
            circle_admin,
        }
    }

    /// Minimal fixture: env + USDC token + reputation contract, no circle.
    ///
    /// Used by tests that deploy their own circle instance to verify
    /// initialization edge-cases without interference from `setup_circle`.
    pub fn setup_env_with_token_and_reputation() -> (Env, Address, Address) {
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



    // -- Test submodules (split from the original 5768-line tests.rs) -----
    #[path = "tests/lifecycle_a.rs"] mod lifecycle_a;
    #[path = "tests/lifecycle_b.rs"] mod lifecycle_b;
    #[path = "tests/lifecycle_c.rs"] mod lifecycle_c;
    #[path = "tests/payout_a.rs"] mod payout_a;
    #[path = "tests/payout_b.rs"] mod payout_b;
    #[path = "tests/payout_c.rs"] mod payout_c;
    #[path = "tests/default_a.rs"] mod default_a;
    #[path = "tests/default_b.rs"] mod default_b;
    #[path = "tests/close_a.rs"] mod close_a;
    #[path = "tests/close_b.rs"] mod close_b;
    #[path = "tests/misc_a.rs"] mod misc_a;
    #[path = "tests/misc_b.rs"] mod misc_b;
    #[path = "tests/misc_c.rs"] mod misc_c;
}