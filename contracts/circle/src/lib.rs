//! Circle contract — core ROSCA logic.
//!
//! Lifecycle:
//!   1. `initialize` — sets members, contribution amount, payout order, schedule
//!   2. Members call `join` to lock collateral (1× round amount)
//!   3. Each round: members call `contribute`, then anyone calls `payout`
//!   4. `mark_default` can be called after the round deadline to penalize a non-contributor
//!   5. After all rounds complete, `close` releases remaining collateral

#![no_std]

#[cfg(test)]
mod tests; // tests are in tests.rs

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Env, Symbol, Vec,
};

// ─── Types ────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum CircleStatus {
    Pending,   // waiting for members to join
    Active,    // rounds in progress
    Completed, // all rounds done
    Cancelled, // closed early / never filled
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CircleConfig {
    pub members: Vec<Address>,
    pub round_amount: i128,          // USDC amount per member per round (stroops: 1 USDC = 10^7)
    pub usdc_token: Address,         // USDC token contract
    pub reputation_contract: Address,
    pub round_deadline_ledgers: u32, // ledgers per round (~7 days ≈ 120_960 ledgers @ 5s each)
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RoundState {
    pub round_index: u32,
    pub recipient: Address,
    pub contributions_received: u32,
    pub deadline_ledger: u64,
    pub paid_out: bool,
}

#[contracttype]
pub enum DataKey {
    Config,
    Status,
    CurrentRound,
    Collateral(Address),         // per-member collateral balance
    Contributed(Address, u32),   // whether member contributed in a given round
    Defaults(Address),           // missed-contribution count per member
    RoundsCompleted,
}

/// Penalty: forfeit 20 % of collateral on a missed contribution
const PENALTY_BPS: i128 = 2_000;
const BPS_DENOM: i128 = 10_000;

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct CircleContract;

#[contractimpl]
impl CircleContract {
    // ── Initialize ────────────────────────────────────────────────────────────

    /// Called once by the factory immediately after deployment.
    pub fn initialize(
        env: Env,
        members: Vec<Address>,
        round_amount: i128,
        usdc_token: Address,
        reputation_contract: Address,
        round_deadline_ledgers: u32,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic!("already initialized");
        }
        if members.len() < 2 {
            panic!("need at least 2 members");
        }
        if round_amount <= 0 {
            panic!("round_amount must be positive");
        }

        let config = CircleConfig {
            members: members.clone(),
            round_amount,
            usdc_token,
            reputation_contract,
            round_deadline_ledgers,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::Status, &CircleStatus::Pending);
        env.storage().instance().set(&DataKey::RoundsCompleted, &0u32);

        // Set up round 0 with the first member as recipient
        let first_recipient = members.get(0).unwrap();
        let initial_round = RoundState {
            round_index: 0,
            recipient: first_recipient,
            contributions_received: 0,
            deadline_ledger: env.ledger().sequence() as u64
                + round_deadline_ledgers as u64,
            paid_out: false,
        };
        env.storage().instance().set(&DataKey::CurrentRound, &initial_round);

        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "initialized")),
            members.len(),
        );
    }

    // ── Join ──────────────────────────────────────────────────────────────────

    /// Member locks collateral (1 × round_amount) to join.
    /// All members must join before contributions begin.
    pub fn join(env: Env, member: Address) {
        member.require_auth();

        let config: CircleConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        let status: CircleStatus = env.storage().instance().get(&DataKey::Status).unwrap();

        if status != CircleStatus::Pending && status != CircleStatus::Active {
            panic!("circle not accepting members");
        }

        if !config.members.contains(&member) {
            panic!("not a circle member");
        }

        // Use `has` (not collateral > 0) so a member whose balance was later
        // reduced to 0 (penalties / release) cannot join again and transfer
        // a second collateral deposit. Reserve the slot *before* the token
        // transfer (checks-effects-interactions) so a reentrant join during
        // transfer cannot double-pull funds.
        let collateral_key = DataKey::Collateral(member.clone());
        if env.storage().persistent().has(&collateral_key) {
            panic!("already joined");
        }

        env.storage()
            .persistent()
            .set(&collateral_key, &config.round_amount);

        // Transfer collateral from member to this contract
        let token_client = token::Client::new(&env, &config.usdc_token);
        token_client.transfer(
            &member,
            &env.current_contract_address(),
            &config.round_amount,
        );

        // If every member has joined → activate the circle
        let all_joined = config.members.iter().all(|m| {
            env.storage()
                .persistent()
                .has(&DataKey::Collateral(m))
        });

        if all_joined {
            env.storage()
                .instance()
                .set(&DataKey::Status, &CircleStatus::Active);
            env.events()
                .publish((Symbol::new(&env, "circle"), Symbol::new(&env, "active")), ());
        }

        env.events()
            .publish((Symbol::new(&env, "circle"), Symbol::new(&env, "joined")), member);
    }

    // ── Contribute ────────────────────────────────────────────────────────────

    /// Member deposits their round contribution for the current round.
    pub fn contribute(env: Env, member: Address) {
        member.require_auth();

        let config: CircleConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        let status: CircleStatus = env.storage().instance().get(&DataKey::Status).unwrap();

        if status != CircleStatus::Active {
            panic!("circle is not active");
        }

        let mut round: RoundState =
            env.storage().instance().get(&DataKey::CurrentRound).unwrap();

        if round.paid_out {
            panic!("round already paid out");
        }

        // Reject late contributions even when payout has not run yet (e.g. the
        // pot is incomplete and callers are waiting on mark_default / payout).
        // Must stay consistent with mark_default, which becomes available once
        // sequence > deadline_ledger.
        if (env.ledger().sequence() as u64) > round.deadline_ledger {
            panic!("round deadline passed; cannot contribute before payout");
        }

        if !config.members.contains(&member) {
            panic!("not a member");
        }

        let key = DataKey::Contributed(member.clone(), round.round_index);
        if env.storage().temporary().has(&key) {
            panic!("already contributed this round");
        }

        // Transfer round amount from member to contract
        let token_client = token::Client::new(&env, &config.usdc_token);
        token_client.transfer(
            &member,
            &env.current_contract_address(),
            &config.round_amount,
        );

        env.storage().temporary().set(&key, &true);
        round.contributions_received += 1;
        env.storage().instance().set(&DataKey::CurrentRound, &round);

        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "contributed")),
            (member, round.round_index),
        );
    }

    // ── Payout ────────────────────────────────────────────────────────────────

    /// Transfer the pot to this round's recipient once all members have contributed.
    /// Anyone may call this.
    pub fn payout(env: Env) {
        let config: CircleConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        let status: CircleStatus = env.storage().instance().get(&DataKey::Status).unwrap();

        if status != CircleStatus::Active {
            panic!("circle is not active");
        }

        let mut round: RoundState =
            env.storage().instance().get(&DataKey::CurrentRound).unwrap();

        if round.paid_out {
            panic!("already paid out");
        }

        let member_count = config.members.len();
        if round.contributions_received < member_count {
            panic!("not all members have contributed yet");
        }

        // Transfer pot (member_count × round_amount) to this round's recipient
        let pot: i128 = config.round_amount * member_count as i128;
        let token_client = token::Client::new(&env, &config.usdc_token);
        token_client.transfer(&env.current_contract_address(), &round.recipient, &pot);

        round.paid_out = true;
        env.storage().instance().set(&DataKey::CurrentRound, &round);

        // Bump completed counter
        let completed: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RoundsCompleted)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::RoundsCompleted, &(completed + 1));

        // Increment on-chain reputation for the recipient
        let rep_client =
            reputation::ReputationContractClient::new(&env, &config.reputation_contract);
        rep_client.increment(&round.recipient);

        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "payout")),
            (round.recipient.clone(), pot, round.round_index),
        );

        // Advance to next round or mark the circle as completed
        let next_round_index = round.round_index + 1;
        if next_round_index >= member_count as u32 {
            env.storage()
                .instance()
                .set(&DataKey::Status, &CircleStatus::Completed);
            env.events().publish(
                (Symbol::new(&env, "circle"), Symbol::new(&env, "completed")),
                (),
            );
        } else {
            let next_recipient = config.members.get(next_round_index).unwrap();
            let next_round = RoundState {
                round_index: next_round_index,
                recipient: next_recipient,
                contributions_received: 0,
                deadline_ledger: env.ledger().sequence() as u64
                    + config.round_deadline_ledgers as u64,
                paid_out: false,
            };
            env.storage().instance().set(&DataKey::CurrentRound, &next_round);
        }
    }

    // ── Mark Default ──────────────────────────────────────────────────────────

    /// Flag and penalize a member who missed the round deadline.
    /// Can be called by anyone after `deadline_ledger` has passed.
    pub fn mark_default(env: Env, member: Address) {
        let config: CircleConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        let status: CircleStatus = env.storage().instance().get(&DataKey::Status).unwrap();

        if status != CircleStatus::Active {
            panic!("circle is not active");
        }

        let round: RoundState =
            env.storage().instance().get(&DataKey::CurrentRound).unwrap();

        if (env.ledger().sequence() as u64) <= round.deadline_ledger {
            panic!("round deadline not yet passed");
        }

        if !config.members.contains(&member) {
            panic!("not a member");
        }

        // Make sure they actually missed
        let key = DataKey::Contributed(member.clone(), round.round_index);
        if env.storage().temporary().has(&key) {
            panic!("member did contribute");
        }

        // Deduct penalty from collateral
        let collateral: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Collateral(member.clone()))
            .unwrap_or(0);

        let penalty = collateral * PENALTY_BPS / BPS_DENOM;
        let new_collateral = collateral - penalty;
        env.storage()
            .persistent()
            .set(&DataKey::Collateral(member.clone()), &new_collateral);

        // Increment default counter
        let defaults: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Defaults(member.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Defaults(member.clone()), &(defaults + 1));

        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "default")),
            (member, penalty, round.round_index),
        );
    }

    // ── Close ─────────────────────────────────────────────────────────────────

    /// Release remaining collateral back to all members.
    /// Only callable when the circle is Completed or Cancelled, and only by an
    /// authorized circle member (`closer.require_auth()` + membership check).
    pub fn close(env: Env, closer: Address) {
        closer.require_auth();

        let config: CircleConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        let status: CircleStatus = env.storage().instance().get(&DataKey::Status).unwrap();

        if status != CircleStatus::Completed && status != CircleStatus::Cancelled {
            panic!("circle still active");
        }

        if !config.members.contains(&closer) {
            panic!("not authorized to close: caller is not a circle member");
        }

        let token_client = token::Client::new(&env, &config.usdc_token);
        let mut total_released: i128 = 0;

        for member in config.members.iter() {
            let collateral: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::Collateral(member.clone()))
                .unwrap_or(0);

            if collateral > 0 {
                token_client.transfer(
                    &env.current_contract_address(),
                    &member,
                    &collateral,
                );
                env.storage()
                    .persistent()
                    .set(&DataKey::Collateral(member.clone()), &0i128);
                total_released += collateral;

                // Per-member audit trail for indexers / off-chain reconciler
                env.events().publish(
                    (
                        Symbol::new(&env, "circle"),
                        Symbol::new(&env, "collateral_released"),
                    ),
                    (member.clone(), collateral),
                );
            }
        }

        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "closed")),
            (closer, total_released),
        );
    }

    // ── Read-only views ───────────────────────────────────────────────────────

    pub fn get_config(env: Env) -> CircleConfig {
        env.storage().instance().get(&DataKey::Config).unwrap()
    }

    pub fn get_status(env: Env) -> CircleStatus {
        env.storage().instance().get(&DataKey::Status).unwrap()
    }

    pub fn get_current_round(env: Env) -> RoundState {
        env.storage().instance().get(&DataKey::CurrentRound).unwrap()
    }

    pub fn get_collateral(env: Env, member: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Collateral(member))
            .unwrap_or(0)
    }

    pub fn get_defaults(env: Env, member: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Defaults(member))
            .unwrap_or(0)
    }

    pub fn has_contributed(env: Env, member: Address, round_index: u32) -> bool {
        env.storage()
            .temporary()
            .has(&DataKey::Contributed(member, round_index))
    }
}
