//! Type definitions, error enums, constants, and helper functions
//! for the circle contract.
//!
//! Extracted from lib.rs to reduce its LOC.
//! All items here are re-exported from lib.rs via use crate::types::*.

use soroban_sdk::{contracttype, contracterror, Address, Env, Symbol, Vec};

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
    /// Admin address — the only account that may pause or resume this circle.
    /// Set once at `initialize` time; typically the factory contract or deployer.
    /// Immutable after initialization.
    Admin,
    /// Pause flag — present and `true` when the circle is paused.
    /// Absent (or `false`) when the circle is operating normally.
    /// When present, all fund-moving entry-points (join, contribute, payout,
    /// mark_default, close) are blocked.  Read-only views remain available.
    Paused,
}

// ─── Initialization-specific error type ──────────────────────────────────────
//
// Deterministic initialization validation uses `panic_with_error` so Soroban
// consumers receive a stable code while the host still rolls back the call.
// Infrastructure and cross-contract failures that cannot be classified here
// remain host diagnostics.

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
    /// `initialize` was re-entered while initialization was in progress.
    InitializeInProgress = 14,
}

// ─── Pause / emergency-recovery error type ───────────────────────────────────
//
// Returned by `pause` and `resume` so callers receive a typed, inspectable
// error code rather than an opaque panic when authorization or state guards
// fire.  Using `contracterror` keeps the error model consistent with the rest
// of the contract's typed-error approach and lets SDK consumers branch on
// stable codes rather than message strings.

/// Typed errors returned by `pause` and `resume`.
///
/// The numeric discriminants are stable — do not renumber existing variants.
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum PauseError {
    /// Caller is not the stored admin address.
    Unauthorized = 1,
    /// `pause` was called when the circle is already paused.
    AlreadyPaused = 2,
    /// `resume` was called when the circle is not paused.
    NotPaused = 3,
    /// `pause` or `resume` was called before `initialize`.
    NotInitialized = 4,
}

/// Typed errors returned by [`CircleContract::close`].
///
/// Using `contracterror` keeps the error model consistent with `PauseError`
/// and lets SDK consumers branch on stable codes rather than message strings.
///
/// The numeric discriminants are stable — do not renumber existing variants.
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum CloseError {
    /// `close` was called after a previous successful call.
    AlreadyClosed = 1,
    /// `close` was called while the circle is not in a terminal state
    /// (`Active` or `Pending`). Call `cancel` first for a Pending circle.
    NotTerminalState = 2,
    /// Caller is neither the stored admin nor a configured circle member.
    Unauthorized = 3,
    /// Circle status is `Completed` but `RoundsCompleted` does not equal
    /// the member count — storage inconsistency guard.
    RoundsIncomplete = 4,
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

// ─── Events ───────────────────────────────────────────────────────────────────

/// Topic-0 namespace shared by every event this contract publishes.
///
/// Every circle event is published with topics `(EVENT_NAMESPACE, <name>)`
/// and carries the emitting `circle_address` as its **first data field**, so
/// indexers can filter on one topic and attribute each event to its circle
/// from the payload alone.  The factory and reputation contracts follow the
/// same convention with their own namespaces (`"factory"`, `"reputation"`).
///
/// Build topics with [`event_topics`] instead of spelling the namespace
/// inline, so a typo cannot silently route an event past the indexer.
pub const EVENT_NAMESPACE: &str = "circle";

/// Topics tuple `(EVENT_NAMESPACE, name)` for a circle event.
fn event_topics(env: &Env, name: &str) -> (Symbol, Symbol) {
    (Symbol::new(env, EVENT_NAMESPACE), Symbol::new(env, name))
}

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
// Stable contract error codes for views and common deterministic mutation
// guards. Soroban still rolls the whole invocation back on `panic_with_error`;
// external host and cross-contract failures remain explicit diagnostics.