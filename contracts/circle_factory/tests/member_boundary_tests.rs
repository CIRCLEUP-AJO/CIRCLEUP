//! Factory member-count bounds: invalid creation cannot mutate the registry (#889).

mod common;

use circle_factory::{FactoryError, MAX_MEMBERS, MIN_MEMBERS, MIN_ROUND_DEADLINE_LEDGERS};
use common::setup;
use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

fn make_members(env: &Env, count: u32) -> Vec<Address> {
    let mut members = Vec::new(env);
    for _ in 0..count {
        members.push_back(Address::generate(env));
    }
    members
}

fn assert_rejected_without_registry_mutation(count: u32, expected: FactoryError) {
    let r = setup();
    let count_before = r.client.get_circle_count();
    let circles_before = r.client.get_circles();

    let result = r.client.try_create_circle(
        &Address::generate(&r.env),
        &make_members(&r.env, count),
        &100_000_000i128,
        &MIN_ROUND_DEADLINE_LEDGERS,
    );

    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for member count {count}");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        expected
    );
    assert_eq!(r.client.get_circle_count(), count_before);
    assert_eq!(r.client.get_circles(), circles_before);
}

#[test]
fn member_count_just_below_minimum_is_rejected_before_registry_mutation() {
    assert_rejected_without_registry_mutation(MIN_MEMBERS - 1, FactoryError::TooFewMembers);
}

#[test]
fn member_count_just_above_maximum_is_rejected_before_registry_mutation() {
    assert_rejected_without_registry_mutation(MAX_MEMBERS + 1, FactoryError::TooManyMembers);
}
