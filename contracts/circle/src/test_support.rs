//! Shared fixture for the issue-scoped test modules:
//! `join_order_tests` (#572), `event_namespace_tests` (#566),
//! `error_path_tests` (#567) and `transfer_failure_tests` (#573).
//!
//! Mirrors the `setup_circle` fixture in `tests.rs` (4 funded members, a real
//! Stellar Asset Contract as USDC, a real reputation contract with this circle
//! registered as an authorized caller) but also exposes the asset-admin client
//! so tests can burn, re-mint and de-authorize balances to drive token-transfer
//! failures.

#![cfg(test)]
extern crate std;

use crate::{CircleContract, CircleContractClient, COLLATERAL_MULTIPLIER};
use reputation::{ReputationContract, ReputationContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events, IssuerFlags, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Val, Vec,
};

pub const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC in stroops
pub const ROUND_DEADLINE: u32 = 1_000; // ledgers
pub const COLLATERAL: i128 = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;

pub struct Fixture<'a> {
    pub env: Env,
    pub circle: CircleContractClient<'a>,
    pub circle_id: Address,
    pub token: TokenClient<'a>,
    pub asset: StellarAssetClient<'a>,
    pub rep: ReputationContractClient<'a>,
    pub rep_id: Address,
    pub rep_admin: Address,
    pub admin: Address,
    /// Configured rotation order: alice (round 0), bob, carol, dave.
    pub members: Vec<Address>,
    pub alice: Address,
    pub bob: Address,
    pub carol: Address,
    pub dave: Address,
}

impl<'a> Fixture<'a> {
    pub fn member(&self, i: u32) -> Address {
        self.members.get(i).unwrap()
    }

    pub fn join_all(&self) {
        for m in self.members.iter() {
            self.circle.join(&m);
        }
    }

    pub fn contribute_all(&self) {
        for m in self.members.iter() {
            self.circle.contribute(&m);
        }
    }

    pub fn advance_past_deadline(&self) {
        self.env
            .ledger()
            .with_mut(|l| l.sequence_number += ROUND_DEADLINE + 1);
    }

    /// Move `amount` out of the circle's token balance so the next outgoing
    /// transfer fails with insufficient balance.  Returns the sink holding it.
    pub fn drain_circle(&self, amount: i128) -> Address {
        let sink = Address::generate(&self.env);
        self.token.transfer(&self.circle_id, &sink, &amount);
        sink
    }

    /// Return drained funds to the circle so a retried operation can succeed.
    pub fn refund_circle(&self, sink: &Address, amount: i128) {
        self.token.transfer(sink, &self.circle_id, &amount);
    }

    /// Burn a wallet's whole token balance.
    pub fn empty_wallet(&self, who: &Address) -> i128 {
        let bal = self.token.balance(who);
        if bal > 0 {
            self.token.burn(who, &bal);
        }
        bal
    }

    /// Run `action` and return the events the circle contract published
    /// during it, as `(topics, data)`.  `events().all()` accumulates across
    /// invocations, so only the entries appended by `action` are returned.
    pub fn circle_events_of(&self, action: impl FnOnce()) -> std::vec::Vec<(Vec<Val>, Val)> {
        self.contract_events_of(&self.circle_id.clone(), action)
    }

    /// Like [`Self::circle_events_of`] for any emitting contract.
    pub fn contract_events_of(
        &self,
        contract: &Address,
        action: impl FnOnce(),
    ) -> std::vec::Vec<(Vec<Val>, Val)> {
        let before = self.env.events().all().len();
        action();
        self.env
            .events()
            .all()
            .iter()
            .skip(before as usize)
            .filter(|(c, _, _)| c == contract)
            .map(|(_, topics, data)| (topics, data))
            .collect()
    }
}

/// Deploy token + reputation + circle and initialize the circle with four
/// funded members.  `register_on_reputation = false` leaves the circle off the
/// reputation allowlist, so payout's reputation call fails.
pub fn fixture_with(register_on_reputation: bool) -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    // Revocable so tests can de-authorize a trustline (frozen-account path).
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let token = TokenClient::new(&env, &sac.address());
    let asset = StellarAssetClient::new(&env, &sac.address());

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    let dave = Address::generate(&env);
    let mut members = Vec::new(&env);
    for m in [&alice, &bob, &carol, &dave] {
        // collateral + one contribution for each of the 4 rounds
        asset.mint(m, &(COLLATERAL + ROUND_AMOUNT * 4));
        members.push_back(m.clone());
    }

    let circle_id = env.register_contract(None, CircleContract);
    let circle = CircleContractClient::new(&env, &circle_id);

    let rep_id = env.register_contract(None, ReputationContract);
    let rep = ReputationContractClient::new(&env, &rep_id);
    let rep_admin = Address::generate(&env);
    rep.initialize(&rep_admin);
    if register_on_reputation {
        rep.add_authorized_caller(&rep_admin, &circle_id);
    }

    let admin = Address::generate(&env);
    circle.initialize(
        &admin,
        &members,
        &ROUND_AMOUNT,
        &sac.address(),
        &rep_id,
        &ROUND_DEADLINE,
    );

    Fixture {
        env,
        circle,
        circle_id,
        token,
        asset,
        rep,
        rep_id,
        rep_admin,
        admin,
        members,
        alice,
        bob,
        carol,
        dave,
    }
}

pub fn fixture() -> Fixture<'static> {
    fixture_with(true)
}
