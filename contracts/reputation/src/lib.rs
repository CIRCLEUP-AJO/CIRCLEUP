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
    ///
    /// The *invoking circle contract* must authorize this call — not the member
    /// themselves.  In Soroban, `env.current_contract_address()` inside the
    /// circle contract is the address that signs the sub-call to `increment`,
    /// so we require auth on that invoker address (passed in as `caller`) rather
    /// than on `member`.  Requiring the member's signature here would force
    /// every payout transaction to also carry the recipient's signature, which
    /// breaks the trustless payout flow.
    ///
    /// # Panics
    ///
    /// - `"not initialized"` — if called before `initialize`
    /// - `"unauthorized caller"` — if `caller` is not the stored admin
    pub fn increment(env: Env, caller: Address, member: Address) {
        // Guard: contract must be initialized before scores can be written.
        if !env.storage().instance().has(&DataKey::Admin) {
            panic!("not initialized");
        }

        // Only the registered admin (set by the factory to itself, then used by
        // circle contracts) may increment scores.  This prevents any random
        // wallet from inflating reputation scores by calling increment directly.
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic!("unauthorized caller");
        }
        // Require the caller's auth signature — the circle contract must have
        // authorized this sub-call before we write.
        caller.require_auth();

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

    // ── Fixture ───────────────────────────────────────────────────────────────

    /// Deploy and initialize a fresh reputation contract.
    ///
    /// Returns `(env, admin, client)`.  All calls are authorized via
    /// `mock_all_auths` so tests can focus on logic rather than key management.
    fn setup() -> (Env, Address, ReputationContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, admin, client)
    }

    // ── Initialization tests ──────────────────────────────────────────────────

    /// `initialize` must store the admin address so subsequent queries
    /// (`score`) and mutations (`increment`) can read it back correctly.
    #[test]
    fn test_initialize_stores_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        // Contract starts uninitialized — score still returns 0 (read-only path
        // does not touch Admin key) but increment must panic (see separate test).
        let member = Address::generate(&env);
        assert_eq!(client.score(&member), 0, "score must default to 0 before init");

        client.initialize(&admin);

        // After init the admin is persisted; verify via a successful increment
        // (which internally reads the Admin key and compares against caller).
        client.increment(&admin, &member);
        assert_eq!(client.score(&member), 1, "score must be 1 after one increment");
    }

    /// A second `initialize` call must be rejected with a clear message so the
    /// admin address and any already-recorded scores cannot be overwritten by a
    /// race or a misconfigured re-deployment script.
    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let (_, admin, client) = setup();
        client.initialize(&admin);
    }

    // ── Admin authorization tests ─────────────────────────────────────────────

    /// The admin address stored at `initialize` time is the *only* caller
    /// permitted to invoke `increment`.  Any other address — including the
    /// member whose score would be incremented — must be rejected.
    ///
    /// This prevents direct manipulation of scores by wallet owners or by
    /// circle contracts that were not granted admin rights at init time.
    #[test]
    #[should_panic(expected = "unauthorized caller")]
    fn test_increment_by_non_admin_panics() {
        let (env, _admin, client) = setup();
        // A random address that is NOT the admin attempts to increment a score.
        let non_admin = Address::generate(&env);
        let member = Address::generate(&env);
        client.increment(&non_admin, &member);
    }

    /// The member whose score is being incremented must NOT be able to call
    /// `increment` for themselves — even if they happen to share no relationship
    /// to the admin.  The auth check is on `caller`, not `member`.
    #[test]
    #[should_panic(expected = "unauthorized caller")]
    fn test_member_cannot_self_increment() {
        let (env, _admin, client) = setup();
        let member = Address::generate(&env);
        // Passing member as both caller and member — still unauthorized because
        // member != admin.
        client.increment(&member, &member);
    }

    /// Only the exact admin address registered at init time is accepted.  A
    /// different address that looks legitimate (e.g. another contract) must fail.
    #[test]
    #[should_panic(expected = "unauthorized caller")]
    fn test_increment_by_different_contract_panics() {
        let (env, _admin, client) = setup();
        let different_contract = Address::generate(&env);
        let member = Address::generate(&env);
        client.increment(&different_contract, &member);
    }

    /// The admin (acting as an authorized circle contract) can successfully
    /// increment a member's score, confirming the happy path works end-to-end.
    #[test]
    fn test_admin_can_increment() {
        let (env, admin, client) = setup();
        let member = Address::generate(&env);
        assert_eq!(client.score(&member), 0);
        client.increment(&admin, &member);
        assert_eq!(client.score(&member), 1);
    }

    /// `increment` must panic when called before `initialize` so callers get a
    /// clear diagnostic instead of an opaque storage-read failure.
    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_increment_before_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let caller = Address::generate(&env);
        let member = Address::generate(&env);
        client.increment(&caller, &member);
    }

    // ── Score mutation tests ───────────────────────────────────────────────────

    #[test]
    fn test_score_starts_at_zero() {
        let (env, _, client) = setup();
        let member = Address::generate(&env);
        assert_eq!(client.score(&member), 0);
    }

    #[test]
    fn test_increment_once() {
        let (env, admin, client) = setup();
        let member = Address::generate(&env);
        client.increment(&admin, &member);
        assert_eq!(client.score(&member), 1);
    }

    #[test]
    fn test_increment_multiple() {
        let (env, admin, client) = setup();
        let member = Address::generate(&env);
        client.increment(&admin, &member);
        client.increment(&admin, &member);
        client.increment(&admin, &member);
        assert_eq!(client.score(&member), 3);
    }

    #[test]
    fn test_independent_scores() {
        let (env, admin, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.increment(&admin, &alice);
        client.increment(&admin, &alice);
        client.increment(&admin, &bob);
        assert_eq!(client.score(&alice), 2);
        assert_eq!(client.score(&bob), 1);
    }

    /// Incrementing one member's score must never affect a different member's score.
    #[test]
    fn test_increment_does_not_affect_other_members() {
        let (env, admin, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);

        client.increment(&admin, &alice);
        client.increment(&admin, &alice);

        assert_eq!(client.score(&alice), 2, "alice should have score 2");
        assert_eq!(client.score(&bob), 0,   "bob's score must be untouched");
        assert_eq!(client.score(&carol), 0, "carol's score must be untouched");
    }
}
