//! Storage compatibility fixtures for the reputation contract (#867).
//!
//! Historical layouts are written directly into a fresh instance and read
//! back through the candidate code. Fixture ids are declared in
//! `contracts/fixtures/storage/reputation.layouts.json`.

use reputation::{DataKey, ReputationContract, ReputationContractClient, ReputationError};
use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal, Val, Vec};

const MANIFEST: &str = include_str!("../../fixtures/storage/reputation.layouts.json");

const IMPLEMENTED: [&str; 4] = [
    "reputation.L1.pre-revocation",
    "reputation.L2.populated",
    "reputation.L2.fresh-empty",
    "reputation.uninitialized",
];

struct Legacy {
    env: Env,
    id: Address,
    client: ReputationContractClient<'static>,
}

fn blank() -> Legacy {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &id);
    Legacy { env, id, client }
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

    fn list(&self, items: &[&Address]) -> Vec<Address> {
        let mut v = Vec::new(&self.env);
        for a in items {
            v.push_back((*a).clone());
        }
        v
    }
}

#[test]
fn l1_pre_revocation_layout_preserved_and_revocation_applies_lazily() {
    // reputation.L1.pre-revocation
    let f = blank();
    let admin = Address::generate(&f.env);
    let circle = Address::generate(&f.env);
    let member = Address::generate(&f.env);
    f.instance(DataKey::Admin, admin.clone());
    f.instance(DataKey::AuthorizedCallers, f.list(&[&circle]));
    f.persistent(DataKey::Score(member.clone()), 3u32);

    assert_eq!(f.client.score(&member), 3);
    assert!(f.client.get_revoked_callers().is_empty());
    assert_eq!(f.client.get_authorized_callers().len(), 1);

    f.client.increment(&circle, &member);
    assert_eq!(f.client.score(&member), 4);

    // Revocation works on a layout that predates the RevokedCallers key.
    f.client.remove_authorized_caller(&admin, &circle);
    assert_eq!(f.client.get_revoked_callers().len(), 1);
    assert_eq!(
        f.client.try_add_authorized_caller(&admin, &circle),
        Err(Ok(ReputationError::CallerRevoked))
    );
}

#[test]
fn l2_populated_preserves_scores_and_revocations() {
    // reputation.L2.populated
    let f = blank();
    let admin = Address::generate(&f.env);
    let live = Address::generate(&f.env);
    let revoked = Address::generate(&f.env);
    let member = Address::generate(&f.env);
    f.instance(DataKey::Admin, admin.clone());
    f.instance(DataKey::AuthorizedCallers, f.list(&[&live]));
    f.instance(DataKey::RevokedCallers, f.list(&[&revoked]));
    f.persistent(DataKey::Score(member.clone()), 7u32);

    assert_eq!(f.client.score(&member), 7);
    assert_eq!(f.client.get_admin(), admin);
    assert_eq!(
        f.client.try_increment(&revoked, &member),
        Err(Ok(ReputationError::UnauthorizedCaller))
    );
    assert_eq!(
        f.client.try_add_authorized_caller(&admin, &revoked),
        Err(Ok(ReputationError::CallerRevoked))
    );
    assert_eq!(f.client.score(&member), 7, "failed calls must not change the score");

    f.client.increment(&live, &member);
    assert_eq!(f.client.score(&member), 8);
}

#[test]
fn l2_fresh_empty_reads_zero_and_rejects_unknown_callers() {
    // reputation.L2.fresh-empty
    let f = blank();
    f.instance(DataKey::Admin, Address::generate(&f.env));
    f.instance(DataKey::AuthorizedCallers, Vec::<Address>::new(&f.env));
    f.instance(DataKey::RevokedCallers, Vec::<Address>::new(&f.env));

    let member = Address::generate(&f.env);
    assert_eq!(f.client.score(&member), 0);
    assert_eq!(
        f.client.try_increment(&Address::generate(&f.env), &member),
        Err(Ok(ReputationError::UnauthorizedCaller))
    );
}

#[test]
fn uninitialized_increment_is_a_typed_error() {
    // reputation.uninitialized
    let f = blank();
    let member = Address::generate(&f.env);
    assert_eq!(
        f.client.try_increment(&Address::generate(&f.env), &member),
        Err(Ok(ReputationError::NotInitialized))
    );
    assert_eq!(f.client.score(&member), 0);
}

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
    assert_eq!(in_manifest, implemented);
}
