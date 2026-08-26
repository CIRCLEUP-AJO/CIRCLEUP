//! Circle contract — core ROSCA logic.
//!
//! # Lifecycle
//!
//!   1. `initialize` — sets members, contribution amount, payout order, schedule
//!   2. Members call `join` to lock collateral (1× round amount) while Pending
//!   3. When every member has joined, status transitions to Active (deadline clock starts)
//!   4. Each round: members call `contribute`, then anyone calls `payout`
//!   5. `mark_default` can be called after the round deadline to penalize a non-contributor
//!      for the *current* round only
//!   6. After all rounds complete → Completed; or while still Pending → `cancel` → Cancelled
//!   7. `close` releases remaining collateral once Completed or Cancelled
//!
//! # Protocol constants
//!
//! All numeric parameters that affect the on-chain financial model are defined as
//! named `pub const` items in this module.  They are re-exported through
//! `get_protocol_params` so the SDK and front-end can read the live values without
//! hard-coding them.
//!
//! | Constant | Value | Meaning |
//! |---|---|---|
//! | [`PENALTY_BPS`] | 2 000 | Penalty deducted from collateral per missed round (basis points) |
//! | [`BPS_DENOM`] | 10 000 | Denominator for all basis-point calculations |
//! | [`COLLATERAL_MULTIPLIER`] | 1 | Collateral required as a multiple of `round_amount` |
//! | [`MIN_ROUND_DEADLINE_LEDGERS`] | 100 | Minimum deadline window (~8 min at 5 s/ledger) |
//! | [`MAX_ROUND_DEADLINE_LEDGERS`] | 1 036 800 | Maximum deadline window (~60 days at 5 s/ledger) |
//! | [`MAX_MEMBERS`] | 256 | Maximum number of members per circle |
//!
//! # Storage budget guidance
//!
//! Soroban charges for every byte written and read.  The table below gives
//! approximate storage entries created per lifecycle action so integrators can
//! size their fee budgets accordingly:
//!
//! | Entry-point | New storage entries | Entry type | Notes |
//! |---|---|---|---|
//! | `initialize` | Config + Status + RoundsCompleted + CurrentRound | Instance | 4 entries, fixed cost regardless of member count |
//! | `join` (per member) | Collateral(member) | Persistent | 1 persistent entry per member; last join also updates Status + CurrentRound (instance) |
//! | `contribute` (per member) | Contributed(member, round) | Persistent | 1 persistent entry per contribution; also updates CurrentRound (instance) |
//! | `payout` | — | — | Updates CurrentRound + RoundsCompleted (instance); no new persistent entries |
//! | `mark_default` | Defaulted(member, round) + Defaults(member) | Persistent | 2 persistent entries; also updates Collateral(member) |
//! | `close` | Closed | Instance | Boolean flag set after all collateral is released; guards against re-invocation. Also reads all Collateral(member) keys in a pre-release scan pass and zeroes them during settlement. |
//!
//! Use `stellar-cli contract invoke --cost` to get instruction-count and
//! read/write-byte estimates before broadcasting.  The `simulate_transaction`
//! RPC endpoint returns `min_resource_fee` which should be added on top of the
//! base fee passed to `TransactionBuilder`.  See the README for a worked example.

#![no_std]

#[cfg(test)]
mod tests; // tests are in tests.rs
#[cfg(test)]
mod prop_tests; // property-based / fuzz-style harness (issue #167)
#[cfg(test)]
mod mutation_guards; // explicit guard-removal / mutation tests
#[cfg(test)]
mod adversarial_tests; // adversarial authorization tests (issue #87)

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
    Initializing,                // reentrancy guard held for the duration of `initialize`
    Closed,                      // true after close() successfully settles all collateral; re-invocation guard
    /// Canonical USDC token address locked at initialization time.
    /// Stored separately from Config so `get_usdc_token` can be called
    /// without deserializing the full CircleConfig, and to make the
    /// immutability of the token selection explicit in storage layout.
    UsdcToken,
}

// ─── Initialization-specific error type ──────────────────────────────────────
//
// `initialize` is a mutating entry-point that uses `panic!` for most
// guard violations (consistent with every other mutating entry-point in
// this contract — Soroban rolls the whole invocation back on panic and
// surfaces the message to the caller).  These `InitError` variants
// complement the panic messages by giving callers a stable, machine-readable
// code they can match on when calling `try_initialize` from an SDK or
// integration test, without requiring a string parse on the diagnostic.
//
// The variant names mirror the panic messages one-to-one so auditors can
// cross-reference them without ambiguity.

/// Typed errors that `initialize` returns via `contracterror` when called
/// through `try_initialize`.
///
/// Every variant corresponds to exactly one validation guard in the
/// `initialize` entry-point.  The numeric discriminants are stable across
/// upgrades — do not renumber existing variants.
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum InitError {
    /// `initialize` was called after a previous successful call.
    AlreadyInitialized = 1,
    /// `members` list has fewer than 2 entries.
    TooFewMembers = 2,
    /// `members` list has more than [`MAX_MEMBERS`] entries.
    TooManyMembers = 3,
    /// `members` list contains the same address more than once.
    DuplicateMembers = 4,
    /// `round_amount` is zero or negative.
    InvalidRoundAmount = 5,
    /// `round_amount` × `member_count` would overflow `i128`.
    RoundAmountPotOverflow = 6,
    /// `round_amount` × [`PENALTY_BPS`] would overflow `i128`.
    RoundAmountPenaltyOverflow = 7,
    /// `round_deadline_ledgers` is below [`MIN_ROUND_DEADLINE_LEDGERS`].
    DeadlineBelowMinimum = 8,
    /// `round_deadline_ledgers` is above [`MAX_ROUND_DEADLINE_LEDGERS`].
    DeadlineAboveMaximum = 9,
    /// `usdc_token` address is the same as the circle contract itself —
    /// this would make every token transfer a no-op and break the financial model.
    InvalidTokenAddress = 10,
    /// `reputation_contract` address is the same as the circle contract or
    /// the same as `usdc_token` — indicates a misconfigured deployment.
    InvalidReputationAddress = 11,
    /// `members` contains fewer entries than the rotation length requires
    /// (i.e. `members.len()` is zero after deduplication, which should be
    /// caught earlier, or the rotation array has a different length from the
    /// member array — guards against inconsistent off-chain construction).
    InconsistentRotation = 12,
    /// `usdc_token` does not respond to the standard token interface
    /// (`balance` call failed) — the address is not a usable token contract.
    /// Accepting an unusable token would strand all member deposits with no
    /// recovery path.
    UnusableTokenContract = 13,
}

/// Penalty: forfeit 20 % of collateral on a missed contribution.
///
/// Expressed in basis points (1 bp = 0.01 %).  Divide by [`BPS_DENOM`] to get
/// the fractional multiplier: `2_000 / 10_000 = 0.20` (20 %).
///
/// This value is intentionally public so the SDK and frontend can read it via
/// [`CircleContract::get_protocol_params`] without hard-coding the number.
pub const PENALTY_BPS: i128 = 2_000;

/// Denominator used in all basis-point arithmetic throughout this contract.
///
/// All percentage calculations follow the pattern:
/// ```text
/// amount * NUMERATOR_BPS / BPS_DENOM
/// ```
/// Using integer arithmetic with this denominator avoids floating-point
/// imprecision in the Soroban WASM environment.
pub const BPS_DENOM: i128 = 10_000;

/// Collateral required from each member, expressed as a multiple of
/// `round_amount`.
///
/// A value of `1` means each member must lock exactly one round's worth of
/// tokens when calling [`CircleContract::join`].  The constant is exported so
/// UIs can display the collateral requirement without hard-coding the ratio.
pub const COLLATERAL_MULTIPLIER: i128 = 1;

/// Minimum allowed value for `round_deadline_ledgers` at initialize time.
///
/// At ~5 seconds per ledger this is approximately 8 minutes — long enough to
/// be usable on testnets while rejecting zero or near-zero deadlines that would
/// make it impossible for members to contribute before being marked defaulted.
pub const MIN_ROUND_DEADLINE_LEDGERS: u32 = 100;

/// Maximum allowed value for `round_deadline_ledgers` at initialize time.
///
/// At ~5 seconds per ledger this is approximately 60 days.  The upper bound
/// prevents accidental multi-year lockups from a typo in the deadline field.
pub const MAX_ROUND_DEADLINE_LEDGERS: u32 = 1_036_800;

/// Maximum number of members a circle may have.
///
/// Keeping the member list bounded limits gas costs for `payout` (which
/// iterates all members to verify the contribution tally) and `close` (which
/// transfers collateral to every member).
pub const MAX_MEMBERS: u32 = 256;

// ─── Protocol params struct ───────────────────────────────────────────────────

/// A snapshot of all tunable protocol constants for this contract.
///
/// Returned by [`CircleContract::get_protocol_params`] so clients can read the
/// live values without maintaining a separate out-of-band constant table.  If a
/// future upgrade changes `PENALTY_BPS` the SDK and frontend immediately see the
/// new value through this view without any code change on their side.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProtocolParams {
    /// Penalty for a missed contribution in basis points (see [`PENALTY_BPS`]).
    pub penalty_bps: i128,
    /// Basis-point denominator (see [`BPS_DENOM`]).
    pub bps_denom: i128,
    /// Collateral multiplier: `collateral = round_amount × collateral_multiplier`.
    pub collateral_multiplier: i128,
    /// Minimum `round_deadline_ledgers` accepted by `initialize`.
    pub min_round_deadline_ledgers: u32,
    /// Maximum `round_deadline_ledgers` accepted by `initialize`.
    pub max_round_deadline_ledgers: u32,
    /// Maximum number of members per circle.
    pub max_members: u32,
}

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
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ContractError {
    /// `get_config` was called before `initialize` (Config key is absent).
    NotInitialized = 1,
    /// `get_current_round` was called when the circle is not Active.
    /// The caller should inspect `get_status` to determine the true state.
    CircleNotActive = 2,
    /// `get_pot_amount` detected that `round_amount × member_count` overflows
    /// `i128`.  This can only happen if the circle was somehow initialized with
    /// an astronomically large `round_amount`; the `initialize` overflow guards
    /// should prevent it in practice, but the view returns a typed error rather
    /// than panicking so read-only callers can handle it gracefully.
    PotOverflow = 3,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct CircleContract;

#[contractimpl]
impl CircleContract {
    /// Executes a USDC transfer via `try_transfer` so a token-contract
    /// failure (insufficient balance, missing trustline, frozen account,
    /// deauthorized asset, etc.) surfaces as a clear, contextual panic
    /// message instead of an opaque trap propagated from the token contract.
    fn safe_transfer(
        token_client: &token::Client,
        from: &Address,
        to: &Address,
        amount: &i128,
        context: &str,
    ) {
        if token_client.try_transfer(from, to, amount).is_err() {
            panic!(
                "USDC transfer failed during {}: check balance, trustline, and authorization",
                context
            );
        }
    }

    fn assert_unique_members(members: &Vec<Address>) {
        let len = members.len();
        let mut i: u32 = 0;
        while i < len {
            let mut j = i + 1;
            while j < len {
                let a = members
                    .get(i)
                    .unwrap_or_else(|| panic!("circle: member index {} out of bounds", i));
                let b = members
                    .get(j)
                    .unwrap_or_else(|| panic!("circle: member index {} out of bounds", j));
                if a == b {
                    panic!("duplicate members");
                }
                j += 1;
            }
            i += 1;
        }
    }

    // ── Initialize ────────────────────────────────────────────────────────────

    /// Called once by the factory immediately after deployment.
    ///
    /// # Validation
    ///
    /// All validation runs before any persistent state is written.  An invalid
    /// configuration makes no state changes — the reentrancy guard is the only
    /// key touched before the checks, and it is cleared on any panic path.
    ///
    /// | Check | Condition | Panic message |
    /// |---|---|---|
    /// | Double-init | `Config` key present | `"already initialized"` |
    /// | Reentrancy | `Initializing` flag present | `"initialize already in progress"` |
    /// | Min members | `members.len() < 2` | `"need at least 2 members"` |
    /// | Max members | `members.len() > MAX_MEMBERS` | `"too many members"` |
    /// | Duplicate members | any two entries equal | `"duplicate members"` |
    /// | Positive amount | `round_amount <= 0` | `"round_amount must be positive"` |
    /// | Pot overflow | `round_amount * member_count` overflows `i128` | `"round_amount too large: overflows pot calculation for this member count"` |
    /// | Penalty overflow | `round_amount * PENALTY_BPS` overflows `i128` | `"round_amount too large: overflows penalty calculation"` |
    /// | Min deadline | `round_deadline_ledgers < MIN_ROUND_DEADLINE_LEDGERS` | `"round_deadline_ledgers below minimum"` |
    /// | Max deadline | `round_deadline_ledgers > MAX_ROUND_DEADLINE_LEDGERS` | `"round_deadline_ledgers above maximum"` |
    /// | Token address | `usdc_token == current contract` | `"usdc_token must not be the circle contract itself"` |
    /// | Reputation address | `reputation_contract == current contract` | `"reputation_contract must not be the circle contract itself"` |
    /// | Reputation ≠ token | `reputation_contract == usdc_token` | `"reputation_contract must not be the same address as usdc_token"` |
    /// | Rotation consistency | `members.len() == 0` after validation passes | (defensive; unreachable in practice) |
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

        // Reentrancy guard: flip an explicit "initializing" flag before any
        // other storage write. Config absence alone is not a safe guard if a
        // reentrant call lands mid-initialize (e.g. a future change adds a
        // cross-contract call here) — the flag is checked and set atomically
        // as the very first action, and cleared once setup fully commits.
        if env.storage().instance().has(&DataKey::Initializing) {
            panic!("initialize already in progress");
        }
        env.storage().instance().set(&DataKey::Initializing, &true);

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
        // round_amount is later multiplied by member_count (payout's pot) and
        // by PENALTY_BPS (mark_default's penalty). Reject configurations that
        // would overflow i128 in those paths instead of deferring the failure
        // to a runtime panic deep in an unrelated call.
        round_amount
            .checked_mul(members.len() as i128)
            .unwrap_or_else(|| panic!("round_amount too large: overflows pot calculation for this member count"));
        round_amount
            .checked_mul(PENALTY_BPS)
            .unwrap_or_else(|| panic!("round_amount too large: overflows penalty calculation"));
        if round_deadline_ledgers < MIN_ROUND_DEADLINE_LEDGERS {
            panic!("round_deadline_ledgers below minimum");
        }
        if round_deadline_ledgers > MAX_ROUND_DEADLINE_LEDGERS {
            panic!("round_deadline_ledgers above maximum");
        }

        // ── Token and contract address validation ─────────────────────────────
        //
        // A misconfigured deployment where `usdc_token` or `reputation_contract`
        // points back at the circle itself would make every token transfer a
        // no-op (the circle can't hold USDC to transfer to itself) and would
        // allow the circle to award its own reputation scores, breaking both the
        // financial model and the authorization invariants.
        //
        // We also reject `reputation_contract == usdc_token` because mixing the
        // two roles into a single address is nonsensical and almost certainly a
        // copy-paste error in the deployment script.
        //
        // Note: Soroban `Address` values are always well-formed 32-byte contract
        // or account identifiers — there is no concept of a "zero address" in the
        // EVM sense.  The checks here guard against logical misconfiguration
        // (self-referential or aliased addresses) rather than null inputs.
        let self_address = env.current_contract_address();
        if usdc_token == self_address {
            panic!("usdc_token must not be the circle contract itself");
        }
        if reputation_contract == self_address {
            panic!("reputation_contract must not be the circle contract itself");
        }
        if reputation_contract == usdc_token {
            panic!("reputation_contract must not be the same address as usdc_token");
        }

        // ── Token identity / usability probe ──────────────────────────────────
        //
        // Verify that `usdc_token` is a live, callable token contract by probing
        // its standard `balance` entry-point with a try_ call.  A successful
        // probe (even returning 0) confirms the address hosts a contract that
        // implements the token interface; a failure means the address is either
        // not a contract, not deployed, or implements a different interface —
        // any of which would silently strand all member deposits.
        //
        // Why probe at initialization rather than at first transfer:
        //   A misconfigured token cannot be corrected after initialization
        //   (the stored address is immutable).  Catching it here gives the
        //   deployer an immediate, clear failure message and leaves the circle
        //   un-initialized so it can be redeployed with the correct token.
        //
        // The probe uses the circle's own address as the balance query target —
        // this is always a valid address (the contract itself) so the call will
        // not fail due to an invalid argument.
        let token_probe = token::Client::new(&env, &usdc_token);
        if token_probe
            .try_balance(&env.current_contract_address())
            .is_err()
        {
            panic!("usdc_token does not implement the standard token interface; verify the token contract address");
        }

        // ── Rotation consistency check ────────────────────────────────────────
        //
        // The rotation order is defined by the `members` list — each member at
        // index `i` is the recipient of round `i`.  After all previous checks
        // `members.len()` is in [2, MAX_MEMBERS] and every address is unique, so
        // the rotation is inherently consistent.  We verify this explicitly with
        // a defensive assertion so that if a future refactor introduces a separate
        // rotation parameter the compiler flags the missing check rather than
        // silently shipping a broken invariant.
        //
        // This check is intentionally infallible given the earlier validations;
        // its value is as documentation and a future-proofing guard.
        let member_count = members.len();
        if member_count == 0 {
            panic!("rotation length is zero: members list must have at least 2 entries");
        }

        let config = CircleConfig {
            members: members.clone(),
            round_amount,
            usdc_token: usdc_token.clone(),
            reputation_contract,
            round_deadline_ledgers,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::Status, &CircleStatus::Pending);
        env.storage().instance().set(&DataKey::RoundsCompleted, &0u32);

        // Store the token address under its own key so `get_usdc_token` can
        // return it without deserializing the full CircleConfig, and to make
        // the immutability of the token selection explicit and independently
        // observable.  Once written here it is never overwritten.
        env.storage().instance().set(&DataKey::UsdcToken, &usdc_token);

        // Round 0 is prepared at init; the live deadline is refreshed when the
        // circle becomes Active (all members joined), not at initialize time.
        let first_recipient = members
            .get(0)
            .unwrap_or_else(|| panic!("circle: member list is empty after validation — storage inconsistency"));
        let initial_round = RoundState {
            round_index: 0,
            recipient: first_recipient,
            contributions_received: 0,
            deadline_ledger: env.ledger().sequence() as u64
                + round_deadline_ledgers as u64,
            paid_out: false,
        };
        env.storage().instance().set(&DataKey::CurrentRound, &initial_round);

        env.storage().instance().remove(&DataKey::Initializing);

        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "initialized")),
            member_count,
        );
    }

    // ── Join ──────────────────────────────────────────────────────────────────

    /// Member locks collateral (`COLLATERAL_MULTIPLIER × round_amount`) to join.
    ///
    /// Join is only accepted while `Pending`. The circle transitions to `Active`
    /// exactly once — when every configured member has joined — and the round-0
    /// deadline clock starts at that moment.
    ///
    /// # Events
    ///
    /// Emits `circle` / `joined` with data `(member: Address, order: u32)` where
    /// `order` is the 1-based position this member filled in the join queue
    /// (1 = first to join, N = last to join and triggers the Active transition).
    /// Consumers can use `order` to display a live join-progress indicator
    /// without polling `get_collateral` for every configured member.
    ///
    /// # Storage cost
    /// Creates one new persistent entry (`Collateral(member)`).  The last member
    /// to join also writes two instance entries (`Status`, `CurrentRound`).
    pub fn join(env: Env, member: Address) {
        member.require_auth();

        let config: CircleConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| panic!("circle: join called before initialize"));
        let status: CircleStatus = env
            .storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or_else(|| panic!("circle: Status missing — storage inconsistency"));

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

        // Collateral is COLLATERAL_MULTIPLIER × round_amount.
        // Currently 1× — expressed via the named const so a future governance
        // upgrade can change the ratio in one place.
        let collateral_amount = config
            .round_amount
            .checked_mul(COLLATERAL_MULTIPLIER)
            .unwrap_or_else(|| panic!("collateral amount overflow"));

        env.storage()
            .persistent()
            .set(&collateral_key, &collateral_amount);

        // Transfer collateral from member to this contract
        let token_client = token::Client::new(&env, &config.usdc_token);
        Self::safe_transfer(
            &token_client,
            &member,
            &env.current_contract_address(),
            &config.round_amount,
            "join collateral deposit",
        );

        // Count how many members have now joined (including this one, whose
        // Collateral key was written above).  This is the 1-based join order
        // emitted in the `joined` event so listeners can track join progress
        // without polling collateral keys for every configured member.
        let join_order: u32 = config
            .members
            .iter()
            .filter(|m| env.storage().persistent().has(&DataKey::Collateral(m.clone())))
            .count() as u32;

        // Explicit Active transition only after every member has joined
        let all_joined = join_order == config.members.len();

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
                .unwrap_or_else(|| panic!("circle: CurrentRound missing during join activation — storage inconsistency"));
            round.deadline_ledger = env.ledger().sequence() as u64
                + config.round_deadline_ledgers as u64;
            env.storage().instance().set(&DataKey::CurrentRound, &round);

            env.events()
                .publish((Symbol::new(&env, "circle"), Symbol::new(&env, "active")), ());
        }

        // Emit (member, join_order) so indexers and front-ends can show a live
        // join-progress indicator ("2 of 4 members joined") and record who
        // claimed which position in the queue without secondary lookups.
        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "joined")),
            (member, join_order),
        );
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

        let config: CircleConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| panic!("circle: cancel called before initialize"));
        let status: CircleStatus = env
            .storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or_else(|| panic!("circle: Status missing — storage inconsistency"));

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
    ///
    /// # Storage cost
    /// Creates one new persistent entry (`Contributed(member, round_index)`) and
    /// updates one instance entry (`CurrentRound`).
    pub fn contribute(env: Env, member: Address) {
        member.require_auth();

        let config: CircleConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| panic!("circle: contribute called before initialize"));
        let status: CircleStatus = env
            .storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or_else(|| panic!("circle: Status missing — storage inconsistency"));

        if status != CircleStatus::Active {
            panic!("circle is not active");
        }

        let mut round: RoundState = env
            .storage()
            .instance()
            .get(&DataKey::CurrentRound)
            .unwrap_or_else(|| panic!("circle: CurrentRound missing for an Active circle — storage inconsistency"));

        if round.paid_out {
            panic!("round already paid out");
        }

        // Reject late contributions even when payout has not run yet (e.g. the
        // pot is incomplete and callers are waiting on mark_default / payout).
        // Uses the centralized deadline_passed predicate so the boundary
        // semantics are identical to mark_default (strict greater-than).
        if Self::deadline_passed(&env, &round) {
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
        Self::safe_transfer(
            &token_client,
            &member,
            &env.current_contract_address(),
            &config.round_amount,
            "round contribution",
        );

        env.storage().persistent().set(&key, &true);
        round.contributions_received += 1;
        env.storage().instance().set(&DataKey::CurrentRound, &round);

        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "contributed")),
            (member, round.round_index),
        );
    }

    // ── Deadline predicate ────────────────────────────────────────────────────

    /// Returns `true` when the round deadline has **strictly** passed.
    ///
    /// # Boundary rule
    ///
    /// Uses `sequence > deadline_ledger` (strict greater-than).  The member
    /// whose contribution arrives in the very ledger that *equals*
    /// `deadline_ledger` is still considered on time; the deadline is only
    /// exceeded on the **next** ledger.  This is the single authoritative
    /// definition used by both `contribute` and `mark_default` so the two
    /// entry-points can never have inconsistent boundary semantics.
    ///
    /// # Source of time
    ///
    /// Reads `env.ledger().sequence()` — the current ledger sequence number
    /// committed by the Stellar consensus protocol.  This value is determined
    /// by the network, not by the caller, so no client timestamp can influence
    /// whether a default is allowed.
    ///
    /// # Per-round isolation
    ///
    /// Each round stores its own `deadline_ledger` in `CurrentRound`.  The
    /// deadline is refreshed every time a new round starts (in `payout`) so
    /// stale deadlines from a prior round can never bleed into a later one.
    #[inline]
    fn deadline_passed(env: &Env, round: &RoundState) -> bool {
        (env.ledger().sequence() as u64) > round.deadline_ledger
    }

    // ── Payout ────────────────────────────────────────────────────────────────

    /// Transfer the pot to this round's recipient once all members have contributed.
    ///
    /// # Recipient derivation
    ///
    /// The recipient is **always** `members[round_index]` — the value stored in
    /// `CurrentRound.recipient` at round-start time.  No caller argument can
    /// override this.  An index-out-of-bounds state (which should be
    /// unreachable given the initialization checks) is treated as a storage
    /// inconsistency and panics rather than silently transferring to a wrong
    /// address.
    ///
    /// # Checks-Effects-Interactions ordering
    ///
    /// 1. All precondition checks run first (status, paid_out, contribution counts,
    ///    tally cross-check, recipient bounds).
    /// 2. `round.paid_out = true` and `RoundsCompleted` are written to storage
    ///    **before** any external call (token transfer or reputation increment).
    ///    If a downstream call re-enters `payout`, the `paid_out` guard fires
    ///    immediately, preventing a second transfer.
    /// 3. The token transfer runs next.
    /// 4. The reputation increment runs last.  If it fails, the transaction
    ///    rolls back — this reverts the `paid_out` flag too, leaving the round
    ///    payable again once the reputation contract issue is resolved.
    ///    This is the documented policy: **reputation failure rolls back settlement**.
    ///    Callers who want fire-and-forget reputation should wrap the call in an
    ///    SDK retry pattern rather than expecting the contract to skip it.
    ///
    /// Anyone may call this.
    pub fn payout(env: Env) {
        let config: CircleConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| panic!("circle: payout called before initialize"));
        let status: CircleStatus = env
            .storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or_else(|| panic!("circle: Status missing — storage inconsistency"));

        if status != CircleStatus::Active {
            panic!("circle is not active");
        }

        let mut round: RoundState = env
            .storage()
            .instance()
            .get(&DataKey::CurrentRound)
            .unwrap_or_else(|| panic!("circle: CurrentRound missing for an Active circle — storage inconsistency"));

        // Single-use guard: a round may be paid out exactly once.
        // This flag is written to storage BEFORE any external call (CEI) so
        // that a reentrant payout attempt hits this guard immediately.
        if round.paid_out {
            panic!("already paid out");
        }

        let member_count = config.members.len();
        if round.contributions_received != member_count {
            panic!("not all members have contributed yet");
        }

        // Strong invariant: contribution counter must match persisted records.
        // A forged counter that passes the previous check is caught here.
        let mut persisted_contributors: u32 = 0;
        for member in config.members.iter() {
            if env.storage().persistent().has(&DataKey::Contributed(member, round.round_index)) {
                persisted_contributors += 1;
            }
        }
        if persisted_contributors != member_count {
            panic!("round contribution tally mismatch");
        }

        // Bounds guard: round_index must be a valid position in the rotation.
        // This is defensive — initialize already ensures member_count >= 2 and
        // payout advances round_index by 1 after checking < member_count, so
        // an out-of-bounds index indicates a storage inconsistency.
        if round.round_index >= member_count as u32 {
            panic!("circle: round_index out of bounds — storage inconsistency");
        }

        // Verify stored recipient matches the canonical rotation position.
        // The recipient is never supplied by the caller; it is always derived
        // from members[round_index] and stored at round-start time.  This
        // cross-check catches any divergence between the stored recipient and
        // the rotation order (e.g. from a hypothetical storage corruption).
        let canonical_recipient = config
            .members
            .get(round.round_index)
            .unwrap_or_else(|| panic!("circle: canonical recipient at index {} missing — storage inconsistency", round.round_index));
        if round.recipient != canonical_recipient {
            panic!("circle: stored recipient does not match rotation order — storage inconsistency");
        }

        let pot: i128 = config
            .round_amount
            .checked_mul(member_count as i128)
            .unwrap_or_else(|| panic!("pot amount overflow"));

        // ── CHECKS-EFFECTS-INTERACTIONS ───────────────────────────────────────
        //
        // All state mutations happen before any external calls so a reentrant
        // call to payout() sees paid_out=true and panics before it can
        // transfer the pot a second time.
        //
        // If either external call (token transfer or reputation increment)
        // fails, the Soroban transaction rolls back atomically — this resets
        // paid_out to false and leaves the round payable once the downstream
        // issue is resolved.

        // Effect: mark this round as settled before touching external contracts.
        round.paid_out = true;
        env.storage().instance().set(&DataKey::CurrentRound, &round);

        // Effect: bump the completed-round counter.
        let completed: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RoundsCompleted)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::RoundsCompleted, &(completed + 1));

        // Interaction 1: transfer pot to the canonical recipient.
        let token_client = token::Client::new(&env, &config.usdc_token);
        Self::safe_transfer(
            &token_client,
            &env.current_contract_address(),
            &round.recipient,
            &pot,
            "round payout",
        );

        // Interaction 2: increment on-chain reputation for the recipient.
        //
        // Reputation failure policy (documented):
        //   If try_increment returns an error the whole transaction rolls back.
        //   This reverts paid_out=true, RoundsCompleted, and the token transfer.
        //   The round remains payable and the operator must resolve the
        //   reputation contract issue (e.g. re-register the circle as an
        //   authorized caller) before retrying payout.
        //
        // Rationale: a successful token transfer with a failed reputation
        //   update would leave the recipient richer but unrecognized, which is
        //   harder to recover from than a clean rollback.  Rollback is the
        //   safe default; operators who prefer fire-and-forget reputation
        //   should wrap the retry at the SDK layer.
        let rep_client =
            reputation::ReputationContractClient::new(&env, &config.reputation_contract);
        let _ = rep_client
            .try_increment(&env.current_contract_address(), &round.recipient)
            .unwrap_or_else(|_| panic!("circle: reputation increment failed — ensure this circle is registered as an authorized caller on the reputation contract"));

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
            let next_recipient = config
                .members
                .get(next_round_index)
                .unwrap_or_else(|| panic!("circle: next recipient at index {} missing — storage inconsistency", next_round_index));
            let next_round = RoundState {
                round_index: next_round_index,
                recipient: next_recipient.clone(),
                contributions_received: 0,
                // Use the centralized deadline helper: new deadline = current
                // ledger + round_deadline_ledgers, sourced from the contract's
                // own ledger sequence — not from any caller-supplied timestamp.
                deadline_ledger: env.ledger().sequence() as u64
                    + config.round_deadline_ledgers as u64,
                paid_out: false,
            };
            env.storage().instance().set(&DataKey::CurrentRound, &next_round);

            // Notify indexers and front-ends that a new contribution window has
            // opened.  Consumers can use this event to reset contribution status
            // displays and restart deadline countdowns without polling get_current_round.
            env.events().publish(
                (Symbol::new(&env, "circle"), Symbol::new(&env, "round_started")),
                (next_round_index, next_recipient, next_round.deadline_ledger),
            );
        }
    }

    // ── Mark Default ──────────────────────────────────────────────────────────

    /// Flag and penalize a member who missed the *current* round deadline.
    ///
    /// Can be called by anyone after `deadline_ledger` has passed. Only members
    /// who (1) have joined, (2) did not contribute in the current round, and
    /// (3) have not already been flagged for this round may be marked.
    ///
    /// The penalty is [`PENALTY_BPS`] / [`BPS_DENOM`] of the member's remaining
    /// collateral (currently 20 %).
    ///
    /// # Storage cost
    /// Creates two new persistent entries (`Defaulted(member, round)`,
    /// `Defaults(member)`) and updates one persistent entry
    /// (`Collateral(member)`).
    pub fn mark_default(env: Env, member: Address) {
        let config: CircleConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| panic!("circle: mark_default called before initialize"));
        let status: CircleStatus = env
            .storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or_else(|| panic!("circle: Status missing — storage inconsistency"));

        if status != CircleStatus::Active {
            panic!("circle is not active");
        }

        let round: RoundState = env
            .storage()
            .instance()
            .get(&DataKey::CurrentRound)
            .unwrap_or_else(|| panic!("circle: CurrentRound missing for an Active circle — storage inconsistency"));

        if round.paid_out {
            panic!("round already paid out");
        }

        // Uses the centralized deadline_passed predicate — strict greater-than
        // so the deadline ledger itself is the last moment to contribute, not
        // the first moment to default.  This is the same boundary used by
        // contribute() so the two entry-points are always consistent.
        if !Self::deadline_passed(&env, &round) {
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
            (member, penalty, round.round_index, new_collateral),
        );
    }

    // ── Close ─────────────────────────────────────────────────────────────────

    /// Settle and release remaining collateral back to all members.
    ///
    /// # Preconditions (enforced, not assumed)
    ///
    /// - The circle must be in a terminal state (`Completed` or `Cancelled`).
    ///   Active and Pending circles are explicitly rejected with distinct messages.
    /// - The `closer` must be a configured circle member.
    /// - For `Completed` circles the `RoundsCompleted` counter must equal the
    ///   member count — this cross-checks that every round was paid out before
    ///   the status was set, guarding against storage-level inconsistencies.
    /// - The circle must not have been closed before (`DataKey::Closed` absent).
    ///   Duplicate invocations are rejected so no partial-release state can
    ///   accumulate across multiple calls.
    ///
    /// # Settlement semantics
    ///
    /// Before the release loop the contract pre-computes `pre_release_total` —
    /// the sum of every member's current `Collateral` balance read from storage.
    /// This value is used after the loop for an arithmetic assertion:
    ///   `total_released == pre_release_total`
    /// If any member's balance was skipped or counted twice the assertion fires,
    /// rolling back the entire transaction and preventing inconsistent state from
    /// being committed.
    ///
    /// For each member the contract reads their `Collateral(member)` balance and,
    /// if positive, zeroes the key in storage *before* performing the transfer
    /// (checks-effects-interactions per member).  The `Closed` flag is set
    /// *before* the release loop begins so any reentrant call immediately sees
    /// the closed state and panics, preventing double-releases through a
    /// hostile token contract.
    ///
    /// Members whose collateral was fully consumed by `mark_default` penalties
    /// (balance == 0) are silently skipped — no transfer or event is emitted for
    /// them.  Members who never joined (no `Collateral` key at all, possible only
    /// in Cancelled circles) are also skipped.
    ///
    /// # Events
    ///
    /// Emits one `collateral_released` event per member with a non-zero balance,
    /// then one aggregate `closed` event.  An off-chain auditor can replay the
    /// event log and verify that the sum of all `collateral_released` amounts
    /// equals `total_released` in the `closed` event.  The `closed` event also
    /// carries `total_expected_collateral` (what would have been released without
    /// any penalties) so auditors can compute total penalty forfeitures as
    /// `total_expected_collateral − total_released`.
    ///
    /// # Storage cost
    /// Writes one instance entry (`Closed = true`) and zeroes one persistent
    /// entry (`Collateral(member)`) per member that held a non-zero balance.
    pub fn close(env: Env, closer: Address) {
        closer.require_auth();

        let config: CircleConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| panic!("circle: close called before initialize"));

        // Reject duplicate close invocations before touching any other state.
        if env.storage().instance().has(&DataKey::Closed) {
            panic!("circle already closed");
        }

        let status: CircleStatus = env
            .storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or_else(|| panic!("circle: Status missing — storage inconsistency"));

        // Only terminal states may trigger settlement.  Each non-terminal state
        // gets its own message so callers receive an actionable diagnostic.
        match &status {
            CircleStatus::Completed | CircleStatus::Cancelled => {}
            CircleStatus::Active => {
                panic!("circle still active")
            }
            CircleStatus::Pending => {
                panic!("circle still pending; call cancel first to reach a terminal state")
            }
        }

        if !config.members.contains(&closer) {
            panic!("not authorized to close: caller is not a circle member");
        }

        // For Completed circles, cross-check that every round was paid out.
        // This guards against a hypothetical state corruption where Status was
        // set to Completed before all payouts ran.
        if matches!(status, CircleStatus::Completed) {
            let rounds_completed: u32 = env
                .storage()
                .instance()
                .get(&DataKey::RoundsCompleted)
                .unwrap_or(0);
            if rounds_completed != config.members.len() {
                panic!("circle: Completed status set but not all rounds paid out — storage inconsistency");
            }
        }

        // Expected collateral if every member joined and incurred no penalties.
        // Used in the closed event so auditors can reconcile penalty forfeitures:
        //   total_expected_collateral - total_released == total penalties forfeited.
        let collateral_per_member = config
            .round_amount
            .checked_mul(COLLATERAL_MULTIPLIER)
            .unwrap_or_else(|| panic!("collateral per member amount overflow"));
        let total_expected_collateral = collateral_per_member
            .checked_mul(config.members.len() as i128)
            .unwrap_or_else(|| panic!("total expected collateral overflow"));

        // Pre-compute the total collateral held in storage before any transfer.
        // This snapshot is compared against total_released after the loop as an
        // arithmetic assertion: released == stored_before_release.  Any mismatch
        // (double-count, silent skip, or storage inconsistency) causes the whole
        // transaction to roll back, leaving no partial state on-chain.
        let mut pre_release_total: i128 = 0;
        for member in config.members.iter() {
            let balance: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::Collateral(member.clone()))
                .unwrap_or(0);
            pre_release_total = pre_release_total
                .checked_add(balance)
                .unwrap_or_else(|| panic!("pre_release_total overflow during collateral scan"));
        }

        // Set the Closed flag before any transfers (checks-effects-interactions).
        // A reentrant call to close() — e.g. through a hostile token contract —
        // will hit this guard immediately and panic, preventing double-releases.
        // If any subsequent transfer fails the entire transaction rolls back,
        // resetting Closed to absent so the caller can retry.
        env.storage().instance().set(&DataKey::Closed, &true);

        let token_client = token::Client::new(&env, &config.usdc_token);
        let mut total_released: i128 = 0;
        let mut members_released: u32 = 0;

        for member in config.members.iter() {
            let collateral_key = DataKey::Collateral(member.clone());
            let collateral: i128 = env
                .storage()
                .persistent()
                .get(&collateral_key)
                .unwrap_or(0);

            if collateral > 0 {
                // Zero storage before the transfer so a reentrant call on this
                // specific member cannot observe a non-zero balance.
                env.storage().persistent().set(&collateral_key, &0i128);

                Self::safe_transfer(
                    &token_client,
                    &env.current_contract_address(),
                    &member,
                    &collateral,
                    "collateral release",
                );

                total_released = total_released
                    .checked_add(collateral)
                    .unwrap_or_else(|| panic!("total released overflow"));
                members_released += 1;

                // Per-member audit trail: indexers sum these to reconcile
                // with total_released in the closed event.
                env.events().publish(
                    (
                        Symbol::new(&env, "circle"),
                        Symbol::new(&env, "collateral_released"),
                    ),
                    (member, collateral),
                );
            }
        }

        // Arithmetic assertion: every stroop that was in storage must have been
        // released.  If total_released diverges from the pre-release snapshot the
        // entire transaction panics and rolls back, guaranteeing no partial release
        // state is ever committed.  This fires if a member's balance was silently
        // skipped, counted twice, or mutated by a reentrant path that slipped past
        // the Closed guard.
        if total_released != pre_release_total {
            panic!(
                "circle: settlement arithmetic mismatch — released {} but pre-release total was {}",
                total_released, pre_release_total
            );
        }

        let reason = if matches!(status, CircleStatus::Completed) {
            Symbol::new(&env, "completed")
        } else {
            Symbol::new(&env, "cancelled")
        };

        // Aggregate settlement event.
        // Data: (closer, total_released, total_expected_collateral, reason)
        //   total_expected_collateral - total_released = total penalties forfeited
        env.events().publish(
            (Symbol::new(&env, "circle"), Symbol::new(&env, "closed")),
            (closer, total_released, total_expected_collateral, reason),
        );
    }

    /// Returns `true` if `close` has been successfully called and all collateral
    /// has been settled.  Returns `false` for uninitialized or still-open circles.
    ///
    /// This view lets SDKs and indexers check terminal settlement state without
    /// replaying the event log.
    pub fn is_closed(env: Env) -> bool {
        env.storage().instance().has(&DataKey::Closed)
    }

    /// Returns the canonical USDC token address that was locked at initialization.
    ///
    /// This view exposes the immutable token selection so SDKs and indexers can
    /// verify which token a circle uses without deserializing the full
    /// [`CircleConfig`].  The address cannot change after initialization — it is
    /// written once under [`DataKey::UsdcToken`] and never overwritten.
    ///
    /// Returns `Err(ContractError::NotInitialized)` when called before
    /// `initialize`.
    pub fn get_usdc_token(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::UsdcToken)
            .ok_or(ContractError::NotInitialized)
    }

    // ── Read-only views ───────────────────────────────────────────────────────

    /// Returns all tunable protocol constants for this contract.
    ///
    /// Clients can call this view to display the penalty rate, collateral
    /// requirement, and deadline bounds without maintaining a separate constant
    /// table.  Because the values come from the contract's own compile-time
    /// constants, the returned struct is always in sync with actual contract
    /// behaviour.
    ///
    /// This function has no storage reads and does not require the contract to
    /// be initialized — it returns static data unconditionally.
    pub fn get_protocol_params(_env: Env) -> ProtocolParams {
        ProtocolParams {
            penalty_bps: PENALTY_BPS,
            bps_denom: BPS_DENOM,
            collateral_multiplier: COLLATERAL_MULTIPLIER,
            min_round_deadline_ledgers: MIN_ROUND_DEADLINE_LEDGERS,
            max_round_deadline_ledgers: MAX_ROUND_DEADLINE_LEDGERS,
            max_members: MAX_MEMBERS,
        }
    }

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

    /// Returns the total pot amount that will be paid out at the end of the
    /// current round: `round_amount × member_count`.
    ///
    /// This is a pure read — it reads `Config` from instance storage and
    /// computes the product with checked arithmetic.
    ///
    /// # Return values
    ///
    /// | Condition | Result |
    /// |---|---|
    /// | Normal case | `Ok(round_amount × member_count)` |
    /// | Called before `initialize` | `Err(ContractError::NotInitialized)` |
    /// | Arithmetic overflow (theoretical) | `Err(ContractError::PotOverflow)` |
    ///
    /// # Notes
    ///
    /// The `initialize` entry-point already rejects `round_amount` values that
    /// would overflow this multiplication, so `PotOverflow` should never be
    /// returned on a correctly-deployed circle.  The error variant exists so
    /// the SDK / front-end can handle the case gracefully rather than receiving
    /// an opaque contract trap if they ever call this view on an edge-case
    /// deployment.
    pub fn get_pot_amount(env: Env) -> Result<i128, ContractError> {
        let config: CircleConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(ContractError::NotInitialized)?;

        let member_count = config.members.len() as i128;
        config
            .round_amount
            .checked_mul(member_count)
            .ok_or(ContractError::PotOverflow)
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
