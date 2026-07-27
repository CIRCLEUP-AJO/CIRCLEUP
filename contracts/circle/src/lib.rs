//! Circle contract — core ROSCA logic.
//!
//! Lifecycle:
//!   1. `initialize` — sets members, contribution amount, payout order, schedule
//!   2. Members call `join` to lock collateral (1× round amount) while Pending
//!   3. When every member has joined, status transitions to Active (deadline clock starts)
//!   4. Each round: members call `contribute`, then anyone calls `payout`
//!   5. `mark_default` can be called after the round deadline to penalize a non-contributor
//!      for the *current* round only
//!   6. After all rounds complete → Completed; or while still Pending → `cancel` → Cancelled
//!   7. `close` releases remaining collateral once Completed or Cancelled

#![no_std]

#[cfg(test)]
mod tests; // tests are in tests.rs

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, token, Address, Env, Symbol, Vec,
};

// ─── Types ────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum CircleStatus {
    Pending,   // waiting for members to join; only state that accepts join/cancel
    Active,    // all members joined; rounds in progress
    Completed, // all rounds done
    /// Circle never filled: cancelled while still Pending.
    /// Collateral locked by early joiners is reclaimable via `close`.
    /// Active circles cannot become Cancelled.
    Cancelled,
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
    Contributed(Address, u32),   // whether member contributed in a given round (persistent)
    Defaults(Address),           // missed-contribution count per member
    Defaulted(Address, u32),     // member already flagged for a given round
    RoundsCompleted,
}

/// Penalty: forfeit 20 % of collateral on a missed contribution
const PENALTY_BPS: i128 = 2_000;
const BPS_DENOM: i128 = 10_000;

/// ~8 minutes at 5s/ledger — keeps testnets usable while rejecting zero/near-zero deadlines
pub const MIN_ROUND_DEADLINE_LEDGERS: u32 = 100;
/// ~60 days at 5s/ledger — upper bound against accidental multi-year lockups
pub const MAX_ROUND_DEADLINE_LEDGERS: u32 = 1_036_800;
/// Practical upper bound to keep initialize/join/payout loops predictable.
pub const MAX_MEMBERS: u32 = 256;

// ─── Contract errors ───────────────────────────────────────────────────────────
//
// Used by the public read-only views so callers receive a typed, inspectable
// error code rather than an opaque panic when the contract has not been
// initialised or is called in an invalid state.
//
// Mutating entry-points (initialize, join, contribute, …) intentionally use
// `panic!` because Soroban rolls back the whole invocation on panic anyway, and
// the panic message propagates back to the caller as a diagnostic string via
// the simulation result.  Read-only views that are frequently called from the
// SDK/indexer use `contracterror` so consumers can handle them gracefully.

#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum ContractError {
    /// `get_config` was called before `initialize` (Config key is absent).
    NotInitialized = 1,
    /// `get_current_round` was called when the circle is not Active.
    /// The caller should inspect `get_status` to determine the true state.
    CircleNotActive = 2,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct CircleContract;

#[contractimpl]
impl CircleContract {
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
        if members.len() > MAX_MEMBERS {
            panic!("too many members");
        }
        Self::assert_unique_members(&members);
        if round_amount <= 0 {
            panic!("round_amount must be positive");
        }
        if round_deadline_ledgers < MIN_ROUND_DEADLINE_LEDGERS {
            panic!("round_deadline_ledgers below minimum");
        }
        if round_deadline_ledgers > MAX_ROUND_DEADLINE_LEDGERS {
            panic!("round_deadline_ledgers above maximum");
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

        // Round 0 is prepared at init; the live deadline is refreshed when the
        // circle becomes Active (all members joined), not at initialize time.
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
    ///
    /// Join is only accepted while `Pending`. The circle transitions to `Active`
    /// exactly once — when every configured member has joined — and the round-0
    /// deadline clock starts at that moment.
    pub fn join(env: Env, member: Address) {
        member.require_auth();

        let config: CircleConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        let status: CircleStatus = env.storage().instance().get(&DataKey::Status).unwrap();

        if status != CircleStatus::Pending {
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

        env.storage()
            .persistent()
            .set(&DataKey::Collateral(member.clone()), &config.round_amount);

        // Explicit Active transition only after every member has joined
        let all_joined = config.members.iter().all(|m| {
            env.storage()
                .persistent()
                .has(&DataKey::Collateral(m))
        });

        if all_joined {
            env.storage()
                .instance()
                .set(&DataKey::Status, &CircleStatus::Active);

            // Start the round-0 deadline from the activation ledger so the join
            // window does not eat into the first contribution window.
            let mut round: RoundState = env
                .storage()
                .instance()
                .get(&DataKey::CurrentRound)
                .unwrap();
            round.deadline_ledger = env.ledger().sequence() as u64
                + config.round_deadline_ledgers as u64;
            env.storage().instance().set(&DataKey::CurrentRound, &round);

            env.events()
                .publish((Symbol::new(&env, "circle"), Symbol::new(&env, "active")), ());
        }

        env.events()
            .publish((Symbol::new(&env, "circle"), Symbol::new(&env, "joined")), member);
    }

    // ── Cancel ────────────────────────────────────────────────────────────────

    /// Cancel a circle that never filled (`Pending` only).
    ///
    /// Semantics of `Cancelled`:
    /// - Means the circle was abandoned before all members joined (never Active).
    /// - Any member may call `cancel` while status is `Pending`.
    /// - After Cancelled, `close` returns collateral to members who already joined.
    /// - Active / Completed circles cannot be cancelled.
    pub fn cancel(env: Env, caller: Address) {
        caller.require_auth();

        let config: CircleConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        let status: CircleStatus = env.storage().instance().get(&DataKey::Status).unwrap();

        if status != CircleStatus::Pending {
            panic!("can only cancel a pending circle");
        }

        if !config.members.contains(&caller) {
            panic!("not a circle member");
        }

        env.storage()
            .instance()
            .set(&DataKey::Status, &CircleStatus::Cancelled);

        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "cancelled")),
            (caller, env.ledger().sequence()),
        );
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

        // Persistent so the record survives past the round deadline and
        // `mark_default` can accurately tell who missed the current round.
        let key = DataKey::Contributed(member.clone(), round.round_index);
        if env.storage().persistent().has(&key) {
            panic!("already contributed this round");
        }

        // Transfer round amount from member to contract
        let token_client = token::Client::new(&env, &config.usdc_token);
        token_client.transfer(
            &member,
            &env.current_contract_address(),
            &config.round_amount,
        );

        env.storage().persistent().set(&key, &true);
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
        if round.contributions_received != member_count {
            panic!("not all members have contributed yet");
        }

        // Strong invariant: contribution counter must match persisted records.
        let mut persisted_contributors: u32 = 0;
        for member in config.members.iter() {
            if env.storage().persistent().has(&DataKey::Contributed(member, round.round_index)) {
                persisted_contributors += 1;
            }
        }
        if persisted_contributors != member_count {
            panic!("round contribution tally mismatch");
        }

        // Transfer pot (member_count × round_amount) to this round's recipient
        let pot: i128 = config
            .round_amount
            .checked_mul(member_count as i128)
            .unwrap_or_else(|| panic!("pot amount overflow"));
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

    /// Flag and penalize a member who missed the *current* round deadline.
    ///
    /// Can be called by anyone after `deadline_ledger` has passed. Only members
    /// who (1) have joined, (2) did not contribute in the current round, and
    /// (3) have not already been flagged for this round may be marked.
    pub fn mark_default(env: Env, member: Address) {
        let config: CircleConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        let status: CircleStatus = env.storage().instance().get(&DataKey::Status).unwrap();

        if status != CircleStatus::Active {
            panic!("circle is not active");
        }

        let round: RoundState =
            env.storage().instance().get(&DataKey::CurrentRound).unwrap();

        if round.paid_out {
            panic!("round already paid out");
        }

        if (env.ledger().sequence() as u64) <= round.deadline_ledger {
            panic!("round deadline not yet passed");
        }

        if !config.members.contains(&member) {
            panic!("not a member");
        }

        // Must have joined (locked collateral) to be flaggable
        let collateral: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Collateral(member.clone()))
            .unwrap_or(0);
        if collateral <= 0 {
            panic!("member has not joined");
        }

        // Only the current round — refuse if already flagged for this round_index
        let defaulted_key = DataKey::Defaulted(member.clone(), round.round_index);
        if env.storage().persistent().has(&defaulted_key) {
            panic!("already marked default this round");
        }

        // Make sure they actually missed the current round
        let contrib_key = DataKey::Contributed(member.clone(), round.round_index);
        if env.storage().persistent().has(&contrib_key) {
            panic!("member did contribute");
        }

        // Deduct penalty from collateral
        let penalty = collateral * PENALTY_BPS / BPS_DENOM;
        let new_collateral = collateral - penalty;
        env.storage()
            .persistent()
            .set(&DataKey::Collateral(member.clone()), &new_collateral);

        // Record that this member was flagged for this round (idempotency)
        env.storage().persistent().set(&defaulted_key, &true);

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
            (closer, total_released, env.ledger().sequence()),
        );
    }

    // ── Read-only views ───────────────────────────────────────────────────────

    /// Returns the circle configuration.
    ///
    /// Returns `Err(ContractError::NotInitialized)` when `initialize` has not
    /// been called yet, giving the SDK and indexer a typed, inspectable error
    /// rather than an opaque contract trap.
    pub fn get_config(env: Env) -> Result<CircleConfig, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(ContractError::NotInitialized)
    }

    /// Returns the current circle status.
    ///
    /// Panics with a clear message when called before `initialize` so
    /// developers get an actionable diagnostic instead of a cryptic XDR error.
    pub fn get_status(env: Env) -> CircleStatus {
        env.storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or_else(|| panic!("circle: get_status called before initialize"))
    }

    /// Returns the current round state.
    ///
    /// When the circle is `Completed` or `Cancelled` there is no *active*
    /// round, so this view returns `Err(ContractError::CircleNotActive)`.
    /// Callers that need the last-seen round data should inspect `get_status`
    /// first and fall back to indexer history for completed/cancelled circles.
    ///
    /// Panics with a clear message when called before `initialize`.
    pub fn get_current_round(env: Env) -> Result<RoundState, ContractError> {
        let status: CircleStatus = env
            .storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or_else(|| panic!("circle: get_current_round called before initialize"));

        match status {
            CircleStatus::Active | CircleStatus::Pending => {
                // Both states always have a valid CurrentRound written by
                // `initialize` (and kept current by `payout`).
                let round: RoundState = env
                    .storage()
                    .instance()
                    .get(&DataKey::CurrentRound)
                    .unwrap_or_else(|| {
                        panic!("circle: CurrentRound missing for an Active/Pending circle — storage inconsistency")
                    });
                Ok(round)
            }
            CircleStatus::Completed | CircleStatus::Cancelled => {
                // The circle has no in-progress round.  Return a typed error so
                // the SDK / front-end can show an appropriate message without
                // causing a host-level contract trap.
                Err(ContractError::CircleNotActive)
            }
        }
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
            .persistent()
            .has(&DataKey::Contributed(member, round_index))
    }
}
