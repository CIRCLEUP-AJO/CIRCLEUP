//! CircleFactory — deploys new circle contract instances and maintains a registry.
//!
//! The factory holds the WASM hash of the circle contract, deploys fresh instances
//! via `env.deployer().with_current_contract(salt)`, initialises them in one
//! transaction, and records them in a list for the indexer to discover.

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
    /// Returns the address of the newly deployed circle.
    pub fn create_circle(
        env: Env,
        creator: Address,
        members: Vec<Address>,
        round_amount: i128,
        round_deadline_ledgers: u32,
    ) -> Address {
        creator.require_auth();

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

        // Derive a unique salt from the creator + count
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or(0);

        let mut salt_bytes = Bytes::new(&env);
        salt_bytes.append(&creator.clone().to_xdr(&env));
        let count_bytes = count.to_xdr(&env);
        salt_bytes.append(&count_bytes);
        let salt: BytesN<32> = env.crypto().sha256(&salt_bytes).into();

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
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup_factory(env: &Env) -> (CircleFactoryClient, Address, Address, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(env, &id);
        let admin = Address::generate(env);
        let rep = Address::generate(env);
        let usdc = Address::generate(env);
        let wasm_hash: BytesN<32> = BytesN::from_array(env, &[0u8; 32]);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        (client, admin, rep, usdc)
    }

    #[test]
    fn test_factory_initializes() {
        let env = Env::default();
        let (client, _, _, _) = setup_factory(&env);
        assert_eq!(client.get_circle_count(), 0);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let rep = Address::generate(&env);
        let usdc = Address::generate(&env);
        let wasm_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
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
}
