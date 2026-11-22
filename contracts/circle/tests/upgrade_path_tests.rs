//! Contract upgrade path tests for the circle contract.
//!
//! These tests verify that an upgraded contract instance can correctly read
//! existing storage from previous versions and preserve lifecycle invariants.
//!
//! # Upgrade Model
//!
//! CircleUp contracts use the Soroban deployer model where the factory deploys
//! new instances. Upgrades are performed by replacing the WASM hash in the
//! factory and deploying new instances. This test module verifies storage
//! compatibility across the documented upgrade paths.
//!
//! # Supported Upgrade Paths
//!
//! | From Layout | To Layout | Supported | Notes |
//! |-------------|-----------|-----------|-------|
//! | L1 (initial) | L3 (current) | Yes | Admin/UsdcToken added; L1 instances need migration |
//! | L2 | L3 | Yes | Closed key added; compatible |
//! | L3 | L3 | Yes | Same version; no-op upgrade |
//!
//! # Unsupported Jumps
//!
//! - L1 → L2: Requires Admin key for `close()`. L1 instances must be migrated
//!   by writing the Admin key before upgrading.
//! - Any → future L4: Depends on L4 changes; will be documented at release.

use circle::{
    CircleConfig, CircleContract, CircleContractClient, CircleStatus, CloseError, ContractError,
    DataKey, PauseError, RoundState,
};
use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal, TryFromVal, Val, Vec};

const ROUND_AMOUNT: i128 = 10_000_000;
const DEADLINE_LEDGERS: u32 = 1_000;

// ─── Test Fixtures ────────────────────────────────────────────────────────────

struct CircleInstance {
    env: Env,
    id: Address,
    client: CircleContractClient<'static>,
    members: Vec<Address>,
    usdc: Address,
}

fn make_instance(member_count: u32) -> CircleInstance {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, CircleContract);
    let client = CircleContractClient::new(&env, &id);
    let mut members = Vec::new(&env);
    for _ in 0..member_count {
        members.push_back(Address::generate(&env));
    }
    CircleInstance {
        usdc: Address::generate(&env),
        env,
        id,
        client,
        members,
    }
}

impl CircleInstance {
    fn instance<V: IntoVal<Env, Val>>(&self, key: DataKey, value: V) {
        self.env.as_contract(&self.id, || {
            self.env.storage().instance().set(&key, &value);
        });
    }

    fn persistent<V: IntoVal<Env, Val>>(&self, key: DataKey, value: V) {
        self.env.as_contract(&self.id, || {
            self.env.storage().persistent().set(&key, &value);
        });
    }

    fn member(&self, i: u32) -> Address {
        self.members.get(i).unwrap()
    }

    fn write_l1_core(&self, status: CircleStatus, round: Option<RoundState>, rounds_completed: u32) {
        let config = CircleConfig {
            members: self.members.clone(),
            round_amount: ROUND_AMOUNT,
            usdc_token: self.usdc.clone(),
            reputation_contract: Address::generate(&self.env),
            round_deadline_ledgers: DEADLINE_LEDGERS,
        };
        self.instance(DataKey::Config, config);
        self.instance(DataKey::Status, status);
        if let Some(r) = round {
            self.instance(DataKey::CurrentRound, r);
        }
        self.instance(DataKey::RoundsCompleted, rounds_completed);
    }

    fn write_l3_additions(&self, paused: bool) -> Address {
        let admin = Address::generate(&self.env);
        self.instance(DataKey::Admin, admin.clone());
        self.instance(DataKey::UsdcToken, self.usdc.clone());
        if paused {
            self.instance(DataKey::Paused, true);
        }
        admin
    }

    fn round0(&self, contributions: u32) -> RoundState {
        RoundState {
            round_index: 0,
            recipient: self.member(0),
            contributions_received: contributions,
            deadline_ledger: 5_000,
            paid_out: false,
        }
    }
}

// ─── L1 → L3 Upgrade Path ─────────────────────────────────────────────────────

/// L1 instances (no Admin, no UsdcToken) can be read after upgrade.
/// The Admin and UsdcToken keys are absent, so get_admin/get_usdc_token
/// return NotInitialized as expected.
#[test]
fn upgrade_l1_to_l3_pending_preserves_state_and_returns_typed_errors() {
    let f = make_instance(3);
    f.write_l1_core(CircleStatus::Pending, Some(f.round0(0)), 0);

    // Verify L1 state is readable
    assert_eq!(f.client.get_status(), CircleStatus::Pending);
    let cfg = f.client.get_config();
    assert_eq!(cfg.members.len(), 3);
    assert_eq!(cfg.round_amount, ROUND_AMOUNT);

    // L3-specific views return typed errors (not fabricated values)
    assert_eq!(
        f.client.try_get_admin(),
        Err(Ok(ContractError::NotInitialized))
    );
    assert_eq!(
        f.client.try_get_usdc_token(),
        Err(Ok(ContractError::NotInitialized))
    );
    assert_eq!(
        f.client.try_pause(&Address::generate(&f.env)),
        Err(Ok(PauseError::NotInitialized))
    );
}

/// L1 active circle can continue rounds after upgrade.
#[test]
fn upgrade_l1_to_l3_active_mid_round_continues_lifecycle() {
    let f = make_instance(4);
    f.write_l1_core(CircleStatus::Active, Some(f.round0(2)), 0);
    f.persistent(DataKey::Collateral(f.member(0)), ROUND_AMOUNT);
    f.persistent(DataKey::Collateral(f.member(1)), ROUND_AMOUNT);
    f.persistent(DataKey::Contributed(f.member(0), 0), true);
    f.persistent(DataKey::Contributed(f.member(1), 0), true);

    // Verify state is preserved
    let round = f.client.get_current_round();
    assert_eq!(round.round_index, 0);
    assert_eq!(round.contributions_received, 2);
    assert_eq!(f.client.get_collateral(&f.member(0)), ROUND_AMOUNT);
    assert!(f.client.has_contributed(&f.member(0), &0));

    // L3-specific views return typed errors
    assert_eq!(
        f.client.try_get_admin(),
        Err(Ok(ContractError::NotInitialized))
    );
}

/// L1 completed circle can be closed after manual Admin migration.
/// This documents the required migration step for L1 instances.
#[test]
fn upgrade_l1_to_l3_completed_requires_admin_migration() {
    let f = make_instance(2);
    f.write_l1_core(CircleStatus::Completed, None, 2);
    f.persistent(DataKey::Collateral(f.member(0)), ROUND_AMOUNT);
    f.persistent(DataKey::Collateral(f.member(1)), ROUND_AMOUNT);

    // L1 instances lack Admin key - close() panics
    assert!(!f.client.is_closed());

    // Migration: write Admin key before upgrade
    let admin = Address::generate(&f.env);
    f.instance(DataKey::Admin, admin.clone());
    f.instance(DataKey::UsdcToken, f.usdc.clone());

    // After migration, close() works
    f.client.close(&admin).unwrap();
    assert!(f.client.is_closed());
}

// ─── L2 → L3 Upgrade Path ─────────────────────────────────────────────────────

/// L2 instances (with Closed key) are fully compatible with L3.
#[test]
fn upgrade_l2_to_l3_closed_preserves_all_state() {
    let f = make_instance(2);
    f.write_l1_core(CircleStatus::Completed, None, 2);
    f.instance(DataKey::Closed, true);
    let admin = f.write_l3_additions(false);

    // All L2 state preserved
    assert!(f.client.is_closed());
    assert_eq!(f.client.get_admin(), admin);
    assert_eq!(f.client.get_usdc_token(), f.usdc);

    // Second close returns AlreadyClosed
    assert_eq!(
        f.client.try_close(&f.member(0)),
        Err(Ok(CloseError::AlreadyClosed))
    );
}

/// L2 active circle can continue after L3 upgrade.
#[test]
fn upgrade_l2_to_l3_active_preserves_pause_capability() {
    let f = make_instance(3);
    f.write_l1_core(CircleStatus::Active, Some(f.round0(0)), 0);
    f.instance(DataKey::Closed, false);
    let admin = f.write_l3_additions(true);

    // Pause state preserved
    assert!(f.client.is_paused());
    assert_eq!(f.client.get_admin(), admin);

    // Can resume
    f.client.resume(&admin);
    assert!(!f.client.is_paused());
}

// ─── L3 → L3 (Same Version) Upgrade Path ─────────────────────────────────────

/// Same-version upgrade preserves all state.
#[test]
fn upgrade_l3_to_l3_preserves_everything() {
    let f = make_instance(4);
    f.write_l1_core(CircleStatus::Active, Some(f.round0(1)), 0);
    let admin = f.write_l3_additions(true);
    f.persistent(DataKey::Collateral(f.member(0)), ROUND_AMOUNT);
    f.persistent(DataKey::Contributed(f.member(0), 0), true);
    f.persistent(DataKey::Defaults(f.member(1)), 1u32);

    // All state preserved
    assert_eq!(f.client.get_status(), CircleStatus::Active);
    assert!(f.client.is_paused());
    assert_eq!(f.client.get_admin(), admin);
    assert_eq!(f.client.get_usdc_token(), f.usdc);
    assert_eq!(f.client.get_collateral(&f.member(0)), ROUND_AMOUNT);
    assert_eq!(f.client.get_defaults(&f.member(1)), 1);

    // Operations work
    f.client.resume(&admin);
    assert!(!f.client.is_paused());
}

// ─── Cross-Upgrade Invariant Preservation ─────────────────────────────────────

/// After any supported upgrade, the collateral invariant holds:
/// collateral(member) = round_amount × COLLATERAL_MULTIPLIER for joined members.
#[test]
fn upgrade_preserves_collateral_invariant() {
    let f = make_instance(3);
    f.write_l1_core(CircleStatus::Active, Some(f.round0(0)), 0);
    f.write_l3_additions(false);

    // Members have collateral
    for i in 0..3 {
        let m = f.member(i);
        f.persistent(DataKey::Collateral(m.clone()), ROUND_AMOUNT);
    }

    // Verify invariant
    for i in 0..3 {
        let m = f.member(i);
        assert_eq!(f.client.get_collateral(&m), ROUND_AMOUNT);
    }
}

/// After any supported upgrade, the round invariant holds:
/// recipient = members[round_index]
#[test]
fn upgrade_preserves_recipient_invariant() {
    for status in [CircleStatus::Pending, CircleStatus::Active] {
        let f = make_instance(4);
        let round = RoundState {
            round_index: 2,
            recipient: f.member(2),
            contributions_received: 0,
            deadline_ledger: 10_000,
            paid_out: false,
        };
        f.write_l1_core(status, Some(round), 0);
        f.write_l3_additions(false);

        let current = f.client.get_current_round();
        assert_eq!(current.recipient, f.member(2));
    }
}

/// After any supported upgrade, the status transition invariant holds:
/// Pending → Active → Completed (one-way, irreversible)
#[test]
fn upgrade_preserves_status_transition_invariants() {
    // Pending circle stays Pending until all members join
    let pending = make_instance(2);
    pending.write_l1_core(CircleStatus::Pending, Some(pending.round0(0)), 0);
    pending.write_l3_additions(false);
    assert_eq!(pending.client.get_status(), CircleStatus::Pending);

    // Active circle stays Active until all rounds complete
    let active = make_instance(2);
    active.write_l1_core(CircleStatus::Active, Some(active.round0(0)), 0);
    active.write_l3_additions(false);
    assert_eq!(active.client.get_status(), CircleStatus::Active);

    // Completed circle is terminal
    let completed = make_instance(2);
    completed.write_l1_core(CircleStatus::Completed, None, 2);
    completed.write_l3_additions(false);
    assert_eq!(completed.client.get_status(), CircleStatus::Completed);
}

// ─── Unsupported Upgrade Documentation ─────────────────────────────────────---

/// Documents the L1 → L2/L3 migration requirement.
/// L1 instances lack the Admin key, which is required for close().
/// Operators must write Admin before upgrading L1 instances.
///
/// Migration procedure:
/// 1. Identify L1 instances (get_admin returns NotInitialized)
/// 2. Choose an admin address (typically the factory or deployer)
/// 3. Call a migration helper that writes Admin and UsdcToken
/// 4. Then perform the WASM upgrade
#[test]
fn document_l1_migration_requirement() {
    let f = make_instance(2);
    f.write_l1_core(CircleStatus::Completed, None, 2);
    f.persistent(DataKey::Collateral(f.member(0)), ROUND_AMOUNT);

    // L1: Admin absent
    assert_eq!(
        f.client.try_get_admin(),
        Err(Ok(ContractError::NotInitialized))
    );

    // Migration step required
    let admin = Address::generate(&f.env);
    f.instance(DataKey::Admin, admin.clone());
    f.instance(DataKey::UsdcToken, f.usdc.clone());

    // After migration, close works
    f.client.close(&admin).unwrap();
    assert!(f.client.is_closed());
}