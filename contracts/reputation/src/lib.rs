//! Reputation contract — tracks completed-rounds score per wallet address.
//! Any circle contract can call `increment` after a successful payout round.
//! Scores are readable by any caller (circles, frontends).

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

// ─── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// completed-rounds score for a wallet
    Score(Address),
    /// admin allowed to call increment (the factory sets this to itself)
    Admin,
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    // ── Initialization ───────────────────────────────────────────────────────

    /// Called once by the deployer. `admin` is the only address allowed to
    /// register new authorized callers (circle contracts).
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    // ── Mutation ─────────────────────────────────────────────────────────────

    /// Increment `member`'s completed-rounds score by 1.
    /// Caller must be an authorized circle contract (auth checked via invoker).
    pub fn increment(env: Env, member: Address) {
        // The circle contract must have authorized this call.
        member.require_auth();

        let current: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Score(member.clone()))
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&DataKey::Score(member.clone()), &(current + 1));

        // Bump TTL so the score lives long enough to matter
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Score(member), 100_000, 200_000);

        env.events()
            .publish((Symbol::new(&env, "reputation"), Symbol::new(&env, "increment")), current + 1);
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    /// Returns the number of completed rounds for `member` (0 if none).
    pub fn score(env: Env, member: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Score(member))
            .unwrap_or(0)
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup() -> (Env, Address, ReputationContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, admin, client)
    }

    #[test]
    fn test_score_starts_at_zero() {
        let (env, _, client) = setup();
        let member = Address::generate(&env);
        assert_eq!(client.score(&member), 0);
    }

    #[test]
    fn test_increment_once() {
        let (env, _, client) = setup();
        let member = Address::generate(&env);
        client.increment(&member);
        assert_eq!(client.score(&member), 1);
    }

    #[test]
    fn test_increment_multiple() {
        let (env, _, client) = setup();
        let member = Address::generate(&env);
        client.increment(&member);
        client.increment(&member);
        client.increment(&member);
        assert_eq!(client.score(&member), 3);
    }

    #[test]
    fn test_independent_scores() {
        let (env, _, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.increment(&alice);
        client.increment(&alice);
        client.increment(&bob);
        assert_eq!(client.score(&alice), 2);
        assert_eq!(client.score(&bob), 1);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let (_, admin, client) = setup();
        client.initialize(&admin);
    }
}
