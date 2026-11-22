//! Storage compatibility fixtures for the circle factory (#867).
//!
//! Historical layouts are written directly into a fresh instance and read
//! back through the candidate code. Fixture ids are declared in
//! `contracts/fixtures/storage/circle_factory.layouts.json`.

use circle_factory::{CircleFactory, CircleFactoryClient, DataKey, FactoryError};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, IntoVal, Val, Vec};

const MANIFEST: &str = include_str!("../../fixtures/storage/circle_factory.layouts.json");

const IMPLEMENTED: [&str; 4] = [
    "factory.L1.empty-registry",
    "factory.L1.populated-registry",
    "factory.L1.registry-keys-absent",
    "factory.uninitialized",
];

struct Legacy {
    env: Env,
    id: Address,
    client: CircleFactoryClient<'static>,
}

struct ConfigKeys {
    admin: Address,
    wasm: BytesN<32>,
    reputation: Address,
    usdc: Address,
}

fn blank() -> Legacy {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, CircleFactory);
    let client = CircleFactoryClient::new(&env, &id);
    Legacy { env, id, client }
}

impl Legacy {
    fn instance<V: IntoVal<Env, Val>>(&self, key: DataKey, value: V) {
        self.env.as_contract(&self.id, || {
            self.env.storage().instance().set(&key, &value);
        });
    }

    fn write_config_keys(&self) -> ConfigKeys {
        let keys = ConfigKeys {
            admin: Address::generate(&self.env),
            wasm: BytesN::from_array(&self.env, &[7u8; 32]),
            reputation: Address::generate(&self.env),
            usdc: Address::generate(&self.env),
        };
        self.instance(DataKey::Admin, keys.admin.clone());
        self.instance(DataKey::CircleWasmHash, keys.wasm.clone());
        self.instance(DataKey::ReputationContract, keys.reputation.clone());
        self.instance(DataKey::UsdcToken, keys.usdc.clone());
        keys
    }

    fn write_registry(&self, circles: &Vec<Address>) {
        self.instance(DataKey::Circles, circles.clone());
        self.instance(DataKey::CircleCount, circles.len());
    }

    fn assert_config_preserved(&self, k: &ConfigKeys) {
        assert_eq!(self.client.get_admin(), k.admin);
        assert_eq!(self.client.get_circle_wasm_hash(), k.wasm);
        assert_eq!(self.client.get_reputation_contract(), k.reputation);
        assert_eq!(self.client.get_usdc_token(), k.usdc);
    }
}

#[test]
fn l1_empty_registry_preserved_and_cursor_typed() {
    // factory.L1.empty-registry
    let f = blank();
    let k = f.write_config_keys();
    f.write_registry(&Vec::new(&f.env));

    f.assert_config_preserved(&k);
    assert!(f.client.get_circles().is_empty());
    assert_eq!(f.client.get_circle_count(), 0);
    let page = f.client.get_circles_paginated(&0, &10);
    assert!(page.circles.is_empty());
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.total, 0);
    assert_eq!(
        f.client.try_get_circles_paginated(&1, &10),
        Err(Ok(FactoryError::CursorOutOfRange))
    );
}

#[test]
fn l1_populated_registry_preserves_order_and_count() {
    // factory.L1.populated-registry
    let f = blank();
    let k = f.write_config_keys();
    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);
    let c = Address::generate(&f.env);
    let mut circles = Vec::new(&f.env);
    circles.push_back(a.clone());
    circles.push_back(b.clone());
    circles.push_back(c.clone());
    f.write_registry(&circles);

    f.assert_config_preserved(&k);
    let got = f.client.get_circles();
    assert_eq!(got.len(), 3);
    assert_eq!(got.get(0).unwrap(), a);
    assert_eq!(got.get(1).unwrap(), b);
    assert_eq!(got.get(2).unwrap(), c);
    assert_eq!(f.client.get_circle_count(), 3);

    let page = f.client.get_circles_paginated(&1, &1);
    assert_eq!(page.circles.len(), 1);
    assert_eq!(page.circles.get(0).unwrap(), b);
    assert_eq!(page.next_cursor, Some(2));
    assert_eq!(page.total, 3);
}

#[test]
fn l1_registry_keys_absent_default_to_empty() {
    // factory.L1.registry-keys-absent
    let f = blank();
    let k = f.write_config_keys();

    f.assert_config_preserved(&k);
    assert!(f.client.get_circles().is_empty());
    assert_eq!(f.client.get_circle_count(), 0);
    assert_eq!(f.client.get_circles_paginated(&0, &1).total, 0);
}

/// Known gap: factory config getters panic (untyped) before initialize.
#[test]
#[should_panic(expected = "not initialized")]
fn uninitialized_getters_panic_deterministically() {
    // factory.uninitialized
    let f = blank();
    assert_eq!(
        f.client.try_get_circles_paginated(&0, &0),
        Err(Ok(FactoryError::InvalidPageLimit))
    );
    f.client.get_admin();
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
