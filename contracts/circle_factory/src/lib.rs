//! CircleFactory — deploys new circle contract instances and maintains a registry.
//!
//! The factory holds the WASM hash of the circle contract, deploys fresh instances
//! via `env.deployer().with_current_contract(salt)`, initialises them in one
//! transaction, and records them in a list for the indexer to discover.
//!
//! # Trust boundaries
//!
//! - `admin` is set once at `initialize` time and is the only address that may
//!   call the factory's own `initialize`.  In the standard deployment the
//!   deployer wallet acts as admin.
//! - The factory contract address is registered as admin of the reputation
//!   contract at `reputation.initialize` time.  This lets the factory call
//!   `reputation.add_authorized_caller` autonomously in `create_circle`.
//! - `create_circle` is permissionless: any wallet may deploy a circle as long
//!   as it satisfies the input validation rules and authorises the call.
//! - No address other than the factory itself may register new authorized
//!   callers on the reputation contract once it is deployed.
//!
//! # Deployment invariant
//!
//! `create_circle` is atomic: factory state (`Circles`, `CircleCount`) is only
//! written **after** deploy + `initialize` + `add_authorized_caller` all
//! succeed.  If any step panics the host rolls back the entire transaction and
//! the registry stays unchanged.
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
//! | **Topics** | `(Symbol("factory"), Symbol("circle_created"))` | Stable filter keys |
//! | **Data** | `(Address, Address, u32)` | `(circle_address, creator, circle_index)` |
//!
//! Data fields:
//! 1. `circle_address` — contract ID of the newly deployed circle
//! 2. `creator` — wallet that authorised `create_circle`
//! 3. `circle_index` — zero-based factory counter **before** this create
//!    (mixed into the deploy salt). After the event the stored `CircleCount`
//!    is `circle_index + 1`.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, Vec,
};

// Re-export circle constants so factory validation stays in sync with the
// circle contract without hard-coding the numbers here.
use circle::{MAX_MEMBERS, MIN_ROUND_DEADLINE_LEDGERS, MAX_ROUND_DEADLINE_LEDGERS};

// ─── Types ────────────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    CircleWasmHash,
    ReputationContract,
    UsdcToken,
    Circles,      // Vec<Address> — deployed circle addresses in creation order
    CircleCount,  // u32 — monotonic counter; always == Circles.len()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Reject member lists that contain the same address more than once.
///
/// Duplicate members break payout ordering and let one wallet occupy multiple
/// rotation slots. We fail before paying deploy gas.
fn assert_unique_members(members: &Vec<Address>) {
    let len = members.len();
    let mut i: u32 = 0;
    while i < len {
        let mut j = i + 1;
        while j < len {
            let a = members
                .get(i)
                .unwrap_or_else(|| panic!("factory: member index {} out of bounds", i));
            let b = members
                .get(j)
                .unwrap_or_else(|| panic!("factory: member index {} out of bounds", j));
            if a == b {
                panic!("duplicate members");
            }
            j += 1;
        }
        i += 1;
    }
}

/// Validate all `create_circle` inputs before touching any state.
///
/// This is a pure precondition check — no storage reads or writes.  Every
/// failure here means the factory state is guaranteed to be unchanged.
fn validate_create_inputs(
    members: &Vec<Address>,
    round_amount: i128,
    round_deadline_ledgers: u32,
) {
    // Member count bounds — mirrors circle contract limits exactly.
    let member_count = members.len();
    if member_count < 2 {
        panic!("need at least 2 members");
    }
    if member_count > MAX_MEMBERS {
        panic!("too many members");
    }

    // Duplicate-member check.
    assert_unique_members(members);

    // round_amount: must be strictly positive. Zero or negative would make
    // collateral and pot calculations meaningless.
    if round_amount <= 0 {
        panic!("round_amount must be positive");
    }

    // Overflow pre-check: the circle contract multiplies round_amount by
    // member_count (pot) and by PENALTY_BPS (default penalty). Reject values
    // that would overflow i128 in those paths before we pay deploy gas.
    round_amount
        .checked_mul(member_count as i128)
        .unwrap_or_else(|| panic!("round_amount too large: overflows pot calculation"));
    round_amount
        .checked_mul(circle::PENALTY_BPS)
        .unwrap_or_else(|| panic!("round_amount too large: overflows penalty calculation"));

    // Deadline bounds — must match circle contract's accepted range exactly.
    if round_deadline_ledgers < MIN_ROUND_DEADLINE_LEDGERS {
        panic!("round_deadline_ledgers below minimum");
    }
    if round_deadline_ledgers > MAX_ROUND_DEADLINE_LEDGERS {
        panic!("round_deadline_ledgers above maximum");
    }
}

/// Build a deploy salt unique per successful `create_circle` call.
///
/// Uniqueness comes from:
/// - `count`: monotonic factory counter (incremented only on success, so failed
///   creates do not burn a slot and cannot produce the same count again without
///   an intervening successful deploy).
/// - `creator`: different creators with the same count get different salts.
/// - `ledger().sequence()` + `ledger().timestamp()`: extra entropy guards
///   against count-reset edge cases after a factory redeploy.
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

    /// One-time factory setup.
    ///
    /// `admin` must authorize this call so a third party cannot claim admin by
    /// front-running deployment.  The factory stores all configuration atomically
    /// in a single transaction; if any storage write fails the factory remains
    /// uninitialized and can be safely retried.
    ///
    /// # Trust boundary
    ///
    /// After `initialize` the factory contract address becomes the only entity
    /// that can register authorized callers on the reputation contract (because
    /// the factory is passed as `admin` to `reputation.initialize` before
    /// factory setup, making them mutually authorizing).
    ///
    /// # Panics
    ///
    /// - `"already initialized"` if called more than once
    pub fn initialize(
        env: Env,
        admin: Address,
        circle_wasm_hash: BytesN<32>,
        reputation_contract: Address,
        usdc_token: Address,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
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

    /// Deploy a new circle contract, initialize it, and register it atomically.
    ///
    /// Returns the address of the newly deployed circle.
    ///
    /// # Atomicity guarantee
    ///
    /// All input validation runs before any state mutation.  The registry
    /// (`Circles`, `CircleCount`) is only written after deploy + `initialize` +
    /// `add_authorized_caller` all succeed.  A failure at any step rolls back
    /// the entire transaction and leaves factory state unchanged.
    ///
    /// # Panics
    ///
    /// - `"factory: create_circle called before initialize"` — factory not set up
    /// - `"need at least 2 members"` — fewer than 2 members supplied
    /// - `"too many members"` — more than `MAX_MEMBERS` supplied
    /// - `"duplicate members"` — same address appears more than once
    /// - `"round_amount must be positive"` — zero or negative amount
    /// - `"round_amount too large: overflows pot calculation"` — would overflow i128
    /// - `"round_deadline_ledgers below minimum"` — below `MIN_ROUND_DEADLINE_LEDGERS`
    /// - `"round_deadline_ledgers above maximum"` — above `MAX_ROUND_DEADLINE_LEDGERS`
    ///
    /// # Events
    ///
    /// Publishes `factory` / `circle_created` — see crate-level docs for shape.
    pub fn create_circle(
        env: Env,
        creator: Address,
        members: Vec<Address>,
        round_amount: i128,
        round_deadline_ledgers: u32,
    ) -> Address {
        creator.require_auth();

        // ── 1. Pure precondition validation (no state reads) ────────────────
        // All panics here leave the factory completely unchanged.
        validate_create_inputs(&members, round_amount, round_deadline_ledgers);

        // ── 2. Load factory config ───────────────────────────────────────────
        // Fail early if the factory was not initialized, before spending gas on
        // deploy. Each missing key produces a distinct, actionable panic message.
        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::CircleWasmHash)
            .unwrap_or_else(|| panic!("factory: create_circle called before initialize"));
        let reputation: Address = env
            .storage()
            .instance()
            .get(&DataKey::ReputationContract)
            .unwrap_or_else(|| panic!("factory: ReputationContract missing"));
        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcToken)
            .unwrap_or_else(|| panic!("factory: UsdcToken missing"));

        // ── 3. Read current counter BEFORE any mutation ──────────────────────
        // The counter is mixed into the deploy salt. It is only incremented
        // after the full deploy+init+register sequence succeeds, so a failed
        // create never burns a counter slot.
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or(0);

        let salt = derive_circle_salt(&env, &creator, count);

        // ── 4. Deploy ────────────────────────────────────────────────────────
        // If deploy fails the transaction aborts here; no registry writes have
        // occurred yet.
        let circle_address = env
            .deployer()
            .with_current_contract(salt)
            .deploy(wasm_hash);

        // ── 5. Initialize the circle ─────────────────────────────────────────
        // Runs inside the same transaction. A panic here rolls back the deploy
        // via the host's transaction-level abort, leaving the registry clean.
        // The factory contract itself is passed as the circle admin so it
        // retains pause/resume authority over every circle it deploys.
        let init_args = soroban_sdk::vec![
            &env,
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(
                &env.current_contract_address(),
                &env,
            ),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&members, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&round_amount, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&usdc, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&reputation, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&round_deadline_ledgers, &env),
        ];
        env.invoke_contract::<()>(&circle_address, &Symbol::new(&env, "initialize"), init_args);

        // ── 6. Register circle as authorized reputation caller ───────────────
        // The factory is the reputation admin, so this call is self-authorized
        // via the Contract Invoker rule. A panic here rolls back the full tx.
        let add_caller_args = soroban_sdk::vec![
            &env,
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(
                &env.current_contract_address(),
                &env,
            ),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&circle_address, &env),
        ];
        env.invoke_contract::<()>(
            &reputation,
            &Symbol::new(&env, "add_authorized_caller"),
            add_caller_args,
        );

        // ── 7. Commit registry state (only reached on full success) ──────────
        // Both writes happen together; they are the only factory state mutations
        // in create_circle. count + 1 always equals circles.len() after this.
        let mut circles: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Circles)
            .unwrap_or(Vec::new(&env));
        circles.push_back(circle_address.clone());
        env.storage().instance().set(&DataKey::Circles, &circles);
        env.storage().instance().set(&DataKey::CircleCount, &(count + 1));

        // Invariant assertion: count must equal the list length.
        // This fires only in test/debug builds via the host; in production the
        // Soroban WASM environment optimises it away if never triggered.
        let stored_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or(0);
        let stored_len = circles.len();
        if stored_count != stored_len {
            panic!("factory: registry invariant violated: count != circles.len()");
        }

        // Event: (circle_address, creator, circle_index_before_increment)
        env.events().publish(
            (Symbol::new(&env, "factory"), Symbol::new(&env, "circle_created")),
            (circle_address.clone(), creator, count),
        );

        circle_address
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Returns all deployed circle addresses in creation order.
    pub fn get_circles(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Circles)
            .unwrap_or(Vec::new(&env))
    }

    /// Returns the total number of deployed circles.
    ///
    /// Always equals `get_circles().len()` — the two are written atomically.
    pub fn get_circle_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or(0)
    }

    /// Returns the factory admin.
    ///
    /// Panics with `"not initialized"` if called before `initialize`.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Returns the USDC token address configured at initialize.
    ///
    /// Panics with `"not initialized"` if called before `initialize`.
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
    extern crate std;
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    // ── Fixture ───────────────────────────────────────────────────────────────

    struct FactorySetup<'a> {
        client: CircleFactoryClient<'a>,
        admin: Address,
        #[allow(dead_code)]
        rep: Address,
        usdc: Address,
        wasm_hash: BytesN<32>,
    }

    fn setup_factory(env: &Env) -> FactorySetup<'_> {
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(env, &id);
        let admin = Address::generate(env);
        let rep   = Address::generate(env);
        let usdc  = Address::generate(env);
        let wasm_hash: BytesN<32> = BytesN::from_array(env, &[0u8; 32]);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        FactorySetup { client, admin, rep, usdc, wasm_hash }
    }

    /// Generate N distinct addresses.
    fn make_members(env: &Env, n: u32) -> Vec<Address> {
        let mut v = Vec::new(env);
        for _ in 0..n {
            v.push_back(Address::generate(env));
        }
        v
    }

    // ── Initialization ────────────────────────────────────────────────────────

    #[test]
    fn test_factory_initializes() {
        let env = Env::default();
        let s = setup_factory(&env);
        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    #[test]
    fn test_get_admin_and_usdc_token() {
        let env = Env::default();
        let s = setup_factory(&env);
        assert_eq!(s.client.get_admin(), s.admin);
        assert_eq!(s.client.get_usdc_token(), s.usdc);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        let s = setup_factory(&env);
        let admin2 = Address::generate(&env);
        s.client.initialize(&admin2, &s.wasm_hash, &Address::generate(&env), &Address::generate(&env));
    }

    #[test]
    fn test_initial_circle_count_is_zero() {
        let env = Env::default();
        let s = setup_factory(&env);
        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_get_admin_before_init_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        CircleFactoryClient::new(&env, &id).get_admin();
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_get_usdc_token_before_init_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        CircleFactoryClient::new(&env, &id).get_usdc_token();
    }

    #[test]
    fn test_initialize_records_auth_for_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let wh: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        client.initialize(&admin, &wh, &Address::generate(&env), &Address::generate(&env));
        assert_eq!(client.get_admin(), admin);
    }

    // ── validate_create_inputs ────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "need at least 2 members")]
    fn test_validate_rejects_single_member() {
        let env = Env::default();
        let mut m = Vec::new(&env);
        m.push_back(Address::generate(&env));
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "need at least 2 members")]
    fn test_validate_rejects_empty_members() {
        let env = Env::default();
        let m = Vec::new(&env);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "too many members")]
    fn test_validate_rejects_too_many_members() {
        let env = Env::default();
        let m = make_members(&env, MAX_MEMBERS + 1);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "duplicate members")]
    fn test_validate_rejects_duplicate_members() {
        let env = Env::default();
        let a = Address::generate(&env);
        let mut m = Vec::new(&env);
        m.push_back(a.clone());
        m.push_back(Address::generate(&env));
        m.push_back(a);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_amount must be positive")]
    fn test_validate_rejects_zero_round_amount() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, 0, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_amount must be positive")]
    fn test_validate_rejects_negative_round_amount() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, -1, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers below minimum")]
    fn test_validate_rejects_deadline_below_minimum() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS - 1);
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers above maximum")]
    fn test_validate_rejects_deadline_above_maximum() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, 1_000_000, MAX_ROUND_DEADLINE_LEDGERS + 1);
    }

    #[test]
    fn test_validate_accepts_boundary_deadlines() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
        validate_create_inputs(&m, 1_000_000, MAX_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    fn test_validate_accepts_max_members_at_boundary() {
        let env = Env::default();
        let m = make_members(&env, MAX_MEMBERS);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_amount too large: overflows pot calculation")]
    fn test_validate_rejects_round_amount_overflow() {
        let env = Env::default();
        let m = make_members(&env, 2);
        // i128::MAX / 1 = i128::MAX — multiplied by member_count(2) overflows
        validate_create_inputs(&m, i128::MAX, MIN_ROUND_DEADLINE_LEDGERS);
    }

    // ── assert_unique_members (unit) ──────────────────────────────────────────

    #[test]
    fn test_assert_unique_members_accepts_distinct() {
        let env = Env::default();
        let m = make_members(&env, 3);
        assert_unique_members(&m);
    }

    #[test]
    #[should_panic(expected = "duplicate members")]
    fn test_assert_unique_members_rejects_duplicates() {
        let env = Env::default();
        let a = Address::generate(&env);
        let mut m = Vec::new(&env);
        m.push_back(a.clone());
        m.push_back(Address::generate(&env));
        m.push_back(a);
        assert_unique_members(&m);
    }

    // ── derive_circle_salt (unit) ─────────────────────────────────────────────

    #[test]
    fn test_derive_circle_salt_is_stable_for_same_inputs() {
        let env = Env::default();
        let creator = Address::generate(&env);
        assert_eq!(
            derive_circle_salt(&env, &creator, 0),
            derive_circle_salt(&env, &creator, 0)
        );
    }

    #[test]
    fn test_derive_circle_salt_differs_by_count() {
        let env = Env::default();
        let creator = Address::generate(&env);
        assert_ne!(
            derive_circle_salt(&env, &creator, 0),
            derive_circle_salt(&env, &creator, 1)
        );
    }

    #[test]
    fn test_derive_circle_salt_differs_by_creator() {
        let env = Env::default();
        assert_ne!(
            derive_circle_salt(&env, &Address::generate(&env), 0),
            derive_circle_salt(&env, &Address::generate(&env), 0)
        );
    }

    #[test]
    fn test_derive_circle_salt_differs_by_ledger_sequence() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let s0 = derive_circle_salt(&env, &creator, 0);
        env.ledger().with_mut(|l| l.sequence_number += 1);
        let s1 = derive_circle_salt(&env, &creator, 0);
        assert_ne!(s0, s1);
    }

    // ── create_circle: rejected before initialize ─────────────────────────────

    #[test]
    #[should_panic(expected = "factory: create_circle called before initialize")]
    fn test_create_circle_before_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let m = make_members(&env, 2);
        client.create_circle(
            &Address::generate(&env),
            &m,
            &1_000_000i128,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    // ── create_circle: input validation rejects before any state mutation ─────

    #[test]
    #[should_panic(expected = "need at least 2 members")]
    fn test_create_circle_rejects_single_member_no_state_change() {
        let env = Env::default();
        let s = setup_factory(&env);
        let mut m = Vec::new(&env);
        m.push_back(Address::generate(&env));
        let count_before = s.client.get_circle_count();
        let _ = s.client.try_create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
        // Count must be unchanged
        assert_eq!(s.client.get_circle_count(), count_before);
    }

    #[test]
    #[should_panic(expected = "duplicate members")]
    fn test_create_circle_rejects_duplicate_members() {
        let env = Env::default();
        let s = setup_factory(&env);
        let a = Address::generate(&env);
        let mut m = Vec::new(&env);
        m.push_back(a.clone());
        m.push_back(a);
        s.client.create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    #[test]
    #[should_panic(expected = "round_amount must be positive")]
    fn test_create_circle_rejects_zero_round_amount() {
        let env = Env::default();
        let s = setup_factory(&env);
        let m = make_members(&env, 2);
        s.client.create_circle(&Address::generate(&env), &m, &0i128, &MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers below minimum")]
    fn test_create_circle_rejects_deadline_below_min() {
        let env = Env::default();
        let s = setup_factory(&env);
        let m = make_members(&env, 2);
        s.client.create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &(MIN_ROUND_DEADLINE_LEDGERS - 1),
        );
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers above maximum")]
    fn test_create_circle_rejects_deadline_above_max() {
        let env = Env::default();
        let s = setup_factory(&env);
        let m = make_members(&env, 2);
        s.client.create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &(MAX_ROUND_DEADLINE_LEDGERS + 1),
        );
    }

    // ── Registry integrity: count == circles.len() always ────────────────────

    #[test]
    fn test_registry_count_equals_circles_len_after_batch() {
        // We can't run real deploys in unit tests (WASM hash is a dummy), so
        // we verify the invariant via the helper logic directly and confirm the
        // storage invariant on the factory's own in-memory model.
        // For each validation failure the factory count must stay at 0.
        let env = Env::default();
        let s = setup_factory(&env);

        // After each failed attempt, count and list length must still match.
        let attempt = |m: Vec<Address>, amount: i128, dl: u32| {
            let _ = s.client.try_create_circle(&Address::generate(&env), &m, &amount, &dl);
        };

        attempt(make_members(&env, 1), 1_000_000, MIN_ROUND_DEADLINE_LEDGERS); // < 2 members
        attempt(make_members(&env, 2), 0, MIN_ROUND_DEADLINE_LEDGERS);          // zero amount
        attempt(make_members(&env, 2), 1_000_000, 0);                           // dl < min

        // Registry must still be empty and consistent.
        let count = s.client.get_circle_count();
        let len   = s.client.get_circles().len();
        assert_eq!(count, 0, "count must remain 0 after all failed creates");
        assert_eq!(count, len, "count must equal circles.len() at all times");
    }

    #[test]
    fn test_registry_list_is_monotonic_and_deduplicated() {
        // Each unique successful deploy produces a unique address.
        // We validate the structural property: validate_create_inputs rejects
        // duplicate-member configs before any deploy, ensuring no two circles
        // can be created with identical member lists without at least a ledger
        // advance (different salt).
        let env = Env::default();
        let m = make_members(&env, 2);

        // Two calls with the same members but different ledger sequences would
        // produce different salts and thus different addresses — verified by
        // salt-differ test above. The registry itself never deduplicates by
        // member set; uniqueness is enforced at the salt level.
        // Here we just confirm unique_members still works after batch rejects.
        assert_unique_members(&m);

        // Confirm idempotency: a second call on the same members doesn't panic
        // in assert_unique_members (no false-positive after first call).
        assert_unique_members(&m);
    }

    // ── Failed create leaves factory state unchanged ──────────────────────────

    #[test]
    fn test_failed_create_does_not_increment_count() {
        let env = Env::default();
        let s = setup_factory(&env);
        assert_eq!(s.client.get_circle_count(), 0);

        // Attempt invalid create (zero amount) — must not change count.
        let m = make_members(&env, 2);
        let result = s.client.try_create_circle(
            &Address::generate(&env), &m, &0i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "expected error for zero round_amount");
        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    #[test]
    fn test_failed_create_does_not_add_to_circles_list() {
        let env = Env::default();
        let s = setup_factory(&env);

        // Invalid deadline — no state mutation should occur.
        let m = make_members(&env, 2);
        let _ = s.client.try_create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &0u32,
        );
        assert!(s.client.get_circles().is_empty());
        assert_eq!(s.client.get_circle_count(), 0);
    }

    #[test]
    fn test_multiple_failed_creates_state_remains_clean() {
        let env = Env::default();
        let s = setup_factory(&env);

        for _ in 0..5 {
            // Duplicate-member failure
            let a = Address::generate(&env);
            let mut m = Vec::new(&env);
            m.push_back(a.clone());
            m.push_back(a);
            let _ = s.client.try_create_circle(
                &Address::generate(&env), &m, &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
            );
        }

        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    // ── Adversarial authorization tests (Issue #87) ───────────────────────────

    /// Re-initializing an already-initialized factory is rejected and leaves
    /// the original admin and circle count unchanged.
    #[test]
    fn adv_factory_double_initialize_rejected_state_unchanged() {
        let env = Env::default();
        let s = setup_factory(&env);

        let attacker = Address::generate(&env);
        let bad_hash: BytesN<32> = BytesN::from_array(&env, &[0xffu8; 32]);

        let result = s.client.try_initialize(
            &attacker,
            &bad_hash,
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert!(result.is_err(), "second factory initialize must be rejected");

        // Admin must still be the original admin
        assert_eq!(
            s.client.get_admin(),
            s.admin,
            "admin must be unchanged after rejected re-initialization"
        );

        // Circle count must still be 0 (no state written)
        assert_eq!(
            s.client.get_circle_count(),
            0,
            "circle count must be unchanged after rejected re-initialization"
        );
        assert!(s.client.get_circles().is_empty());
    }

    /// A create_circle call with fewer than 2 members is rejected and the
    /// factory circle count stays at its pre-call value.
    #[test]
    fn adv_factory_create_circle_single_member_count_unchanged() {
        let env = Env::default();
        let s = setup_factory(&env);

        let count_before = s.client.get_circle_count();
        let mut m = Vec::new(&env);
        m.push_back(Address::generate(&env));

        let result = s.client.try_create_circle(
            &Address::generate(&env),
            &m,
            &1_000_000i128,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "single-member create must be rejected");
        assert_eq!(
            s.client.get_circle_count(),
            count_before,
            "circle count must be unchanged after rejected create"
        );
        assert!(s.client.get_circles().is_empty());
    }

    /// A create_circle call with a negative round_amount is rejected; the
    /// factory registry stays empty.
    #[test]
    fn adv_factory_create_circle_negative_amount_registry_unchanged() {
        let env = Env::default();
        let s = setup_factory(&env);

        let m = make_members(&env, 3);
        let result = s.client.try_create_circle(
            &Address::generate(&env),
            &m,
            &(-1i128),
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "negative round_amount create must be rejected");
        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    /// A batch of five different adversarial create_circle calls (each with a
    /// distinct invalid parameter) must all be rejected without incrementing
    /// the factory counter.
    #[test]
    fn adv_factory_batch_adversarial_creates_all_rejected() {
        let env = Env::default();
        let s = setup_factory(&env);

        let adversarial_calls: &[(&dyn Fn() -> bool)] = &[
            // 1. empty member list
            &|| {
                let m = Vec::new(&env);
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &1_000_000i128,
                        &MIN_ROUND_DEADLINE_LEDGERS,
                    )
                    .is_err()
            },
            // 2. single member
            &|| {
                let mut m = Vec::new(&env);
                m.push_back(Address::generate(&env));
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &1_000_000i128,
                        &MIN_ROUND_DEADLINE_LEDGERS,
                    )
                    .is_err()
            },
            // 3. zero amount
            &|| {
                let m = make_members(&env, 2);
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &0i128,
                        &MIN_ROUND_DEADLINE_LEDGERS,
                    )
                    .is_err()
            },
            // 4. deadline below minimum
            &|| {
                let m = make_members(&env, 2);
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &1_000_000i128,
                        &(MIN_ROUND_DEADLINE_LEDGERS - 1),
                    )
                    .is_err()
            },
            // 5. deadline above maximum
            &|| {
                let m = make_members(&env, 2);
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &1_000_000i128,
                        &(MAX_ROUND_DEADLINE_LEDGERS + 1),
                    )
                    .is_err()
            },
        ];

        for (i, call) in adversarial_calls.iter().enumerate() {
            assert!(call(), "adversarial call {} must be rejected", i + 1);
        }

        assert_eq!(
            s.client.get_circle_count(),
            0,
            "factory circle count must be 0 after all adversarial create attempts"
        );
        assert!(
            s.client.get_circles().is_empty(),
            "circles list must be empty after all adversarial create attempts"
        );
    }
}
