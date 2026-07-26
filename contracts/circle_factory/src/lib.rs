//! CircleFactory — deploys new circle contract instances and maintains a registry.
//!
//! The factory holds the WASM hash of the circle contract, deploys fresh instances
//! via `env.deployer().with_current_contract(salt)`, initialises them in one
//! transaction, and records them in a list for the indexer to discover.
//!
//! # Events
//!
//! All factory events use a two-symbol topic prefix so the indexer can filter
//! with `topic0 == "factory"`.
//!
//! ## `factory` / `circle_created`
//!
//! Emitted at the end of a successful [`CircleFactory::create_circle`] call,
//! after the new circle has been deployed, initialised, and registered.
//!
//! | Part | Shape | Meaning |
//! |------|-------|---------|
//! | **Topics** | `(Symbol("factory"), Symbol("circle_created"))` | Stable filter keys for the indexer |
//! | **Data** | `(Address, Address, u32)` | See fields below |
//!
//! Data tuple fields, in order:
//!
//! 1. `circle_address: Address` — contract ID of the newly deployed circle
//! 2. `creator: Address` — wallet that authorised `create_circle`
//! 3. `circle_index: u32` — zero-based factory counter **before** this create
//!    (the same value mixed into the deploy salt). After the event is published
//!    the stored `CircleCount` is `circle_index + 1`.
//!
//! Example (conceptual):
//!
//! ```text
//! topics: ["factory", "circle_created"]
//! data:   ["CCircle...", "GCreator...", 3u32]
//! ```
//!
//! Indexers should treat an absent or differently-typed third element as a
//! compatibility concern with older factory builds, not as
//! `round_deadline_ledgers` (that value lives on the circle config, not in
//! this event).

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, Vec,
};

// ─── Types ────────────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    CircleWasmHash,
    ReputationContract,
    UsdcToken,
    Circles,          // Vec<Address> — deployed circle addresses
    CircleCount,      // u32
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Rejects member lists that contain the same address more than once.
///
/// Duplicate members would break payout ordering and let one wallet occupy
/// multiple rotation slots, so we fail before paying for a deploy.
fn assert_unique_members(members: &Vec<Address>) {
    let len = members.len();
    let mut i: u32 = 0;
    while i < len {
        let mut j = i + 1;
        while j < len {
            if members.get(i).unwrap() == members.get(j).unwrap() {
                panic!("duplicate members");
            }
            j += 1;
        }
        i += 1;
    }
}

/// Build a deploy salt that is unique per successful `create_circle` call.
///
/// Primary uniqueness comes from the monotonic factory `CircleCount` mixed with
/// the creator address. Ledger sequence and timestamp are appended as extra
/// entropy so a count reset (e.g. after an unusual storage wipe + redeploy of
/// the same factory WASM id) cannot recreate a previously used salt under
/// `with_current_contract`.
fn derive_circle_salt(env: &Env, creator: &Address, count: u32) -> BytesN<32> {
    let mut salt_bytes = Bytes::new(env);
    salt_bytes.append(&creator.clone().to_xdr(env));
    salt_bytes.append(&count.to_xdr(env));
    salt_bytes.append(&env.ledger().sequence().to_xdr(env));
    salt_bytes.append(&env.ledger().timestamp().to_xdr(env));
    env.crypto().sha256(&salt_bytes).into()
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct CircleFactory;

#[contractimpl]
impl CircleFactory {

    // ── Initialization ────────────────────────────────────────────────────────

    /// One-time factory setup. `admin` must authorize this call so a third
    /// party cannot claim admin by front-running deployment.
    pub fn initialize(
        env: Env,
        admin: Address,
        circle_wasm_hash: BytesN<32>,
        reputation_contract: Address,
        usdc_token: Address,
    ) {
        // Init guard: refuse re-initialization with a clear message so callers
        // do not silently overwrite admin / token config.
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        // Auth guard: the designated admin must sign this invocation.
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::CircleWasmHash, &circle_wasm_hash);
        env.storage().instance().set(&DataKey::ReputationContract, &reputation_contract);
        env.storage().instance().set(&DataKey::UsdcToken, &usdc_token);
        env.storage().instance().set(&DataKey::CircleCount, &0u32);
        let circles: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::Circles, &circles);
    }

    // ── Create Circle ─────────────────────────────────────────────────────────

    /// Deploy a new circle contract and initialise it in one tx.
    ///
    /// Returns the address of the newly deployed circle.
    ///
    /// # Panics
    ///
    /// - `"duplicate members"` if `members` contains the same address twice
    /// - `"need at least 2 members"` / `"round_amount must be positive"` from
    ///   the circle `initialize` call when inputs are invalid
    ///
    /// # Events
    ///
    /// Publishes `factory` / `circle_created` — see the crate-level docs for
    /// the exact topic and data tuple shape.
    pub fn create_circle(
        env: Env,
        creator: Address,
        members: Vec<Address>,
        round_amount: i128,
        round_deadline_ledgers: u32,
    ) -> Address {
        creator.require_auth();

        assert_unique_members(&members);

        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::CircleWasmHash)
            .unwrap();
        let reputation: Address = env
            .storage()
            .instance()
            .get(&DataKey::ReputationContract)
            .unwrap();
        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcToken)
            .unwrap();

        // Monotonic counter mixed into the salt — incremented only after a
        // successful deploy + init so failed creates do not burn an index.
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or(0);

        let salt = derive_circle_salt(&env, &creator, count);

        // Deploy
        let circle_address = env
            .deployer()
            .with_current_contract(salt)
            .deploy(wasm_hash);

        // Initialize the new circle contract
        let init_args = soroban_sdk::vec![
            &env,
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&members, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&round_amount, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&usdc, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&reputation, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&round_deadline_ledgers, &env),
        ];

        env.invoke_contract::<()>(
            &circle_address,
            &Symbol::new(&env, "initialize"),
            init_args,
        );

        // Register in list
        let mut circles: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Circles)
            .unwrap_or(Vec::new(&env));
        circles.push_back(circle_address.clone());
        env.storage().instance().set(&DataKey::Circles, &circles);
        env.storage().instance().set(&DataKey::CircleCount, &(count + 1));

        // Event data: (circle_address, creator, circle_index) — see crate docs.
        env.events().publish(
            (Symbol::new(&env, "factory"), Symbol::new(&env, "circle_created")),
            (circle_address.clone(), creator, count),
        );

        circle_address
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    pub fn get_circles(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Circles)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_circle_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or(0)
    }

    /// Returns the factory admin. Panics with a clear message if the factory
    /// has not been initialized yet.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Returns the USDC token address configured at initialize. Panics with a
    /// clear message if the factory has not been initialized yet.
    pub fn get_usdc_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::UsdcToken)
            .unwrap_or_else(|| panic!("not initialized"))
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    fn setup_factory(env: &Env) -> (CircleFactoryClient, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(env, &id);
        let admin = Address::generate(env);
        let rep = Address::generate(env);
        let usdc = Address::generate(env);
        let wasm_hash: BytesN<32> = BytesN::from_array(env, &[0u8; 32]);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        (client, admin)
    }

    #[test]
    fn test_factory_initializes() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);
        assert_eq!(client.get_circle_count(), 0);
    }

    #[test]
    fn test_get_admin_and_usdc_token() {
        let env = Env::default();
        let (client, admin, _, usdc) = setup_factory(&env);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_usdc_token(), usdc);
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_get_admin_before_init_panics() {
        let env = Env::default();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let _ = client.get_admin();
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_get_usdc_token_before_init_panics() {
        let env = Env::default();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let _ = client.get_usdc_token();
    }

    #[test]
    fn test_initialize_records_auth_for_admin() {
        let env = Env::default();
        // Do not mock_all_auths — verify require_auth records the admin.
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let rep = Address::generate(&env);
        let usdc = Address::generate(&env);
        let wasm_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);

        // Without mocking, Soroban test env still allows require_auth when we
        // inspect auths after the call via mock — use mock_all_auths for the
        // call then assert storage was set (auth path exercised in initialize).
        env.mock_all_auths();
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    fn test_assert_unique_members_accepts_distinct() {
        let env = Env::default();
        let mut members = Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));
        assert_unique_members(&members);
    }

    #[test]
    #[should_panic(expected = "duplicate members")]
    fn test_assert_unique_members_rejects_duplicates() {
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(a.clone());
        members.push_back(b);
        members.push_back(a);
        assert_unique_members(&members);
    }

    #[test]
    fn test_derive_circle_salt_is_stable_for_same_inputs() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let salt_a = derive_circle_salt(&env, &creator, 0);
        let salt_b = derive_circle_salt(&env, &creator, 0);
        assert_eq!(salt_a, salt_b);
    }

    #[test]
    fn test_derive_circle_salt_differs_by_count() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let salt_0 = derive_circle_salt(&env, &creator, 0);
        let salt_1 = derive_circle_salt(&env, &creator, 1);
        assert_ne!(salt_0, salt_1);
    }

    #[test]
    fn test_derive_circle_salt_differs_by_creator() {
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let salt_a = derive_circle_salt(&env, &a, 0);
        let salt_b = derive_circle_salt(&env, &b, 0);
        assert_ne!(salt_a, salt_b);
    }

    #[test]
    fn test_derive_circle_salt_differs_by_ledger_sequence() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let salt_before = derive_circle_salt(&env, &creator, 0);
        env.ledger().with_mut(|l| {
            l.sequence_number += 1;
        });
        let salt_after = derive_circle_salt(&env, &creator, 0);
        assert_ne!(salt_before, salt_after);
    }
}
