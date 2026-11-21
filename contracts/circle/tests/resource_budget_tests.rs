//! Soroban resource budget harness for representative circle workflows (#868).
//!
//! For each member-count tier (minimum, typical, maximum) this harness drives
//! a fresh circle to the point just before a target entry-point, invokes it
//! once, and records the host's per-invocation resource metering via
//! `env.cost_estimate().resources()` (soroban-sdk testutils):
//!
//! | Metric                | Source field                    |
//! |-----------------------|---------------------------------|
//! | CPU instructions      | `instructions`                  |
//! | Memory bytes          | `mem_bytes`                     |
//! | Disk read entries     | `disk_read_entries`             |
//! | In-memory read entries| `memory_read_entries`           |
//! | Write entries         | `write_entries`                 |
//! | Disk read bytes       | `disk_read_bytes`               |
//! | Write bytes           | `write_bytes`                   |
//! | Contract event bytes  | `contract_events_size_bytes`    |
//!
//! Workflows: `create` (`initialize`), `join` (the last, activating join),
//! `contribute` (the last contribution of round 0), `payout` (round 0),
//! `default` (`mark_default` after the deadline ledger), `cancel` (Pending
//! circle with all but one member joined) and `close` (Completed circle with
//! every member's collateral still locked — the maximum release fan-out).
//!
//! # Scope and caveats
//!
//! * Contracts are registered natively (`register_contract`), not as Wasm, so
//!   VM instantiation, Wasm execution and code-entry reads are NOT included.
//!   Instruction counts are therefore a lower bound on real network cost.
//! * Local measurements do not guarantee mainnet inclusion. Network limits,
//!   fees and surge pricing change independently of this repository; always
//!   simulate against RPC before submitting.
//! * Tested toolchain: see [`TOOLCHAIN_RUST`] / [`TOOLCHAIN_SOROBAN_SDK`].
//!   Different compiler or SDK versions legitimately shift these numbers,
//!   which is why comparisons use explicit tolerances (see [`TOLERANCE`]).
//!
//! # Reports and baselines
//!
//! * Set `CIRCLEUP_RESOURCE_REPORT_DIR=<dir>` to write one
//!   `resource-report-<tier>.json` per tier (used by the release check).
//! * Set `CIRCLEUP_RESOURCE_BASELINE_STRICT=1` to fail when any measured
//!   workflow has no recorded baseline.
//! * Baselines live in [`BASELINES`]; the refresh procedure is documented in
//!   `docs/RESOURCE_BUDGETS.md`.

use circle::{
    CircleContract, CircleContractClient, CircleStatus, DataKey, COLLATERAL_MULTIPLIER,
    MAX_MEMBERS, MIN_MEMBERS,
};
use reputation::{ReputationContract, ReputationContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env, Vec as SorobanVec,
};

// ─── Toolchain metadata ───────────────────────────────────────────────────────

/// Rust toolchain pinned in `contracts/rust-toolchain.toml` when the
/// baselines in [`BASELINES`] were recorded.
pub const TOOLCHAIN_RUST: &str = "1.81.0";
/// soroban-sdk version resolved in `contracts/Cargo.lock`.
pub const TOOLCHAIN_SOROBAN_SDK: &str = "29.0.1";
/// Date of the mainnet limit snapshot shipped with the SDK above.
pub const MAINNET_LIMITS_SNAPSHOT: &str = "soroban-sdk 29.x InvocationResourceLimits::mainnet() (2026-07-10)";

// ─── Fixture parameters ───────────────────────────────────────────────────────

const ROUND_AMOUNT: i128 = 10_000_000; // 1 USDC in stroops
const ROUND_DEADLINE: u32 = 1_000; // ledgers
/// Representative production circle size.
pub const TYPICAL_MEMBERS: u32 = 8;

// ─── Tiers and workflows ──────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Min,
    Typical,
    Max,
}

impl Tier {
    pub fn members(self) -> u32 {
        match self {
            Tier::Min => MIN_MEMBERS,
            Tier::Typical => TYPICAL_MEMBERS,
            Tier::Max => MAX_MEMBERS,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tier::Min => "min",
            Tier::Typical => "typical",
            Tier::Max => "max",
        }
    }

    /// Min and typical circles must fit the mainnet per-invocation limits.
    /// The max tier is report-only: exceeding a limit there is surfaced as a
    /// warning in the report and in `docs/RESOURCE_BUDGETS.md`, not a failure,
    /// until a product decision lowers `MAX_MEMBERS` or batches the workflow.
    pub fn must_fit_mainnet(self) -> bool {
        !matches!(self, Tier::Max)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workflow {
    Create,
    Join,
    Contribute,
    Payout,
    Default,
    Cancel,
    Close,
}

pub const WORKFLOWS: [Workflow; 7] = [
    Workflow::Create,
    Workflow::Join,
    Workflow::Contribute,
    Workflow::Payout,
    Workflow::Default,
    Workflow::Cancel,
    Workflow::Close,
];

impl Workflow {
    pub fn name(self) -> &'static str {
        match self {
            Workflow::Create => "create",
            Workflow::Join => "join",
            Workflow::Contribute => "contribute",
            Workflow::Payout => "payout",
            Workflow::Default => "default",
            Workflow::Cancel => "cancel",
            Workflow::Close => "close",
        }
    }
}

// ─── Measurements ─────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Measurement {
    pub instructions: u64,
    pub mem_bytes: u64,
    pub disk_read_entries: u32,
    pub memory_read_entries: u32,
    pub write_entries: u32,
    pub disk_read_bytes: u32,
    pub write_bytes: u32,
    pub events_bytes: u32,
}

/// Read the resources metered for the most recent top-level invocation.
/// Must be called immediately after the target call — any other client call
/// (including read-only getters) replaces the recorded value.
fn measure_last(env: &Env) -> Measurement {
    let r = env.cost_estimate().resources();
    Measurement {
        instructions: r.instructions.max(0) as u64,
        mem_bytes: r.mem_bytes.max(0) as u64,
        disk_read_entries: r.disk_read_entries,
        memory_read_entries: r.memory_read_entries,
        write_entries: r.write_entries,
        disk_read_bytes: r.disk_read_bytes,
        write_bytes: r.write_bytes,
        events_bytes: r.contract_events_size_bytes,
    }
}

// ─── Mainnet limits (snapshot) ────────────────────────────────────────────────

/// Per-invocation mainnet limits copied from the SDK snapshot named in
/// [`MAINNET_LIMITS_SNAPSHOT`]. Refresh together with the SDK; verify against
/// `stellar network settings --network mainnet` before relying on them.
pub mod mainnet {
    pub const INSTRUCTIONS: u64 = 400_000_000;
    pub const MEM_BYTES: u64 = 41_943_040;
    pub const DISK_READ_ENTRIES: u32 = 200;
    pub const WRITE_ENTRIES: u32 = 200;
    pub const DISK_READ_BYTES: u32 = 200_000;
    pub const WRITE_BYTES: u32 = 132_096;
    pub const EVENTS_BYTES: u32 = 16_384;
}

fn mainnet_violations(m: &Measurement) -> Vec<&'static str> {
    let mut v = Vec::new();
    if m.instructions > mainnet::INSTRUCTIONS {
        v.push("instructions");
    }
    if m.mem_bytes > mainnet::MEM_BYTES {
        v.push("mem_bytes");
    }
    if m.disk_read_entries > mainnet::DISK_READ_ENTRIES {
        v.push("disk_read_entries");
    }
    if m.write_entries > mainnet::WRITE_ENTRIES {
        v.push("write_entries");
    }
    if m.disk_read_bytes > mainnet::DISK_READ_BYTES {
        v.push("disk_read_bytes");
    }
    if m.write_bytes > mainnet::WRITE_BYTES {
        v.push("write_bytes");
    }
    if m.events_bytes > mainnet::EVENTS_BYTES {
        v.push("events_bytes");
    }
    v
}

// ─── Baselines and tolerances ─────────────────────────────────────────────────

/// Allowed growth over a recorded baseline before a measurement counts as a
/// regression. CPU/memory vary with compiler and SDK cost-model changes;
/// byte sizes vary slightly with XDR encoding; entry counts are deterministic
/// for a given contract + SDK and therefore get zero tolerance.
pub struct Tolerance {
    pub instructions_pct: u64,
    pub mem_pct: u64,
    pub bytes_pct: u64,
    pub entries_abs: u32,
}

pub const TOLERANCE: Tolerance = Tolerance {
    instructions_pct: 10,
    mem_pct: 10,
    bytes_pct: 5,
    entries_abs: 0,
};

/// Recorded baselines, keyed by (tier, workflow).
///
/// `None` means "not yet recorded with the pinned toolchain". Populate each
/// entry from a `resource-report-<tier>.json` produced by this harness, in the
/// same commit that changes the toolchain, SDK or contract code (see
/// `docs/RESOURCE_BUDGETS.md` → "Refreshing baselines"). Values are never
/// hand-estimated.
pub const BASELINES: [(Tier, Workflow, Option<Measurement>); 21] = [
    (Tier::Min, Workflow::Create, None),
    (Tier::Min, Workflow::Join, None),
    (Tier::Min, Workflow::Contribute, None),
    (Tier::Min, Workflow::Payout, None),
    (Tier::Min, Workflow::Default, None),
    (Tier::Min, Workflow::Cancel, None),
    (Tier::Min, Workflow::Close, None),
    (Tier::Typical, Workflow::Create, None),
    (Tier::Typical, Workflow::Join, None),
    (Tier::Typical, Workflow::Contribute, None),
    (Tier::Typical, Workflow::Payout, None),
    (Tier::Typical, Workflow::Default, None),
    (Tier::Typical, Workflow::Cancel, None),
    (Tier::Typical, Workflow::Close, None),
    (Tier::Max, Workflow::Create, None),
    (Tier::Max, Workflow::Join, None),
    (Tier::Max, Workflow::Contribute, None),
    (Tier::Max, Workflow::Payout, None),
    (Tier::Max, Workflow::Default, None),
    (Tier::Max, Workflow::Cancel, None),
    (Tier::Max, Workflow::Close, None),
];

fn baseline(tier: Tier, wf: Workflow) -> Option<Measurement> {
    BASELINES
        .iter()
        .find(|(t, w, _)| *t == tier && *w == wf)
        .and_then(|(_, _, m)| *m)
}

fn exceeds_pct(actual: u64, base: u64, pct: u64) -> bool {
    actual > base.saturating_add(base.saturating_mul(pct) / 100)
}

fn exceeds_abs(actual: u32, base: u32, abs: u32) -> bool {
    actual > base.saturating_add(abs)
}

/// Metrics that grew beyond tolerance relative to `base`.
fn regressions(m: &Measurement, base: &Measurement) -> Vec<String> {
    let t = &TOLERANCE;
    let mut out = Vec::new();
    let mut chk = |name: &str, bad: bool, actual: u64, b: u64| {
        if bad {
            out.push(format!("{name}: {actual} > baseline {b} (+tolerance)"));
        }
    };
    chk(
        "instructions",
        exceeds_pct(m.instructions, base.instructions, t.instructions_pct),
        m.instructions,
        base.instructions,
    );
    chk(
        "mem_bytes",
        exceeds_pct(m.mem_bytes, base.mem_bytes, t.mem_pct),
        m.mem_bytes,
        base.mem_bytes,
    );
    chk(
        "disk_read_entries",
        exceeds_abs(m.disk_read_entries, base.disk_read_entries, t.entries_abs),
        m.disk_read_entries.into(),
        base.disk_read_entries.into(),
    );
    chk(
        "memory_read_entries",
        exceeds_abs(m.memory_read_entries, base.memory_read_entries, t.entries_abs),
        m.memory_read_entries.into(),
        base.memory_read_entries.into(),
    );
    chk(
        "write_entries",
        exceeds_abs(m.write_entries, base.write_entries, t.entries_abs),
        m.write_entries.into(),
        base.write_entries.into(),
    );
    chk(
        "disk_read_bytes",
        exceeds_pct(m.disk_read_bytes.into(), base.disk_read_bytes.into(), t.bytes_pct),
        m.disk_read_bytes.into(),
        base.disk_read_bytes.into(),
    );
    chk(
        "write_bytes",
        exceeds_pct(m.write_bytes.into(), base.write_bytes.into(), t.bytes_pct),
        m.write_bytes.into(),
        base.write_bytes.into(),
    );
    chk(
        "events_bytes",
        exceeds_pct(m.events_bytes.into(), base.events_bytes.into(), t.bytes_pct),
        m.events_bytes.into(),
        base.events_bytes.into(),
    );
    out
}

fn strict_baselines() -> bool {
    std::env::var("CIRCLEUP_RESOURCE_BASELINE_STRICT").is_ok_and(|v| v == "1")
}

// ─── Harness ──────────────────────────────────────────────────────────────────

struct Harness {
    env: Env,
    circle: CircleContractClient<'static>,
    circle_id: Address,
    admin: Address,
    token: Address,
    rep_id: Address,
    members: SorobanVec<Address>,
}

impl Harness {
    fn new(member_count: u32) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        // Measure, don't enforce: limits are evaluated by the harness so the
        // max tier reports over-limit workflows instead of aborting in setup.
        env.cost_estimate().disable_resource_limits();
        env.cost_estimate().budget().reset_unlimited();

        let token_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(token_admin);
        let asset = StellarAssetClient::new(&env, &sac.address());
        // Collateral + one round contribution, with headroom.
        let funds = ROUND_AMOUNT * COLLATERAL_MULTIPLIER + ROUND_AMOUNT * 2;

        let mut members = SorobanVec::new(&env);
        for _ in 0..member_count {
            let m = Address::generate(&env);
            asset.mint(&m, &funds);
            members.push_back(m);
        }

        let rep_id = env.register_contract(None, ReputationContract);
        let rep = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep.initialize(&rep_admin);

        let circle_id = env.register_contract(None, CircleContract);
        rep.add_authorized_caller(&rep_admin, &circle_id);
        let circle = CircleContractClient::new(&env, &circle_id);

        Harness {
            admin: Address::generate(&env),
            token: sac.address(),
            env,
            circle,
            circle_id,
            rep_id,
            members,
        }
    }

    fn n(&self) -> u32 {
        self.members.len()
    }

    fn member(&self, i: u32) -> Address {
        self.members.get(i).unwrap()
    }

    fn initialize(&self) {
        self.circle.initialize(
            &self.admin,
            &self.members,
            &ROUND_AMOUNT,
            &self.token,
            &self.rep_id,
            &ROUND_DEADLINE,
        );
    }

    fn join_first(&self, k: u32) {
        for i in 0..k {
            self.circle.join(&self.member(i));
        }
    }

    fn contribute_first(&self, k: u32) {
        for i in 0..k {
            self.circle.contribute(&self.member(i));
        }
    }

    /// Advance the ledger to exactly one past the current deadline ledger.
    fn advance_past_deadline(&self) {
        let deadline = self.circle.get_current_round().deadline_ledger;
        let target = u32::try_from(deadline + 1).expect("deadline fits in u32");
        self.env.ledger().with_mut(|l| l.sequence_number = target);
    }

    /// Mark the circle Completed with all rounds accounted for, leaving every
    /// member's collateral locked so `close` exercises its full fan-out.
    fn force_completed(&self) {
        let n = self.n();
        self.env.as_contract(&self.circle_id, || {
            let s = self.env.storage().instance();
            s.set(&DataKey::Status, &CircleStatus::Completed);
            s.set(&DataKey::RoundsCompleted, &n);
        });
    }
}

/// Prepare state for `wf`, invoke it once and return its measured resources.
fn run_workflow(tier: Tier, wf: Workflow) -> Measurement {
    let h = Harness::new(tier.members());
    let n = h.n();
    match wf {
        Workflow::Create => {
            h.initialize();
        }
        Workflow::Join => {
            h.initialize();
            h.join_first(n - 1);
            h.circle.join(&h.member(n - 1));
        }
        Workflow::Contribute => {
            h.initialize();
            h.join_first(n);
            h.contribute_first(n - 1);
            h.circle.contribute(&h.member(n - 1));
        }
        Workflow::Payout => {
            h.initialize();
            h.join_first(n);
            h.contribute_first(n);
            h.circle.payout();
        }
        Workflow::Default => {
            h.initialize();
            h.join_first(n);
            h.contribute_first(n - 1);
            h.advance_past_deadline();
            h.circle.mark_default(&h.member(n - 1));
        }
        Workflow::Cancel => {
            h.initialize();
            h.join_first(n - 1);
            h.circle.cancel(&h.member(0));
        }
        Workflow::Close => {
            h.initialize();
            h.join_first(n);
            h.force_completed();
            h.circle.close(&h.member(0));
        }
    }
    measure_last(&h.env)
}

// ─── Report ───────────────────────────────────────────────────────────────────

struct Row {
    workflow: Workflow,
    m: Measurement,
    over_mainnet: Vec<&'static str>,
    baseline_status: &'static str,
    notes: Vec<String>,
}

fn json_str_list<S: AsRef<str>>(items: &[S]) -> String {
    let inner: Vec<String> = items
        .iter()
        .map(|s| format!("\"{}\"", s.as_ref().replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("[{}]", inner.join(","))
}

fn render_report(tier: Tier, rows: &[Row]) -> String {
    let mut body = Vec::new();
    for r in rows {
        body.push(format!(
            concat!(
                "    {{\"workflow\":\"{}\",\"instructions\":{},\"mem_bytes\":{},",
                "\"disk_read_entries\":{},\"memory_read_entries\":{},\"write_entries\":{},",
                "\"disk_read_bytes\":{},\"write_bytes\":{},\"events_bytes\":{},",
                "\"exceeds_mainnet\":{},\"baseline\":\"{}\",\"notes\":{}}}"
            ),
            r.workflow.name(),
            r.m.instructions,
            r.m.mem_bytes,
            r.m.disk_read_entries,
            r.m.memory_read_entries,
            r.m.write_entries,
            r.m.disk_read_bytes,
            r.m.write_bytes,
            r.m.events_bytes,
            json_str_list(&r.over_mainnet),
            r.baseline_status,
            json_str_list(&r.notes),
        ));
    }
    format!(
        concat!(
            "{{\n  \"schema\":\"circleup.resource-report.v1\",\n",
            "  \"tier\":\"{}\",\n  \"members\":{},\n",
            "  \"toolchain\":{{\"rust\":\"{}\",\"soroban_sdk\":\"{}\"}},\n",
            "  \"mainnet_limits\":\"{}\",\n",
            "  \"tolerance\":{{\"instructions_pct\":{},\"mem_pct\":{},\"bytes_pct\":{},\"entries_abs\":{}}},\n",
            "  \"registration\":\"native (excludes Wasm VM costs)\",\n",
            "  \"disclaimer\":\"Local measurements do not guarantee mainnet inclusion; simulate via RPC before submitting.\",\n",
            "  \"workflows\":[\n{}\n  ]\n}}\n"
        ),
        tier.name(),
        tier.members(),
        TOOLCHAIN_RUST,
        TOOLCHAIN_SOROBAN_SDK,
        MAINNET_LIMITS_SNAPSHOT,
        TOLERANCE.instructions_pct,
        TOLERANCE.mem_pct,
        TOLERANCE.bytes_pct,
        TOLERANCE.entries_abs,
        body.join(",\n"),
    )
}

fn emit_report(tier: Tier, rows: &[Row]) {
    let json = render_report(tier, rows);
    match std::env::var("CIRCLEUP_RESOURCE_REPORT_DIR") {
        Ok(dir) if !dir.is_empty() => {
            std::fs::create_dir_all(&dir).expect("create report dir");
            let path = std::path::Path::new(&dir).join(format!("resource-report-{}.json", tier.name()));
            std::fs::write(&path, &json).expect("write resource report");
            println!("resource report written: {}", path.display());
        }
        _ => println!("{json}"),
    }
}

// ─── Tier runner ──────────────────────────────────────────────────────────────

fn run_tier(tier: Tier) {
    let mut rows = Vec::new();
    let mut failures = Vec::new();

    for wf in WORKFLOWS {
        let m = run_workflow(tier, wf);
        let mut notes = Vec::new();

        // Sanity: every workflow performs real, metered work.
        if m.instructions == 0 || m.write_entries == 0 {
            failures.push(format!(
                "{}/{}: metering returned zero instructions or writes — harness is not measuring the target call",
                tier.name(),
                wf.name()
            ));
        }

        let over = mainnet_violations(&m);
        if !over.is_empty() {
            let msg = format!(
                "{}/{} exceeds mainnet per-invocation limits: {:?}",
                tier.name(),
                wf.name(),
                over
            );
            if tier.must_fit_mainnet() {
                failures.push(msg);
            } else {
                println!("WARNING: {msg}");
                notes.push(msg);
            }
        }

        let baseline_status = match baseline(tier, wf) {
            None => {
                if strict_baselines() {
                    failures.push(format!("{}/{}: no recorded baseline", tier.name(), wf.name()));
                }
                "unbaselined"
            }
            Some(base) => {
                let regs = regressions(&m, &base);
                if regs.is_empty() {
                    "within_tolerance"
                } else {
                    for r in &regs {
                        failures.push(format!("{}/{}: {r}", tier.name(), wf.name()));
                    }
                    notes.extend(regs);
                    "regressed"
                }
            }
        };

        rows.push(Row {
            workflow: wf,
            m,
            over_mainnet: over,
            baseline_status,
            notes,
        });
    }

    emit_report(tier, &rows);
    assert!(
        failures.is_empty(),
        "resource budget check failed for tier {} ({} members):\n{}",
        tier.name(),
        tier.members(),
        failures.join("\n")
    );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn resource_budget_min_members() {
    run_tier(Tier::Min);
}

#[test]
fn resource_budget_typical_members() {
    run_tier(Tier::Typical);
}

#[test]
fn resource_budget_max_members() {
    run_tier(Tier::Max);
}

/// `close` releases collateral to every member, so its write footprint must
/// grow with member count. Guards against the harness accidentally measuring
/// a short-circuited close.
#[test]
fn close_write_entries_scale_with_member_count() {
    let min = run_workflow(Tier::Min, Workflow::Close);
    let typical = run_workflow(Tier::Typical, Workflow::Close);
    assert!(
        typical.write_entries > min.write_entries,
        "close writes should scale with members: min={} typical={}",
        min.write_entries,
        typical.write_entries
    );
    assert!(typical.events_bytes > min.events_bytes);
}

/// The baseline table must cover every (tier, workflow) cell exactly once.
#[test]
fn baseline_table_covers_full_matrix() {
    for tier in [Tier::Min, Tier::Typical, Tier::Max] {
        for wf in WORKFLOWS {
            let count = BASELINES
                .iter()
                .filter(|(t, w, _)| *t == tier && *w == wf)
                .count();
            assert_eq!(count, 1, "{}/{} must appear exactly once", tier.name(), wf.name());
        }
    }
}

/// Tolerance arithmetic is inclusive at the boundary.
#[test]
fn tolerance_boundaries() {
    assert!(!exceeds_pct(110, 100, 10));
    assert!(exceeds_pct(111, 100, 10));
    assert!(!exceeds_abs(5, 5, 0));
    assert!(exceeds_abs(6, 5, 0));
    let base = Measurement {
        instructions: 1_000,
        mem_bytes: 1_000,
        disk_read_entries: 3,
        memory_read_entries: 3,
        write_entries: 3,
        disk_read_bytes: 100,
        write_bytes: 100,
        events_bytes: 100,
    };
    assert!(regressions(&base, &base).is_empty());
    let worse = Measurement { write_entries: 4, ..base };
    assert_eq!(regressions(&worse, &base).len(), 1);
}

#[test]
fn report_is_labelled_with_toolchain_and_disclaimer() {
    let rows = vec![Row {
        workflow: Workflow::Create,
        m: Measurement::default(),
        over_mainnet: vec![],
        baseline_status: "unbaselined",
        notes: vec![],
    }];
    let json = render_report(Tier::Min, &rows);
    assert!(json.contains(TOOLCHAIN_RUST));
    assert!(json.contains(TOOLCHAIN_SOROBAN_SDK));
    assert!(json.contains("do not guarantee mainnet inclusion"));
    assert!(json.contains("\"workflow\":\"create\""));
}
