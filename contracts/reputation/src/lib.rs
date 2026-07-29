//! Reputation contract — tracks completed-rounds score per wallet address.
//!
//! # Authorization model
//!
//! `increment` may only be called by an **authorized circle contract** — not
//! by the member whose score is being updated.  This prevents any wallet from
//! self-awarding reputation points outside of a legitimate ROSCA payout.
//!
//! The factory registers each newly deployed circle by calling
//! `add_authorized_caller` (admin-only).  The factory itself is set as `admin`
//! during `initialize`.
//!
//! ```text
//!   factory.create_circle()
//!     └─► reputation.add_authorized_caller(circle_address)   [admin = factory]
//!         └─► circle.payout()
//!               └─► reputation.increment(member)             [caller = circle]
//! ```
//!
//! # Events
//!
//! All events use the two-symbol topic prefix `("reputation", <event_name>)` so
//! the indexer can filter with `topic0 == "reputation"`.
//!
//! ## `reputation` / `score_updated`
//!
//! Emitted after every successful `increment` call.
//!
//! | Part | Shape | Meaning |
//! |------|-------|---------|
//! | **Topics** | `(Symbol("reputation"), Symbol("score_updated"))` | Stable filter keys |
//! | **Data** | `(Address, u32)` | `(member, new_total_score)` |
//!
//! ## `reputation` / `caller_added`
//!
//! Emitted when admin registers a new authorized caller.
//!
//! | **Data** | `Address` | The newly authorized circle contract address |
//!
//! ## `reputation` / `caller_removed`
//!
//! Emitted when admin revokes an authorized caller.
//!
//! | **Data** | `Address` | The revoked circle contract address |

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, contracterror, Address, Env, Symbol, Vec};

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// Completed-rounds score for a wallet.
    Score(Address),
    /// Admin address — the only address allowed to manage authorized callers.
    /// Set once at `initialize` time; typically the factory contract.
    Admin,
    /// Vec<Address> of circle contracts permitted to call `increment`.
    AuthorizedCallers,
}

// ─── Contract errors ──────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum ReputationError {
    /// `increment` was called by an address that is not in `AuthorizedCallers`.
    UnauthorizedCaller = 1,
    /// `add_authorized_caller` or `remove_authorized_caller` was called by a
    /// non-admin address.
    NotAdmin = 2,
    /// `remove_authorized_caller` was asked to remove an address that is not
    /// currently in the authorized list.
    CallerNotFound = 3,
    /// A mutating entry-point was called before `initialize`.
    NotInitialized = 4,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Called once by the deployer.
    ///
    /// `admin` is the only address permitted to register or revoke authorized
    /// callers via `add_authorized_caller` / `remove_authorized_caller`.  In
    /// the standard CircleUp deployment the factory contract is passed as admin
    /// so it can register each circle it deploys.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        let callers: Vec<Address> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &callers);
    }

    // ── Authorized-caller management ──────────────────────────────────────────

    /// Register `circle` as a contract that may call `increment`.
    ///
    /// Only the admin (typically the factory) may call this.
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::NotAdmin`] — caller is not the admin.
    pub fn add_authorized_caller(
        env: Env,
        caller: Address,
        circle: Address,
    ) -> Result<(), ReputationError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ReputationError::NotInitialized)?;

        caller.require_auth();
        if caller != admin {
            return Err(ReputationError::NotAdmin);
        }

        let mut callers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env));

        // Idempotent: skip if already present.
        if !callers.contains(&circle) {
            callers.push_back(circle.clone());
            env.storage()
                .instance()
                .set(&DataKey::AuthorizedCallers, &callers);

            env.events().publish(
                (
                    Symbol::new(&env, "reputation"),
                    Symbol::new(&env, "caller_added"),
                ),
                circle,
            );
        }

        Ok(())
    }

    /// Revoke `circle`'s permission to call `increment`.
    ///
    /// Only the admin may call this.
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::NotAdmin`] — caller is not the admin.
    /// - [`ReputationError::CallerNotFound`] — `circle` was not in the list.
    pub fn remove_authorized_caller(
        env: Env,
        caller: Address,
        circle: Address,
    ) -> Result<(), ReputationError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ReputationError::NotInitialized)?;

        caller.require_auth();
        if caller != admin {
            return Err(ReputationError::NotAdmin);
        }

        let mut callers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env));

        // Find the index of the address to remove.
        let mut found_idx: Option<u32> = None;
        for (idx, addr) in callers.iter().enumerate() {
            if addr == circle {
                found_idx = Some(idx as u32);
                break;
            }
        }

        let idx = found_idx.ok_or(ReputationError::CallerNotFound)?;
        callers.remove(idx);
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &callers);

        env.events().publish(
            (
                Symbol::new(&env, "reputation"),
                Symbol::new(&env, "caller_removed"),
            ),
            circle,
        );

        Ok(())
    }

    // ── Mutation ──────────────────────────────────────────────────────────────

    /// Increment `member`'s completed-rounds score by 1.
    ///
    /// `circle` must be an address registered via `add_authorized_caller`.  The
    /// Soroban host **automatically authorizes** `circle.require_auth()` when
    /// the call originates from the circle contract itself (Contract Invoker
    /// rule), so no external signature is required in cross-contract calls.
    /// A wallet calling this directly would have to produce a signature for the
    /// circle's address, which it cannot do — effectively blocking direct calls.
    ///
    /// # Authorization flow
    ///
    /// ```text
    /// circle.payout()
    ///   └─► reputation.increment(circle_address, member)
    ///             ├─► circle.require_auth()  — auto-granted by Soroban host
    ///             └─► checks circle is in AuthorizedCallers list
    /// ```
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::UnauthorizedCaller`] — `circle` is not in the
    ///   `AuthorizedCallers` list.
    pub fn increment(env: Env, circle: Address, member: Address) -> Result<(), ReputationError> {
        // Verify the contract has been initialized before doing anything else.
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(ReputationError::NotInitialized);
        }

        // Require auth from the circle address.  When called from within a
        // circle contract via a cross-contract call, Soroban's Contract Invoker
        // rule auto-grants this — no external signature needed.  A direct call
        // from a wallet would require the wallet to hold the circle's key,
        // which is impossible in practice.
        circle.require_auth();

        // Confirm the circle is in our registered allowlist.
        let callers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env));

        if !callers.contains(&circle) {
            return Err(ReputationError::UnauthorizedCaller);
        }

        // Load current score; default to 0 for first-time members.
        let current: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Score(member.clone()))
            .unwrap_or(0);

        let new_score = current + 1;

        env.storage()
            .persistent()
            .set(&DataKey::Score(member.clone()), &new_score);

        // Extend TTL so scores survive well beyond the circle's lifetime.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Score(member.clone()), 100_000, 200_000);

        // Emit (member, new_total_score) so indexers and frontends can show
        // both *who* received the point and *what their total score is now*
        // without a separate `score` query.
        env.events().publish(
            (
                Symbol::new(&env, "reputation"),
                Symbol::new(&env, "score_updated"),
            ),
            (member, new_score),
        );

        Ok(())
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Returns the number of completed rounds for `member` (0 if none on record).
    pub fn score(env: Env, member: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Score(member))
            .unwrap_or(0)
    }

    /// Returns the list of currently authorized circle contracts.
    pub fn get_authorized_callers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns the admin address.
    ///
    /// Panics with a clear message if called before `initialize`.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("reputation: get_admin called before initialize"))
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    // ── Fixture ───────────────────────────────────────────────────────────────

    struct Setup<'a> {
        env: Env,
        admin: Address,
        client: ReputationContractClient<'a>,
        contract_id: Address,
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        Setup { env, admin, client, contract_id }
    }

    // ── initialize ────────────────────────────────────────────────────────────

    #[test]
    fn test_score_starts_at_zero() {
        let s = setup();
        let member = Address::generate(&s.env);
        assert_eq!(s.client.score(&member), 0);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let s = setup();
        s.client.initialize(&s.admin);
    }

    #[test]
    fn test_get_admin_returns_initialized_admin() {
        let s = setup();
        assert_eq!(s.client.get_admin(), s.admin);
    }

    // ── add_authorized_caller ─────────────────────────────────────────────────

    #[test]
    fn test_add_authorized_caller_by_admin_succeeds() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        assert!(s.client.get_authorized_callers().contains(&circle));
    }

    /// Incrementing one member's score must never affect a different member's score.
    #[test]
    fn test_add_authorized_caller_is_idempotent() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.add_authorized_caller(&s.admin, &circle);
        // Should appear exactly once in the list.
        let callers = s.client.get_authorized_callers();
        let count = callers.iter().filter(|a| a == circle).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_add_authorized_caller_non_admin_returns_not_admin_error() {
        let s = setup();
        let non_admin = Address::generate(&s.env);
        let circle = Address::generate(&s.env);
        let result = s.client.try_add_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "non-admin must receive NotAdmin error"
        );
    }

    // ── remove_authorized_caller ──────────────────────────────────────────────

    #[test]
    fn test_remove_authorized_caller_by_admin_succeeds() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);
        assert!(!s.client.get_authorized_callers().contains(&circle));
    }

    #[test]
    fn test_remove_authorized_caller_not_found_returns_error() {
        let s = setup();
        let circle = Address::generate(&s.env);
        let result = s.client.try_remove_authorized_caller(&s.admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::CallerNotFound)),
            "removing unknown caller must return CallerNotFound"
        );
    }

    #[test]
    fn test_remove_authorized_caller_non_admin_returns_not_admin_error() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        let non_admin = Address::generate(&s.env);
        let result = s.client.try_remove_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "non-admin must receive NotAdmin error on remove"
        );
    }

    // ── increment: authorization ──────────────────────────────────────────────

    #[test]
    fn test_increment_by_unauthorized_caller_returns_error() {
        let s = setup();
        let member = Address::generate(&s.env);
        let unregistered_circle = Address::generate(&s.env);
        // No circle registered — increment must be rejected.
        let result = s.client.try_increment(&unregistered_circle, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::UnauthorizedCaller)),
            "unregistered caller must receive UnauthorizedCaller error"
        );
    }

    #[test]
    fn test_increment_by_authorized_caller_succeeds() {
        let s = setup();
        let member = Address::generate(&s.env);
        // Register the reputation contract itself as an authorized caller
        // so we can exercise the happy path from within the test environment.
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);
        assert_eq!(s.client.score(&member), 1);
    }

    #[test]
    fn test_increment_multiple_times() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);
        s.client.increment(&s.contract_id, &member);
        s.client.increment(&s.contract_id, &member);
        assert_eq!(s.client.score(&member), 3);
    }

    #[test]
    fn test_independent_scores_across_members() {
        let s = setup();
        let alice = Address::generate(&s.env);
        let bob = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &alice);
        s.client.increment(&s.contract_id, &alice);
        s.client.increment(&s.contract_id, &bob);
        assert_eq!(s.client.score(&alice), 2);
        assert_eq!(s.client.score(&bob), 1);
    }

    // ── increment: event emission ─────────────────────────────────────────────

    /// Collect data payloads of all events whose second topic matches `name`.
    fn events_named(env: &Env, name: &str) -> std::vec::Vec<soroban_sdk::Val> {
        let target = soroban_sdk::Symbol::new(env, name);
        env.events()
            .all()
            .into_iter()
            .filter(|(_contract, topics, _data)| {
                topics
                    .get(1)
                    .map(|v| {
                        v == soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&target, env)
                    })
                    .unwrap_or(false)
            })
            .map(|(_contract, _topics, data)| data)
            .collect()
    }

    #[test]
    fn test_increment_emits_score_updated_event() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);

        let events = events_named(&s.env, "score_updated");
        assert_eq!(events.len(), 1, "expected exactly one 'score_updated' event");
    }

    #[test]
    fn test_score_updated_event_carries_member_and_new_total() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);

        let events = events_named(&s.env, "score_updated");
        assert_eq!(events.len(), 1);

        // Data is (Address, u32) — decode and verify both fields.
        let (evt_member, evt_score): (Address, u32) =
            soroban_sdk::FromVal::from_val(&s.env, &events[0]);
        assert_eq!(evt_member, member, "event must carry the member address");
        assert_eq!(evt_score, 1u32, "event must carry the new total score");
    }

    #[test]
    fn test_caller_added_event_emitted() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);

        let events = events_named(&s.env, "caller_added");
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn test_caller_removed_event_emitted() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);

        let events = events_named(&s.env, "caller_removed");
        assert_eq!(events.len(), 1);
    }

    // ── not-initialized guard ─────────────────────────────────────────────────

    #[test]
    fn test_increment_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let circle = Address::generate(&env);
        let member = Address::generate(&env);
        let result = client.try_increment(&circle, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "increment before initialize must return NotInitialized"
        );
    }
}
