//! Storage compatibility fixtures for the circle contract (#867).
//!
//! Each test writes a historical storage layout directly into a freshly
//! registered contract instance (no `initialize`), then exercises the
//! CANDIDATE contract code against it and asserts either that values are
//! preserved or that the failure is deterministic (typed where the contract
//! offers a typed error).
//!
//! Layout history and fixture ids are declared in
//! `contracts/fixtures/storage/circle.layouts.json`; the
//! `manifest_and_tests_cover_the_same_fixtures` test keeps the two in sync.
//! See `docs/STORAGE_COMPATIBILITY.md` for the full inventory and the scope of
//! these claims.

use circle::{
    CircleConfig, CircleContract, CircleContractClient, CircleStatus, CloseError, ContractError,
    DataKey, PauseError, RoundState,
};
use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal, TryFromVal, Val, Vec};

const MANIFEST: &str = include_str!("../../fixtures/storage/circle.layouts.json");

/// Fixture ids implemented in this file. Must match the manifest exactly.
const IMPLEMENTED: [&str; 6] = [
    "circle.L1.pending-no-joins",
    "circle.L1.active-mid-round",
    "circle.L2.completed-unclosed",
    "circle.L3.active-paused",
    "circle.L3.completed-rounds-mismatch",
    "circle.L3.closed",
];

const ROUND_AMOUNT: i128 = 10_000_000;
const DEADLINE_LEDGERS: u32 = 1_000;

// ─── Fixture plumbing ─────────────────────────────────────────────────────────

struct Legacy {
    env: Env,
    id: Address,
    client: CircleContractClient<'static>,
    members: Vec<Address>,
    usdc: Address,
}

fn blank(member_count: u32) -> Legacy {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, CircleContract);
    let client = CircleContractClient::new(&env, &id);
    let mut members = Vec::new(&env);
    for _ in 0..member_count {
        members.push_back(Address::generate(&env));
    }
    Legacy {
        usdc: Address::generate(&env),
        env,
        id,
        client,
        members,
    }
}

impl Legacy {
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

    fn has_instance(&self, key: DataKey) -> bool {
        self.env
            .as_contract(&self.id, || self.env.storage().instance().has(&key))
    }

    fn member(&self, i: u32) -> Address {
        self.members.get(i).unwrap()
    }

    /// The L1 core: keys present since the initial layout.
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

    /// Keys added by L3 (#334, #335). Returns the admin.
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

// ─── L1 ───────────────────────────────────────────────────────────────────────

#[test]
fn l1_pending_no_joins_preserves_empty_collections() {
    // circle.L1.pending-no-joins
    let f = blank(3);
    f.write_l1_core(CircleStatus::Pending, Some(f.round0(0)), 0);

    assert_eq!(f.client.get_status(), CircleStatus::Pending);
    for i in 0..3 {
        let m = f.member(i);
        assert_eq!(f.client.get_collateral(&m), 0);
        assert!(!f.client.has_contributed(&m, &0));
        assert_eq!(f.client.get_defaults(&m), 0);
    }
    assert!(!f.client.is_closed());
    assert!(!f.client.is_paused());
    let cfg = f.client.get_config();
    assert_eq!(cfg.members.len(), 3);
    assert_eq!(cfg.round_amount, ROUND_AMOUNT);
}

#[test]
fn l1_active_mid_round_preserves_values_and_types_missing_admin() {
    // circle.L1.active-mid-round
    let f = blank(4);
    f.write_l1_core(CircleStatus::Active, Some(f.round0(1)), 0);
    f.persistent(DataKey::Collateral(f.member(0)), ROUND_AMOUNT);
    f.persistent(DataKey::Collateral(f.member(1)), ROUND_AMOUNT);
    f.persistent(DataKey::Contributed(f.member(0), 0), true);
    f.persistent(DataKey::Defaults(f.member(1)), 1u32);

    // Preserved values.
    assert_eq!(f.client.get_status(), CircleStatus::Active);
    let r = f.client.get_current_round();
    assert_eq!(r.round_index, 0);
    assert_eq!(r.recipient, f.member(0));
    assert_eq!(r.contributions_received, 1);
    assert_eq!(r.deadline_ledger, 5_000);
    assert!(!r.paid_out);
    let cfg = f.client.get_config();
    assert_eq!(cfg.usdc_token, f.usdc);
    assert_eq!(cfg.round_deadline_ledgers, DEADLINE_LEDGERS);
    assert_eq!(f.client.get_collateral(&f.member(0)), ROUND_AMOUNT);
    assert!(f.client.has_contributed(&f.member(0), &0));
    assert!(!f.client.has_contributed(&f.member(1), &0));
    assert_eq!(f.client.get_defaults(&f.member(1)), 1);

    // Keys introduced by L3 are absent → typed errors, never fabricated values.
    assert_eq!(f.client.try_get_admin(), Err(Ok(ContractError::NotInitialized)));
    assert_eq!(f.client.try_get_usdc_token(), Err(Ok(ContractError::NotInitialized)));
    assert_eq!(
        f.client.try_pause(&Address::generate(&f.env)),
        Err(Ok(PauseError::NotInitialized))
    );
    // Absent Paused key reads as "not paused" (additive key, safe default).
    assert!(!f.client.is_paused());
}

// ─── L2 ───────────────────────────────────────────────────────────────────────

/// Known compatibility gap: `close` on a pre-#334 instance (no `Admin` key)
/// fails deterministically with a host panic, not a typed `CloseError`.
/// Any migration that enables candidate code on such instances must write
/// `Admin` first. Documented in docs/STORAGE_COMPATIBILITY.md.
#[test]
#[should_panic(expected = "Admin missing")]
fn l2_completed_unclosed_close_without_admin_panics_deterministically() {
    // circle.L2.completed-unclosed
    let f = blank(2);
    f.write_l1_core(CircleStatus::Completed, None, 2);
    f.persistent(DataKey::Collateral(f.member(0)), ROUND_AMOUNT);
    f.persistent(DataKey::Collateral(f.member(1)), ROUND_AMOUNT);

    assert!(!f.client.is_closed());
    assert!(!f.has_instance(DataKey::Admin));
    f.client.close(&f.member(0));
}

// ─── L3 (current) ─────────────────────────────────────────────────────────────

#[test]
fn l3_active_paused_preserves_admin_and_can_resume() {
    // circle.L3.active-paused
    let f = blank(3);
    f.write_l1_core(CircleStatus::Active, Some(f.round0(0)), 0);
    let admin = f.write_l3_additions(true);

    assert!(f.client.is_paused());
    assert_eq!(f.client.get_admin(), admin);
    assert_eq!(f.client.get_usdc_token(), f.usdc);
    f.client.resume(&admin);
    assert!(!f.client.is_paused());
}

#[test]
fn l3_completed_with_rounds_mismatch_returns_typed_error() {
    // circle.L3.completed-rounds-mismatch
    let f = blank(3);
    f.write_l1_core(CircleStatus::Completed, None, 2); // 2 != 3 members
    f.write_l3_additions(false);

    assert_eq!(
        f.client.try_close(&f.member(0)),
        Err(Ok(CloseError::RoundsIncomplete))
    );
    assert!(!f.client.is_closed());
}

#[test]
fn l3_closed_rejects_second_close_with_typed_error() {
    // circle.L3.closed
    let f = blank(2);
    f.write_l1_core(CircleStatus::Completed, None, 2);
    f.write_l3_additions(false);
    f.instance(DataKey::Closed, true);

    assert!(f.client.is_closed());
    assert_eq!(f.client.try_close(&f.member(0)), Err(Ok(CloseError::AlreadyClosed)));
}

// ─── Encoding stability ───────────────────────────────────────────────────────

/// Persisted enum values must round-trip through `Val` unchanged; reordering
/// `CircleStatus` variants would silently reinterpret stored statuses.
#[test]
fn circle_status_encoding_round_trips() {
    let env = Env::default();
    for s in [
        CircleStatus::Pending,
        CircleStatus::Active,
        CircleStatus::Completed,
        CircleStatus::Cancelled,
    ] {
        let v: Val = s.clone().into_val(&env);
        let back = CircleStatus::try_from_val(&env, &v).unwrap();
        assert_eq!(back, s);
    }
}

// ─── Manifest linkage ─────────────────────────────────────────────────────────

fn manifest_ids(json: &str) -> std::vec::Vec<&str> {
    let needle = "\"id\": \"";
    let mut ids = std::vec::Vec::new();
    let mut rest = json;
    while let Some(start) = rest.find(needle) {
        let after = &rest[start + needle.len()..];
        let end = after.find('"').expect("unterminated id");
        ids.push(&after[..end]);
        rest = &after[end..];
    }
    ids
}

#[test]
fn manifest_and_tests_cover_the_same_fixtures() {
    let mut in_manifest = manifest_ids(MANIFEST);
    let mut implemented: std::vec::Vec<&str> = IMPLEMENTED.to_vec();
    in_manifest.sort_unstable();
    implemented.sort_unstable();
    assert_eq!(
        in_manifest, implemented,
        "circle.layouts.json and storage_compatibility_tests.rs must list the same fixture ids"
    );
}
