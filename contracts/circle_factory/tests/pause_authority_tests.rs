//! Pause authority for factory-deployed circles (#876).
//!
//! `create_circle` passes the factory's own contract address as the circle
//! `admin`. The factory exposes no `pause` / `resume` (or any forwarding)
//! entrypoint, and a contract address can only authorize calls it makes
//! itself — so **no account can pause a factory-deployed circle**. These
//! tests pin that fact so that adding such an entrypoint is a deliberate,
//! reviewed change (it would introduce a new emergency authority).

use circle::{CircleContract, CircleContractClient, PauseError};
use circle_factory::CircleFactory;
use reputation::{ReputationContract, ReputationContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Error, IntoVal, Symbol, Val, Vec};

#[test]
fn factory_has_no_pause_or_resume_entrypoint() {
    let env = Env::default();
    env.mock_all_auths();
    let factory = env.register_contract(None, CircleFactory);
    let circle = Address::generate(&env);
    for name in ["pause", "resume", "pause_circle", "resume_circle", "set_admin", "upgrade"] {
        let args: Vec<Val> = soroban_sdk::vec![&env, circle.into_val(&env)];
        let r = env.try_invoke_contract::<(), Error>(&factory, &Symbol::new(&env, name), args);
        assert!(r.is_err(), "factory must not expose `{name}`");
    }
}

#[test]
fn circle_with_factory_admin_rejects_every_account_as_pauser() {
    let env = Env::default();
    env.mock_all_auths();
    let factory = env.register_contract(None, CircleFactory);

    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let rep_id = env.register_contract(None, ReputationContract);
    ReputationContractClient::new(&env, &rep_id).initialize(&Address::generate(&env));

    let id = env.register_contract(None, CircleContract);
    let circle = CircleContractClient::new(&env, &id);
    let mut members = Vec::new(&env);
    members.push_back(Address::generate(&env));
    members.push_back(Address::generate(&env));
    // Same admin create_circle supplies: the factory contract address.
    circle.initialize(&factory, &members, &10_000_000, &sac.address(), &rep_id, &1_000);

    assert_eq!(circle.get_admin(), factory);
    for caller in [members.get(0).unwrap(), Address::generate(&env)] {
        assert_eq!(circle.try_pause(&caller), Err(Ok(PauseError::Unauthorized)));
    }
    assert!(!circle.is_paused());
}
