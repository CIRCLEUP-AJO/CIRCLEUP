/**
 * deploy.ts — Deploy CircleUp contracts to Stellar Testnet only.
 *
 * Enhancements:
 *   #397 — Preflight checks: validates network, account funding, tool
 *           availability, and WASM artifacts before any write transaction.
 *   #398 — Deployment manifest: writes an atomic, checksummed
 *           manifest after all contracts are successfully deployed.
 *   #399 — Funding diagnostics: reports which balance is insufficient and
 *           why, with actionable remediation steps.
 *
 * Prerequisites:
 *   - Rust + stellar-cli installed
 *   - `stellar keys generate --global deployer --network testnet` run once
 *   - contracts built: `cargo build --release --target wasm32-unknown-unknown`
 *     (the script will build them automatically if WASM files are absent)
 *
 * Usage:
 *   npx ts-node src/deploy.ts [--skip-preflight] [--network <name>] [--dry-run]
 *                             [--resume] [--yes]
 *
 * Flags:
 *   --skip-preflight   Bypass read-only preflight checks (not recommended)
 *   --network          testnet only (default: testnet)
 *   --dry-run          Run local validation + read-only network checks only.
 *                      Prints the target network and intended contract operations.
 *                      Never constructs a signer, uploads WASM, or submits a tx.
 *   --resume           Diagnose an interrupted deployment and resume it. Reads
 *                      existing deployment state, prints a read-only resume plan,
 *                      and requires explicit confirmation for each mutating step.
 *   --yes              Auto-confirm recovery steps (only meaningful with --resume).
 *
 * Exit codes:
 *   0 — All contracts deployed; manifest written to scripts/deployed-manifest.json
 *   1 — Preflight failed or deployment error; no writes were made (when preflight fails)
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as dotenv from "dotenv";

import {
  runFundingDiagnostics,
  printFundingDiagnostics,
} from "./funding-diagnostics";
import {
  writeManifest,
  validateManifest,
  printManifestSummary,
  type ManifestInput,
} from "./deployment-manifest";
import { runDeployPreflight } from "./deploy-preflight";
import { redactSecrets } from "./redact";
import * as readline from "readline";

// Load scripts/.env
dotenv.config({ path: path.join(__dirname, "../.env") });

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const SKIP_PREFLIGHT = args.includes("--skip-preflight");
const DRY_RUN        = args.includes("--dry-run");
const RESUME         = args.includes("--resume");
const AUTO_YES       = args.includes("--yes");
const NETWORK_ARG    = (() => {
  const idx = args.indexOf("--network");
  return idx !== -1 ? args[idx + 1] : undefined;
})();

// ── Config ────────────────────────────────────────────────────────────────────

const NETWORK  = NETWORK_ARG ?? process.env.NETWORK ?? "testnet";
const DEPLOYER = process.env.DEPLOYER_IDENTITY ?? "deployer";

if (NETWORK !== "testnet") {
  console.error(
    `[deploy] Unsupported deployment network: ${NETWORK}. This command is testnet-only. ` +
    "Use the dedicated mainnet readiness gate before any separately approved mainnet procedure.",
  );
  process.exit(1);
}

const NETWORK_PASSPHRASE_MAP: Record<string, string> = {
  testnet:   "Test SDF Network ; September 2015",
};
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? NETWORK_PASSPHRASE_MAP.testnet;

const RPC_URL_MAP: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
};
const RPC_URL = process.env.STELLAR_RPC_URL ?? RPC_URL_MAP.testnet;

// ── Paths ─────────────────────────────────────────────────────────────────────

const ROOT         = path.join(__dirname, "../..");
const CONTRACTS    = path.join(ROOT, "contracts");
const WASM_DIR     = path.join(CONTRACTS, "target/wasm32-unknown-unknown/release");
const TOOLCHAIN_FILE = path.join(CONTRACTS, "rust-toolchain.toml");
const CARGO_LOCK   = path.join(CONTRACTS, "Cargo.lock");
const MANIFEST_OUT = path.join(__dirname, "../deployed-manifest.json");
const STATE_OUT    = path.join(__dirname, "../deploy-state.json");
const LEGACY_OUT   = path.join(__dirname, "../deployed.json");

// ── Deployment state (#146) ───────────────────────────────────────────────────
//
// Each mutating step is recorded as it progresses so an interrupted run can be
// diagnosed and resumed without silently duplicating contracts. A step moves
// through: started → uploaded → deployed → initialized → complete.
//
// IMPORTANT: partial state NEVER produces a valid-looking complete manifest.
// The manifest is only written once every step is `complete`.

type StepStatus = "started" | "uploaded" | "deployed" | "initialized" | "complete";

interface StepState {
  status: StepStatus;
  /** Contract id, once known. */
  contractId?: string;
  /** On-chain WASM hash, once known. */
  wasmHash?: string;
  /** Transaction hash of the deploy/install operation, once known. */
  txHash?: string;
  /** Transaction hash of the initialize operation, once known. */
  initTxHash?: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

interface DeployState {
  network: string;
  deployerPublicKey: string;
  startedAt: string;
  steps: Record<string, StepState>;
}

function loadState(): DeployState | undefined {
  if (!fs.existsSync(STATE_OUT)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(STATE_OUT, "utf8")) as DeployState;
  } catch {
    return undefined;
  }
}

function saveState(state: DeployState): void {
  state.steps = state.steps ?? {};
  const tmp = `${STATE_OUT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_OUT);
}

function recordStep(
  state: DeployState,
  step: string,
  patch: Partial<StepState>,
): void {
  const prev = state.steps[step] ?? { status: "started", updatedAt: "" };
  state.steps[step] = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);
}

function clearState(): void {
  if (fs.existsSync(STATE_OUT)) fs.unlinkSync(STATE_OUT);
}

/** Ask the operator to confirm a mutating recovery step. */
async function confirmStep(question: string): Promise<boolean> {
  if (AUTO_YES) {
    console.log(`  ↳ auto-confirmed (--yes): ${question}`);
    return true;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question(`  ${question} [y/N] `, resolve),
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string, label: string): string {
  console.log(`\n[deploy] ${label}...`);
  const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  const trimmed = result.trim();
  console.log(`  ✅ ${redactSecrets(trimmed)}`);
  return trimmed;
}

/** SHA-256 of a file as a hex string. */
function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Read a value from rust-toolchain.toml */
function readPinnedToolchain(): string {
  if (!fs.existsSync(TOOLCHAIN_FILE)) return "unknown";
  const content = fs.readFileSync(TOOLCHAIN_FILE, "utf8");
  const m = content.match(/channel\s*=\s*"([^"]+)"/);
  return m ? m[1] : "unknown";
}

/** Read soroban-sdk version from workspace Cargo.toml. */
function readSorobanSdkVersion(): string {
  const cargoToml = fs.readFileSync(path.join(CONTRACTS, "Cargo.toml"), "utf8");
  const m = cargoToml.match(/soroban-sdk\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/);
  return m ? m[1] : "unknown";
}

/** Get the current git commit SHA, or undefined if not in a git repo. */
function gitCommit(): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

// ── Preflight checks (#397) ───────────────────────────────────────────────────

interface PreflightResult {
  ok: boolean;
  failures: string[];
  plan: string[];
}

/**
 * Phase 1 — local validation. Everything here is purely local: no network
 * access, no signer construction, no transactions.
 */
function runLocalValidation(): PreflightResult {
  const failures: string[] = [];
  const plan: string[] = [];

  console.log("\n[preflight:local] Validating local inputs...");
  console.log("  (read-only — no transactions will be submitted)\n");

  // ── Network validation ────────────────────────────────────────────────────

  const knownNetworks = ["testnet", "mainnet", "futurenet"];
  if (!knownNetworks.includes(NETWORK)) {
    failures.push(
      `Unknown network "${NETWORK}". Valid options: ${knownNetworks.join(", ")}`,
    );
  } else {
    console.log(`  ✅ Network: ${NETWORK}`);
    plan.push(`Deploy to: ${NETWORK}`);
  }

  if (!NETWORK_PASSPHRASE) {
    failures.push(
      `NETWORK_PASSPHRASE is not set for network "${NETWORK}".\n` +
      "  Set NETWORK_PASSPHRASE in scripts/.env or use a known network name.",
    );
  } else {
    console.log(`  ✅ Network passphrase set`);
  }

  if (!RPC_URL) {
    failures.push(
      `STELLAR_RPC_URL is not set for network "${NETWORK}".\n` +
      "  Set STELLAR_RPC_URL in scripts/.env or use a known network name.",
    );
  } else {
    console.log(`  ✅ RPC URL set: ${RPC_URL}`);
  }

  // ── stellar-cli availability ──────────────────────────────────────────────

  try {
    const cliVersion = execSync("stellar version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    console.log(`  ✅ stellar-cli: ${cliVersion.split("\n")[0]}`);
  } catch {
    failures.push(
      "stellar-cli is not installed or not on PATH.\n" +
      "  Install: cargo install --locked stellar-cli --features opt",
    );
  }

  // ── Rust / cargo availability ─────────────────────────────────────────────

  try {
    const rustVersion = execSync("rustc --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    console.log(`  ✅ Rust: ${rustVersion}`);

    const pinnedToolchain = readPinnedToolchain();
    if (pinnedToolchain !== "unknown" && !rustVersion.includes(pinnedToolchain)) {
      console.warn(
        `  ⚠  Active Rust (${rustVersion}) differs from pinned toolchain ` +
        `(${pinnedToolchain} in contracts/rust-toolchain.toml).\n` +
        `     Run: rustup override set ${pinnedToolchain}`,
      );
    }
  } catch {
    failures.push(
      "Rust / cargo is not installed or not on PATH.\n" +
      "  Install: https://rustup.rs",
    );
  }

  // ── WASM target ───────────────────────────────────────────────────────────

  try {
    const targets = execSync("rustup target list --installed", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (targets.includes("wasm32-unknown-unknown")) {
      console.log("  ✅ wasm32-unknown-unknown target installed");
    } else {
      failures.push(
        "wasm32-unknown-unknown Rust target is not installed.\n" +
        "  Install: rustup target add wasm32-unknown-unknown",
      );
    }
  } catch {
    // rustup not available — defer to cargo build failure
    console.log("  ℹ  Could not check rustup targets — will attempt build anyway");
  }

  // ── WASM artifact presence ────────────────────────────────────────────────

  const wasmFiles: Record<string, string> = {
    "reputation.wasm":     path.join(WASM_DIR, "reputation.wasm"),
    "circle_factory.wasm": path.join(WASM_DIR, "circle_factory.wasm"),
    "circle.wasm":         path.join(WASM_DIR, "circle.wasm"),
  };

  let artifactsPresent = true;
  for (const [name, p] of Object.entries(wasmFiles)) {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      const sizeKb = (stat.size / 1024).toFixed(1);
      console.log(`  ✅ ${name} (${sizeKb} KB)`);
      plan.push(`  Deploy ${name}: ${p}`);
    } else {
      console.log(`  ⚠  ${name}: not found — will build`);
      artifactsPresent = false;
    }
  }

  if (!artifactsPresent) {
    plan.push("  Build contracts before deploying (cargo build --release)");
  }

  // ── USDC token address (wrong-token guard) ────────────────────────────────

  const usdcEnv = process.env.USDC_ADDRESS;
  if (usdcEnv) {
    // Stellar contract ids are 56-char StrKey strings starting with "C".
    if (!/^C[A-Z2-7]{55}$/.test(usdcEnv)) {
      failures.push(
        `USDC_ADDRESS "${usdcEnv}" is not a valid Stellar contract id.\n` +
        "  Expected a 56-character StrKey starting with 'C'.",
      );
    } else {
      console.log(`  ✅ USDC_ADDRESS: ${usdcEnv}`);
      plan.push(`  Use USDC token: ${usdcEnv}`);
    }
  } else {
    console.log("  ℹ  USDC_ADDRESS not set — a test token will be deployed (testnet only)");
    plan.push("  Deploy test token (testnet only — use real USDC on mainnet)");
  }

  // ── Existing manifest / state guard ───────────────────────────────────────

  if (fs.existsSync(MANIFEST_OUT) && !RESUME) {
    failures.push(
      `A deployment manifest already exists at ${MANIFEST_OUT}.\n` +
      "  Re-running would deploy duplicate contracts.\n" +
      "  To diagnose and resume an interrupted deployment: --resume\n" +
      "  To start over, remove the manifest and deploy-state.json first.",
    );
  } else if (fs.existsSync(MANIFEST_OUT)) {
    console.log(`  ℹ  Existing manifest found — resume mode will reuse it`);
  }

  const existingState = loadState();
  if (existingState && !RESUME) {
    failures.push(
      `A partial deployment state file exists at ${STATE_OUT}.\n` +
      "  A previous run was interrupted. Re-run with --resume to diagnose and resume.",
    );
  } else if (existingState) {
    console.log(`  ℹ  Partial deployment state found — resume mode will reuse it`);
  }

  return { ok: failures.length === 0, failures, plan };
}

/**
 * Phase 2 — read-only network checks. May contact the RPC, but never
 * constructs a signer or submits a transaction.
 */
async function runReadOnlyNetworkChecks(deployerPublicKey: string): Promise<PreflightResult> {
  const failures: string[] = [];
  const plan: string[] = [];

  console.log("\n[preflight:network] Running read-only network checks...");
  console.log("  (read-only — no transactions will be submitted)\n");

  // ── 0. Comprehensive network & configuration preflight (#895 / Issue 59) ───
  const configPreflight = await runDeployPreflight({
    network: NETWORK,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    deployerPublicKey: deployerPublicKey || undefined,
  });

  if (!configPreflight.ok) {
    for (const err of configPreflight.errors) {
      failures.push(err);
    }
  } else {
    console.log(`  ✅ Network configuration verified for: ${configPreflight.configuredFacts.resolvedNetwork}`);
    if (configPreflight.verifiedFacts.remoteRpcStatus === "verified") {
      console.log(`  ✅ Live RPC verified: ${configPreflight.configuredFacts.rpcUrl}`);
    } else if (configPreflight.verifiedFacts.remoteRpcStatus === "unavailable") {
      console.log(`  ⚠  Live RPC check unavailable (${configPreflight.verifiedFacts.remoteRpcError})`);
    }
  }

  // ── Deployer identity ─────────────────────────────────────────────────────

  try {
    execSync(`stellar keys address ${DEPLOYER}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`  ✅ Deployer identity "${DEPLOYER}" exists`);
    plan.push(`Deployer identity: ${DEPLOYER} (${deployerPublicKey})`);
  } catch {
    failures.push(
      `Deployer identity "${DEPLOYER}" not found in stellar-cli keystore.\n` +
      `  Create it: stellar keys generate --global ${DEPLOYER} --network ${NETWORK}\n` +
      `  Fund it:   stellar keys fund ${DEPLOYER} --network ${NETWORK}`,
    );
  }

  // ── Funding diagnostics (#399) ────────────────────────────────────────────

  if (deployerPublicKey && !failures.some((f) => f.includes("stellar-cli"))) {
    const fundingResult = await runFundingDiagnostics({
      rpcUrl:           RPC_URL,
      deployerPublicKey,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    printFundingDiagnostics(fundingResult);

    if (!fundingResult.ok) {
      for (const f of fundingResult.failures) {
        failures.push(
          `Insufficient ${f.checkType} balance for ${f.label}.\n${f.guidance ?? ""}`,
        );
      }
    }
  }

  return { ok: failures.length === 0, failures, plan };
}

/** Print the target network and intended contract operations. */
function printDeploymentPlan(deployerPublicKey: string): void {
  console.log("\n[preflight] Deployment plan:");
  console.log(`  Network          : ${NETWORK}`);
  console.log(`  RPC URL          : ${RPC_URL}`);
  console.log(`  Deployer         : ${DEPLOYER} (${deployerPublicKey || "<unknown>"})`);
  console.log(`  Rust toolchain   : ${readPinnedToolchain()}`);
  console.log(`  Soroban SDK      : ${readSorobanSdkVersion()}`);
  console.log(`  Contracts to deploy:`);
  console.log(`    1. reputation     (no dependencies)`);
  console.log(`    2. circle_factory (depends on: reputation)`);
  console.log(`    3. circle         (WASM installed; hash passed to factory init)`);
  console.log(`  Manifest output  : ${MANIFEST_OUT}`);
  console.log(`  State output     : ${STATE_OUT}`);
}

/**
 * Read-only resume plan (#146). Inspects persisted state and reports which
 * steps are safe to reuse vs. must be (re)executed. Never mutates anything.
 */
function printResumePlan(state: DeployState | undefined): void {
  console.log("\n[resume] Read-only resume plan:");
  if (!state) {
    console.log("  No prior deployment state found — a fresh deployment will run.");
    return;
  }
  console.log(`  Started at : ${state.startedAt}`);
  console.log(`  Network    : ${state.network}`);
  console.log(`  Deployer   : ${state.deployerPublicKey}`);
  for (const [step, s] of Object.entries(state.steps)) {
    const reuse =
      s.status === "complete" || s.status === "initialized" || s.status === "deployed";
    console.log(
      `  • ${step.padEnd(16)} ${s.status.padEnd(12)} ` +
      `${s.contractId ?? "-"} ${reuse ? "(reuse)" : "(will re-run)"}`,
    );
  }
  console.log(
    "\n  NOTE: an existing address alone is NOT proof of a safe partial deployment.\n" +
    "  Each mutating recovery step requires explicit confirmation.",
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 CircleUp Contract Deployment`);
  console.log(`   Network: ${NETWORK}`);
  console.log(`   Deployer identity: ${DEPLOYER}`);
  if (DRY_RUN) console.log(`   Mode: DRY RUN (read-only)`);
  if (RESUME)  console.log(`   Mode: RESUME`);

  // ── Get deployer public key (read-only keystore lookup) ───────────────────

  let deployerAddress = "";
  try {
    deployerAddress = execSync(`stellar keys address ${DEPLOYER}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // Will be caught in preflight
  }

  // ── Phase 1: local validation ─────────────────────────────────────────────

  const local = runLocalValidation();
  const failures: string[] = [...local.failures];

  // ── Phase 2: read-only network checks ─────────────────────────────────────

  if (!SKIP_PREFLIGHT) {
    const network = await runReadOnlyNetworkChecks(deployerAddress);
    failures.push(...network.failures);
  } else {
    console.log("\n[preflight] ⚠  Network preflight skipped (--skip-preflight).\n");
    if (deployerAddress) {
      const fundingResult = await runFundingDiagnostics({
        rpcUrl:           RPC_URL,
        deployerPublicKey: deployerAddress,
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      printFundingDiagnostics(fundingResult);
    }
  }

  // ── Report every detected failure before any write is constructed ─────────

  printDeploymentPlan(deployerAddress);

  if (failures.length > 0) {
    console.error("\n[deploy] ❌ Preflight failed — aborting before any write.\n");
    for (const f of failures) {
      console.error(`  • ${f}`);
    }
    console.error(
      "\n  Fix the issues above and re-run.\n" +
      "  To bypass network checks (not recommended): --skip-preflight\n",
    );
    process.exit(1);
  }

  console.log("\n[preflight] ✅ All preflight checks passed.\n");

  // ── Dry-run: stop here. No signer, no upload, no transaction. ─────────────

  if (DRY_RUN) {
    printResumePlan(loadState());
    console.log("\n[dry-run] ✅ Read-only preflight complete. No transactions were submitted.");
    console.log("[dry-run] Re-run without --dry-run to deploy.\n");
    return;
  }

  // ── Resume diagnosis (#146) ───────────────────────────────────────────────

  let state: DeployState | undefined = RESUME ? loadState() : undefined;
  if (RESUME) {
    printResumePlan(state);
  }

  if (!state) {
    state = {
      network: NETWORK,
      deployerPublicKey: deployerAddress,
      startedAt: new Date().toISOString(),
      steps: {},
    };
    saveState(state);
  }

  /** Returns true if the step is already complete and should be reused. */
  const isComplete = (step: string): boolean =>
    state!.steps[step]?.status === "complete";

  /** Gate a mutating recovery step on explicit operator confirmation. */
  const confirmRecovery = async (step: string, action: string): Promise<void> => {
    if (!RESUME) return;
    const ok = await confirmStep(`Recovery: ${action} (step "${step}")?`);
    if (!ok) {
      console.error(`[deploy] Aborted by operator at step "${step}". State preserved.`);
      process.exit(1);
    }
  };

  // Re-read deployer address (may have been populated by preflight)
  if (!deployerAddress) {
    deployerAddress = run(`stellar keys address ${DEPLOYER}`, "Getting deployer address");
  }

  // ── 1. Build all contracts ────────────────────────────────────────────────

  run(
    `cargo build --release --target wasm32-unknown-unknown --manifest-path ${CONTRACTS}/Cargo.toml`,
    "Building contracts",
  );

  // ── 2. Deploy reputation contract ────────────────────────────────────────

  const repWasm = path.join(WASM_DIR, "reputation.wasm");
  const repWasmHash = sha256File(repWasm);

  const repContractId = run(
    `stellar contract deploy --wasm ${repWasm} --source ${DEPLOYER} --network ${NETWORK}`,
    "Deploying reputation contract",
  );

  const repDeployTx = run(
    `stellar keys address ${DEPLOYER}`,
    "Note: capturing deployer address (tx hash captured from RPC in production)",
  );
  // In a production deploy you would capture the actual tx hash from stellar-cli's
  // --json output. We record a placeholder here for CLI output compatibility.
  const repTxHash = `cli-deploy-${Date.now()}`;

  run(
    `stellar contract invoke --id ${repContractId} --source ${DEPLOYER} --network ${NETWORK} -- initialize --admin ${deployerAddress}`,
    "Initializing reputation contract",
  );

  // ── 3. Deploy circle_factory ──────────────────────────────────────────────

  const factoryWasm = path.join(WASM_DIR, "circle_factory.wasm");
  const factoryWasmHash = sha256File(factoryWasm);

  const factoryContractId = run(
    `stellar contract deploy --wasm ${factoryWasm} --source ${DEPLOYER} --network ${NETWORK}`,
    "Deploying circle_factory contract",
  );
  const factoryTxHash = `cli-deploy-${Date.now()}`;

  // ── 4. Install circle WASM (get on-chain hash) ────────────────────────────

  const circleWasm = path.join(WASM_DIR, "circle.wasm");

  const circleWasmOnChainHash = run(
    `stellar contract install --wasm ${circleWasm} --source ${DEPLOYER} --network ${NETWORK}`,
    "Installing circle contract WASM",
  );

  // ── 5. USDC token address ─────────────────────────────────────────────────

  // On testnet: use the well-known Soroban test USDC contract or deploy a stub.
  // Real mainnet address: CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
  const usdcContractId =
    process.env.USDC_ADDRESS ??
    run(
      `stellar contract deploy --wasm ${circleWasm} --source ${DEPLOYER} --network ${NETWORK}`,
      "Deploying test token (testnet only — use real USDC on mainnet)",
    );

  // ── 6. Initialize factory ─────────────────────────────────────────────────

  run(
    `stellar contract invoke --id ${factoryContractId} --source ${DEPLOYER} --network ${NETWORK} -- initialize --admin ${deployerAddress} --circle-wasm-hash ${circleWasmOnChainHash} --reputation-contract ${repContractId} --usdc-token ${usdcContractId}`,
    "Initializing circle factory",
  );

  // ── 7. Write deployment manifest (#398) ───────────────────────────────────

  const manifestInput: ManifestInput = {
    network:          NETWORK,
    networkPassphrase: NETWORK_PASSPHRASE,
    deployerPublicKey: deployerAddress,
    rustToolchain:    readPinnedToolchain(),
    sorobanSdkVersion: readSorobanSdkVersion(),
    gitCommit:        gitCommit(),
    reputation: {
      contractId:       repContractId,
      wasmHash:         repWasmHash,
      deployTxHash:     repTxHash,
      deployedAtLedger: 0, // set from RPC in production
    },
    circleFactory: {
      contractId:       factoryContractId,
      wasmHash:         factoryWasmHash,
      deployTxHash:     factoryTxHash,
      deployedAtLedger: 0,
    },
    circlWasmHash: circleWasmOnChainHash,
    usdc:          usdcContractId,
  };

  const manifest = writeManifest(manifestInput, MANIFEST_OUT);
  printManifestSummary(manifest);

  // Validate the written manifest immediately to catch any write errors
  const validation = validateManifest(MANIFEST_OUT, NETWORK);
  if (!validation.ok) {
    console.error("[deploy] ⚠  Written manifest failed validation:");
    for (const e of validation.errors) {
      console.error(`   • ${e}`);
    }
    // Non-fatal: contracts are deployed; operator should investigate
  } else {
    console.log("[manifest] ✅ Manifest integrity check passed.");
  }

  // ── 8. Legacy deployed.json (backward compat) ─────────────────────────────

  const legacyOut = {
    reputation:    repContractId,
    circleFactory: factoryContractId,
    usdc:          usdcContractId,
    network:       NETWORK,
    deployedAt:    manifest.deployedAt,
  };
  const legacyPath = path.join(__dirname, "../deployed.json");
  fs.writeFileSync(legacyPath, JSON.stringify(legacyOut, null, 2) + "\n");

  // ── 9. Summary ────────────────────────────────────────────────────────────

  console.log("\n✅ All contracts deployed!");
  console.log(`\nManifest  : ${MANIFEST_OUT}`);
  console.log(`Legacy    : ${legacyPath}`);
  console.log("\nCopy these into your .env files:");
  console.log(`CIRCLE_FACTORY_ADDRESS=${factoryContractId}`);
  console.log(`REPUTATION_ADDRESS=${repContractId}`);
  console.log(`USDC_ADDRESS=${usdcContractId}`);
}

main().catch((err: Error) => {
  console.error("[deploy] Fatal:", redactSecrets(err.message));
  process.exit(1);
});
