//! Shared harness for the circle integration tests added for
//! #873 (member order), #874 (default penalties), #875 (terminal close) and
//! #876 (pause semantics).
//!
//! Uses a real Stellar Asset Contract as the token and a real reputation
//! contract with the circle registered as an authorized caller, so every
//! token movement and reputation side effect is the production code path.
//! State injection helpers (`force_*`, `set_*`) are clearly named and only
//! used where a state is unreachable through the public API or where driving
//! it for real would be prohibitively slow; each use is commented at the call
//! site.

#![allow(dead_code)]

use circle::{
    CircleContract, CircleContractClient, CircleStatus, DataKey, COLLATERAL_MULTIPLIER,
};
use reputation::{ReputationContract, ReputationContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Error, InvokeError, Symbol, TryFromVal, Val, Vec,
};

pub const ROUND_DEADLINE: u32 = 1_000;

/// Environment with mocked auth and no resource limits (the max-size
/// rotation test runs hundreds of invocations).
pub fn new_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    env
}

/// `n` freshly generated member addresses, in generation order.
pub fn gen_members(env: &Env, n: u32) -> Vec<Address> {
    let mut v = Vec::new(env);
    for _ in 0..n {
        v.push_back(Address::generate(env));
    }
    v
}

/// Convert a soroban `Vec` into a std `Vec` for sorting and comparisons.
pub fn to_std(v: &Vec<Address>) -> std::vec::Vec<Address> {
    v.iter().collect()
}

pub fn from_std(env: &Env, v: &[Address]) -> Vec<Address> {
    let mut out = Vec::new(env);
    for a in v {
        out.push_back(a.clone());
    }
    out
}

pub struct Circle {
    pub env: Env,
    pub client: CircleContractClient<'static>,
    pub id: Address,
    pub token: TokenClient<'static>,
    pub asset: StellarAssetClient<'static>,
    pub admin: Address,
    pub members: Vec<Address>,
    pub round_amount: i128,
}

/// Deploy and initialize a circle with `members` in exactly the given order.
/// Each member is funded with collateral plus one contribution per round.
pub fn setup(env: Env, members: Vec<Address>, round_amount: i128) -> Circle {
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = TokenClient::new(&env, &sac.address());
    let asset = StellarAssetClient::new(&env, &sac.address());

    let n = members.len() as i128;
    let funds = round_amount * COLLATERAL_MULTIPLIER + round_amount * n;
    for m in members.iter() {
        asset.mint(&m, &funds);
    }

    let rep_id = env.register_contract(None, ReputationContract);
    let rep = ReputationContractClient::new(&env, &rep_id);
    let rep_admin = Address::generate(&env);
    rep.initialize(&rep_admin);

    let id = env.register_contract(None, CircleContract);
    rep.add_authorized_caller(&rep_admin, &id);
    let client = CircleContractClient::new(&env, &id);

    let admin = Address::generate(&env);
    client.initialize(
        &admin,
        &members,
        &round_amount,
        &sac.address(),
        &rep_id,
        &ROUND_DEADLINE,
    );

    Circle {
        env,
        client,
        id,
        token,
        asset,
        admin,
        members,
        round_amount,
    }
}

/// Normalise a generated `try_*` result to `Ok(())` or the numeric contract
/// error code, whether the error arrived typed (`Err(Ok(e))`) or as a contract
/// error outside the entry-point's declared enum (`InvokeError::Contract`).
pub fn code<T, C, E: Into<Error>>(r: Result<Result<T, C>, Result<E, InvokeError>>) -> Result<(), u32> {
    match r {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(_)) => panic!("return value failed to decode"),
        Err(Ok(e)) => Err(e.into().get_code()),
        Err(Err(InvokeError::Contract(c))) => Err(c),
        Err(Err(InvokeError::Abort)) => panic!("invocation aborted without a contract error"),
    }
}

/// Point-in-time view of every value a failed call must not change.
#[derive(Debug, PartialEq)]
pub struct Snapshot {
    pub status: CircleStatus,
    pub closed: bool,
    pub paused: bool,
    pub member_balances: std::vec::Vec<i128>,
    pub circle_balance: i128,
    pub collateral: std::vec::Vec<i128>,
    pub defaults: std::vec::Vec<u32>,
}

impl Circle {
    pub fn n(&self) -> u32 {
        self.members.len()
    }

    pub fn member(&self, i: u32) -> Address {
        self.members.get(i).unwrap()
    }

    pub fn join(&self, i: u32) {
        self.client.join(&self.member(i));
    }

    pub fn join_all(&self) {
        for m in self.members.iter() {
            self.client.join(&m);
        }
    }

    pub fn contribute(&self, i: u32) {
        self.client.contribute(&self.member(i));
    }

    pub fn contribute_all(&self) {
        for m in self.members.iter() {
            self.client.contribute(&m);
        }
    }

    pub fn balance(&self, who: &Address) -> i128 {
        self.token.balance(who)
    }

    pub fn circle_balance(&self) -> i128 {
        self.token.balance(&self.id)
    }

    /// Set the ledger to exactly one past the current round's deadline.
    pub fn advance_past_deadline(&self) {
        let deadline = self.client.get_current_round().deadline_ledger;
        let target = u32::try_from(deadline + 1).expect("deadline fits in u32");
        self.env.ledger().with_mut(|l| l.sequence_number = target);
    }

    pub fn set_ledger(&self, sequence: u32) {
        self.env.ledger().with_mut(|l| l.sequence_number = sequence);
    }

    pub fn advance_ledgers(&self, by: u32) {
        self.env.ledger().with_mut(|l| l.sequence_number += by);
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            status: self.client.get_status(),
            closed: self.client.is_closed(),
            paused: self.client.is_paused(),
            member_balances: self.members.iter().map(|m| self.balance(&m)).collect(),
            circle_balance: self.circle_balance(),
            collateral: self.members.iter().map(|m| self.client.get_collateral(&m)).collect(),
            defaults: self.members.iter().map(|m| self.client.get_defaults(&m)).collect(),
        }
    }

    // ── State injection (test-only; see module docs) ─────────────────────────

    /// Teleport to a terminal status with all rounds accounted for.
    pub fn force_completed(&self) {
        let n = self.n();
        self.env.as_contract(&self.id, || {
            let s = self.env.storage().instance();
            s.set(&DataKey::Status, &CircleStatus::Completed);
            s.set(&DataKey::RoundsCompleted, &n);
        });
    }

    /// Overwrite one member's stored collateral balance.
    pub fn set_collateral(&self, member: &Address, amount: i128) {
        self.env.as_contract(&self.id, || {
            self.env
                .storage()
                .persistent()
                .set(&DataKey::Collateral(member.clone()), &amount);
        });
    }

    /// Record a full contribution set for the current round and fund the pot,
    /// without invoking `contribute` once per member. `payout` still runs its
    /// full tally, recipient and pot checks against this state.
    pub fn inject_full_contributions(&self) {
        let mut round = self.client.get_current_round();
        let n = self.n();
        self.env.as_contract(&self.id, || {
            for m in self.members.iter() {
                self.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Contributed(m, round.round_index), &true);
            }
            round.contributions_received = n;
            self.env.storage().instance().set(&DataKey::CurrentRound, &round);
        });
        self.asset.mint(&self.id, &(self.round_amount * n as i128));
    }

    // ── Events ────────────────────────────────────────────────────────────────

    pub fn event_count(&self) -> u32 {
        self.env.events().all().len()
    }

    /// Circle events appended since `before`, as `(name, data)`.
    pub fn circle_events_since(&self, before: u32) -> std::vec::Vec<(Symbol, Val)> {
        self.env
            .events()
            .all()
            .iter()
            .skip(before as usize)
            .filter(|(c, _, _)| *c == self.id)
            .map(|(_, topics, data)| {
                let name = Symbol::try_from_val(&self.env, &topics.get(1).unwrap()).unwrap();
                (name, data)
            })
            .collect()
    }

    pub fn sym(&self, s: &str) -> Symbol {
        Symbol::new(&self.env, s)
    }

    /// Decode an event payload as `T`.
    pub fn data<T: TryFromVal<Env, Val>>(&self, v: &Val) -> T {
        T::try_from_val(&self.env, v).unwrap_or_else(|_| panic!("event payload has unexpected shape"))
    }
}
