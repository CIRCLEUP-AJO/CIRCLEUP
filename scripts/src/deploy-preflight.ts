/**
 * deploy-preflight.ts — Validate deployment configuration against selected contract network (Issue #895 / Issue 59)
 *
 * Requirements:
 * - Resolve selected network without silently substituting testnet defaults for production.
 * - Ensure contract IDs, RPC URL, network passphrase, token address, deployer key,
 *   and deployment manifest describe one coherent network.
 * - Validate contract address types (StrKey.isValidContract) and deployer key (StrKey.isValidEd25519PublicKey).
 * - Validate manifest consistency against expected network and contract IDs.
 * - Report which values are configured versus independently verified.
 * - Time-bounded (default 5000ms) live network RPC checks.
 * - Report unavailable remote checks separately from verified matches and mismatches.
 * - No fallback changes the requested network.
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { StrKey, rpc as StellarRpc } from "@stellar/stellar-sdk";

import { validateManifest, type DeploymentManifest } from "./deployment-manifest";
import {
  checkTokenAssumptions,
  type TokenAssumptionReport,
  type TokenCheckStatus,
} from "./check-token-assumptions";

// ── Types ─────────────────────────────────────────────────────────────────────

export type NetworkName = "testnet" | "mainnet" | "futurenet" | "standalone" | "custom";
export type RemoteCheckStatus = "verified" | "unavailable" | "mismatch" | "skipped";

export interface PreflightConfigInput {
  network?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  deployerPublicKey?: string;
  contractAddresses?: {
    circleFactory?: string;
    reputation?: string;
    usdc?: string;
    [key: string]: string | undefined;
  };
  manifestPath?: string;
  strict?: boolean;
  timeoutMs?: number;
  rpcClient?: {
    getNetwork: () => Promise<{ passphrase: string; protocolVersion?: number | string }>;
    simulateTransaction?: (tx: any) => Promise<any>;
  };
}

export interface ConfiguredFacts {
  resolvedNetwork: string;
  rpcUrl: string;
  networkPassphrase: string;
  deployerPublicKey?: string;
  contractAddresses: Record<string, string>;
  manifestPath?: string;
}

export interface VerifiedFacts {
  addressTypesValid: boolean;
  passphraseFormatValid: boolean;
  manifestConsistencyVerified: boolean;
  remoteRpcStatus: RemoteCheckStatus;
  remoteRpcPassphrase?: string;
  remoteRpcProtocolVersion?: number;
  remoteRpcError?: string;
  tokenStatus?: TokenCheckStatus;
}

export interface PreflightReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  configuredFacts: ConfiguredFacts;
  verifiedFacts: VerifiedFacts;
  tokenReport?: TokenAssumptionReport;
  summary: string;
}

/**
 * A single intended contract operation surfaced by the preflight summary.
 * Purely descriptive — nothing here is executed by the preflight.
 */
export interface IntendedOperation {
  /** Logical contract name, e.g. "circleFactory". */
  name: string;
  /** What the deploy script would do with this contract. */
  action: "upload" | "deploy" | "initialize" | "reuse" | "unknown";
  /** Existing address from config/manifest, if any. */
  address?: string;
  /** Local artifact path the operation would consume, if known. */
  artifactPath?: string;
  /** Whether the local artifact exists (undefined when not checked). */
  artifactPresent?: boolean;
}

/**
 * Result of the no-write dry-run path. Extends the standard report with a
 * human-readable target-network/operations summary and an explicit guarantee
 * flag that no signing material was requested.
 */
export interface DryRunReport extends PreflightReport {
  /** Always true — the dry-run never constructs or signs a transaction. */
  readOnly: true;
  /** Target network and intended operations summary. */
  targetSummary: string;
  /** Intended contract operations, in deploy order. */
  intendedOperations: IntendedOperation[];
}

// ── Resume Plan Types (Issue #146) ────────────────────────────────────────────

export type DeploymentStage =
  | "started"
  | "uploaded"
  | "deployed"
  | "initialized"
  | "complete";

export type ResumeDecision = "reuse" | "redeploy" | "resume" | "blocked";

export interface ResumePlanEntry {
  name: string;
  /** Last recorded stage from persisted state, if any. */
  recordedStage?: DeploymentStage;
  /** Captured transaction hash for the recorded stage, if any. */
  transactionHash?: string;
  /** Existing on-chain address from evidence, if any. */
  address?: string;
  /** What the resume plan recommends. */
  decision: ResumeDecision;
  /** Why the decision was reached. */
  reason: string;
}

export interface ResumePlan {
  /** Always true — building a resume plan performs no writes. */
  readOnly: true;
  network: string;
  /** Path to the persisted deployment state file, if one was found. */
  statePath?: string;
  /** Whether a persisted state file was found and parsed. */
  statePresent: boolean;
  /** Whether a complete manifest was found. */
  manifestComplete: boolean;
  entries: ResumePlanEntry[];
  /** Problems that block a safe resume. */
  blockers: string[];
  /** Whether the operator must confirm before any mutating recovery step. */
  requiresConfirmation: boolean;
  summary: string;
}

/**
 * Persisted deployment state record. Written by the deploy script as it
 * progresses; read (never written) by the resume planner.
 */
export interface DeploymentStateRecord {
  network: string;
  contracts: Record<
    string,
    {
      stage: DeploymentStage;
      transactionHash?: string;
      address?: string;
      artifactHash?: string;
    }
  >;
}

export interface ResumePlanInput {
  network?: string;
  /** Explicit path to the persisted deployment state file. */
  statePath?: string;
  /** Explicit path to the deployment manifest. */
  manifestPath?: string;
  /** Contract names expected by the deploy script, in deploy order. */
  expectedContracts?: string[];
  env?: NodeJS.ProcessEnv;
}

// ── Canonical Constants ───────────────────────────────────────────────────────

export const CANONICAL_PASSPHRASES: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
};

export const CANONICAL_RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban.stellar.org",
};

const KNOWN_NETWORKS = ["testnet", "mainnet", "futurenet", "standalone"];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function resolveNetwork(inputNetwork?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (inputNetwork && inputNetwork.trim()) {
    return inputNetwork.trim();
  }
  if (env.NETWORK && env.NETWORK.trim()) {
    return env.NETWORK.trim();
  }
  if (env.CIRCLEUP_NETWORK && env.CIRCLEUP_NETWORK.trim()) {
    return env.CIRCLEUP_NETWORK.trim();
  }
  if (env.CIRCLEUP_PROFILE && env.CIRCLEUP_PROFILE.trim()) {
    const profile = env.CIRCLEUP_PROFILE.trim().toLowerCase();
    if (profile === "production") return "mainnet";
    if (profile === "staging" || profile === "testnet") return "testnet";
    return profile;
  }
  // Enforce no silent testnet default in production
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Network resolution error: No deployment network specified. " +
      "Silent testnet defaults are disabled in production. Set NETWORK explicitly."
    );
  }
  return "testnet";
}

/**
 * Execute a promise with a hard time limit.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationLabel: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operationLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

// ── Main Preflight Implementation ─────────────────────────────────────────────

export async function runDeployPreflight(
  input: PreflightConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<PreflightReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const timeoutMs = input.timeoutMs ?? 5000;
  const isStrict = input.strict ?? false;

  // 1. Resolve network
  let resolvedNetwork = "";
  try {
    resolvedNetwork = resolveNetwork(input.network, env);
  } catch (err: any) {
    errors.push(err.message);
    resolvedNetwork = "unresolved";
  }

  const isProduction =
    resolvedNetwork === "mainnet" ||
    env.NODE_ENV === "production" ||
    (env.CIRCLEUP_PROFILE && env.CIRCLEUP_PROFILE.toLowerCase() === "production");

  // 2. Resolve network passphrase
  let resolvedPassphrase = input.networkPassphrase ?? env.NETWORK_PASSPHRASE;
  if (!resolvedPassphrase) {
    if (isProduction && resolvedNetwork === "mainnet") {
      errors.push("NETWORK_PASSPHRASE is required for mainnet; testnet defaults are disabled.");
      resolvedPassphrase = "";
    } else if (CANONICAL_PASSPHRASES[resolvedNetwork]) {
      resolvedPassphrase = CANONICAL_PASSPHRASES[resolvedNetwork];
    } else {
      errors.push(`NETWORK_PASSPHRASE is missing and no canonical passphrase exists for "${resolvedNetwork}".`);
      resolvedPassphrase = "";
    }
  }

  // 3. Resolve RPC URL
  let resolvedRpcUrl = input.rpcUrl ?? env.STELLAR_RPC_URL ?? env.RPC_URL;
  if (!resolvedRpcUrl) {
    if (isProduction && resolvedNetwork === "mainnet") {
      errors.push("STELLAR_RPC_URL is required for mainnet; testnet defaults are disabled.");
      resolvedRpcUrl = "";
    } else if (CANONICAL_RPC_URLS[resolvedNetwork]) {
      resolvedRpcUrl = CANONICAL_RPC_URLS[resolvedNetwork];
    } else {
      errors.push(`STELLAR_RPC_URL is missing and no canonical RPC exists for "${resolvedNetwork}".`);
      resolvedRpcUrl = "";
    }
  }

  // 4. Coherent network cross-checks
  if (resolvedNetwork === "mainnet") {
    if (resolvedPassphrase && resolvedPassphrase === CANONICAL_PASSPHRASES.testnet) {
      errors.push("Passphrase mismatch: Target network is mainnet, but testnet passphrase was configured.");
    }
    if (resolvedRpcUrl && (resolvedRpcUrl.includes("testnet") || resolvedRpcUrl.includes("futurenet"))) {
      errors.push(`RPC URL mismatch: Target network is mainnet, but non-mainnet RPC (${resolvedRpcUrl}) was configured.`);
    }
  } else if (resolvedNetwork === "testnet") {
    if (resolvedPassphrase && resolvedPassphrase === CANONICAL_PASSPHRASES.mainnet) {
      errors.push("Passphrase mismatch: Target network is testnet, but mainnet passphrase was configured.");
    }
    if (resolvedRpcUrl && resolvedRpcUrl.includes("soroban.stellar.org") && !resolvedRpcUrl.includes("testnet")) {
      errors.push(`RPC URL mismatch: Target network is testnet, but mainnet RPC (${resolvedRpcUrl}) was configured.`);
    }
  }

  // 5. Validate address types
  let addressTypesValid = true;
  const deployerKey = input.deployerPublicKey ?? env.DEPLOYER_PUBLIC_KEY;
  if (deployerKey) {
    if (!StrKey.isValidEd25519PublicKey(deployerKey)) {
      errors.push(
        `Invalid deployer public key "${deployerKey}". Expected valid 56-character Ed25519 public key (G...).`
      );
      addressTypesValid = false;
    }
  }

  const contractAddresses: Record<string, string> = {};
  const rawContracts = {
    circleFactory: input.contractAddresses?.circleFactory ?? env.CIRCLE_FACTORY_ADDRESS,
    reputation: input.contractAddresses?.reputation ?? env.REPUTATION_ADDRESS,
    usdc: input.contractAddresses?.usdc ?? env.USDC_ADDRESS,
    ...(input.contractAddresses ?? {}),
  };

  for (const [name, addr] of Object.entries(rawContracts)) {
    if (addr && typeof addr === "string" && addr.trim() !== "") {
      contractAddresses[name] = addr.trim();
      if (!StrKey.isValidContract(addr.trim())) {
        errors.push(
          `Invalid contract address for ${name}: "${addr}". Expected valid 56-character contract ID (C...).`
        );
        addressTypesValid = false;
      }
    }
  }

  // 6. Manifest consistency verification
  let manifestConsistencyVerified = true;
  const manifestPath =
    input.manifestPath ??
    (fs.existsSync(path.join(__dirname, "../deployed-manifest.json"))
      ? path.join(__dirname, "../deployed-manifest.json")
      : undefined);

  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const manifestRaw = fs.readFileSync(manifestPath, "utf8");
      const manifest: DeploymentManifest = JSON.parse(manifestRaw);

      if (manifest.network !== resolvedNetwork) {
        errors.push(
          `Manifest network mismatch: manifest records network "${manifest.network}", but selected network is "${resolvedNetwork}".`
        );
        manifestConsistencyVerified = false;
      }

      if (manifest.networkPassphrase !== resolvedPassphrase) {
        errors.push(
          `Manifest passphrase mismatch: manifest records "${manifest.networkPassphrase}", but selected passphrase is "${resolvedPassphrase}".`
        );
        manifestConsistencyVerified = false;
      }

      const manifestValidation = validateManifest(manifestPath, resolvedNetwork);
      if (!manifestValidation.ok) {
        errors.push(`Manifest integrity check failed: ${manifestValidation.errors.join("; ")}`);
        manifestConsistencyVerified = false;
      }

      // Check contract address matching between config and manifest
      if (contractAddresses.usdc && manifest.contracts?.usdc && contractAddresses.usdc !== manifest.contracts.usdc) {
        errors.push(
          `USDC address mismatch: configured "${contractAddresses.usdc}", but manifest records "${manifest.contracts.usdc}".`
        );
        manifestConsistencyVerified = false;
      }
      if (
        contractAddresses.circleFactory &&
        manifest.contracts?.circleFactory?.contractId &&
        contractAddresses.circleFactory !== manifest.contracts.circleFactory.contractId
      ) {
        errors.push(
          `CircleFactory address mismatch: configured "${contractAddresses.circleFactory}", but manifest records "${manifest.contracts.circleFactory.contractId}".`
        );
        manifestConsistencyVerified = false;
      }
      if (
        contractAddresses.reputation &&
        manifest.contracts?.reputation?.contractId &&
        contractAddresses.reputation !== manifest.contracts.reputation.contractId
      ) {
        errors.push(
          `Reputation address mismatch: configured "${contractAddresses.reputation}", but manifest records "${manifest.contracts.reputation.contractId}".`
        );
        manifestConsistencyVerified = false;
      }
    } catch (err: any) {
      errors.push(`Failed to read/validate manifest at ${manifestPath}: ${err.message}`);
      manifestConsistencyVerified = false;
    }
  }

  // 7. Time-bounded live-network RPC check
  let remoteRpcStatus: RemoteCheckStatus = "skipped";
  let remoteRpcPassphrase: string | undefined;
  let remoteRpcProtocolVersion: number | undefined;
  let remoteRpcError: string | undefined;

  if (resolvedRpcUrl) {
    try {
      const rpcClient =
        input.rpcClient ??
        new StellarRpc.Server(resolvedRpcUrl, {
          allowHttp: resolvedRpcUrl.startsWith("http://"),
        });

      const networkDetails = await withTimeout(
        rpcClient.getNetwork(),
        timeoutMs,
        `RPC getNetwork (${resolvedRpcUrl})`
      );

      remoteRpcPassphrase = networkDetails.passphrase;
      remoteRpcProtocolVersion =
        networkDetails.protocolVersion !== undefined
          ? typeof networkDetails.protocolVersion === "number"
            ? networkDetails.protocolVersion
            : parseInt(String(networkDetails.protocolVersion), 10)
          : undefined;

      if (remoteRpcPassphrase === resolvedPassphrase) {
        remoteRpcStatus = "verified";
      } else {
        remoteRpcStatus = "mismatch";
        errors.push(
          `Remote RPC passphrase mismatch: Live RPC at ${resolvedRpcUrl} reported passphrase ` +
          `"${remoteRpcPassphrase}", but configuration expects "${resolvedPassphrase}".`
        );
      }
    } catch (err: any) {
      remoteRpcStatus = "unavailable";
      remoteRpcError = err.message ?? "Unknown RPC error";

      if (isStrict) {
        errors.push(
          `Strict preflight failed: Live RPC check to ${resolvedRpcUrl} was unavailable (${remoteRpcError}).`
        );
      } else {
        warnings.push(
          `Remote RPC check unavailable at ${resolvedRpcUrl} (${remoteRpcError}). ` +
          `Local configuration validated, but live on-chain connection could not be verified.`
        );
      }
    }
  }

  // 8. Executable USDC token assumption check (Issue #892)
  let tokenReport: TokenAssumptionReport | undefined;
  let tokenStatus: TokenCheckStatus | undefined;
  const usdcAddr = contractAddresses.usdc;

  if (usdcAddr) {
    tokenReport = await checkTokenAssumptions({
      tokenAddress: usdcAddr,
      network: resolvedNetwork,
      rpcUrl: resolvedRpcUrl,
      timeoutMs,
      rpcClient: input.rpcClient?.simulateTransaction ? { simulateTransaction: input.rpcClient.simulateTransaction } : undefined,
    });
    tokenStatus = tokenReport.status;

    if (tokenReport.status === "mismatch") {
      errors.push(...tokenReport.errors);
    } else if (tokenReport.status === "unavailable") {
      if (isStrict) {
        errors.push(`Strict preflight token check failed: ${tokenReport.summary}`);
      } else {
        warnings.push(`Token assumptions check unavailable: ${tokenReport.summary}`);
      }
    } else if (tokenReport.status === "unverifiable") {
      warnings.push(`Token assumptions unverifiable on-chain: ${tokenReport.summary}`);
    }
  }

  const ok = errors.length === 0;
  const summary = ok
    ? `Preflight passed for network "${resolvedNetwork}" (RPC: ${remoteRpcStatus}, token: ${
        tokenStatus ?? "unconfigured"
      }, manifest: ${manifestPath ? "verified" : "not present"}).`
    : `Preflight failed with ${errors.length} error(s) for network "${resolvedNetwork}".`;

  return {
    ok,
    errors,
    warnings,
    configuredFacts: {
      resolvedNetwork,
      rpcUrl: resolvedRpcUrl,
      networkPassphrase: resolvedPassphrase,
      deployerPublicKey: deployerKey,
      contractAddresses,
      manifestPath,
    },
    verifiedFacts: {
      addressTypesValid,
      passphraseFormatValid: resolvedPassphrase.length > 0,
      manifestConsistencyVerified,
      remoteRpcStatus,
      remoteRpcPassphrase,
      remoteRpcProtocolVersion,
      remoteRpcError,
      tokenStatus,
    },
    tokenReport,
    summary,
  };
}

// ── No-Write Dry Run (Issue #144) ─────────────────────────────────────────────

/**
 * Build a descriptive list of the operations the deploy script would perform.
 * This inspects local artifacts and configured addresses only; it never
 * contacts the network and never signs anything.
 */
export function describeIntendedOperations(
  report: PreflightReport,
  artifactDir?: string
): IntendedOperation[] {
  const ops: IntendedOperation[] = [];
  const contracts = report.configuredFacts.contractAddresses;

  for (const [name, address] of Object.entries(contracts)) {
    const artifactPath = artifactDir
      ? path.join(artifactDir, `${name}.wasm`)
      : undefined;
    const artifactPresent = artifactPath ? fs.existsSync(artifactPath) : undefined;

    ops.push({
      name,
      action: address ? "reuse" : "deploy",
      address,
      artifactPath,
      artifactPresent,
    });
  }

  return ops;
}

/**
 * No-write deployment preflight (Issue #144).
 *
 * Performs only local validation plus read-only RPC checks and returns an
 * aggregated report together with a target-network/operations summary.
 *
 * Guarantees:
 * - Never constructs, signs, or submits a transaction.
 * - Never reads or requests a deployer secret key or signature.
 * - Only the read-only `getNetwork` / `simulateTransaction` RPC calls are made.
 */
export async function runDeployDryRun(
  input: PreflightConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
  artifactDir?: string
): Promise<DryRunReport> {
  // The dry-run must never touch signing material. Strip any deployer secret
  // from the environment view passed to the preflight so it cannot be used.
  const sanitizedEnv: NodeJS.ProcessEnv = { ...env };
  delete sanitizedEnv.DEPLOYER_SECRET_KEY;
  delete sanitizedEnv.DEPLOYER_SECRET;
  delete sanitizedEnv.STELLAR_SECRET_KEY;

  const report = await runDeployPreflight(input, sanitizedEnv);

  const intendedOperations = describeIntendedOperations(report, artifactDir);

  const targetSummary = [
    `Target network: ${report.configuredFacts.resolvedNetwork}`,
    `RPC: ${report.configuredFacts.rpcUrl || "(unset)"}`,
    `Passphrase: ${report.configuredFacts.networkPassphrase || "(unset)"}`,
    `Deployer public key: ${report.configuredFacts.deployerPublicKey ?? "(unset)"}`,
    `Intended operations: ${
      intendedOperations.length === 0
        ? "(none configured)"
        : intendedOperations
            .map((op) => `${op.name}:${op.action}${op.address ? `(${op.address})` : ""}`)
            .join(", ")
    }`,
  ].join("\n");

  return {
    ...report,
    readOnly: true,
    targetSummary,
    intendedOperations,
  };
}

// ── Read-Only Resume Plan (Issue #146) ────────────────────────────────────────

const DEFAULT_STATE_FILENAME = "deployment-state.json";

function resolveStatePath(input: ResumePlanInput, env: NodeJS.ProcessEnv): string | undefined {
  if (input.statePath) return input.statePath;
  if (env.DEPLOYMENT_STATE_PATH) return env.DEPLOYMENT_STATE_PATH;
  const candidate = path.join(__dirname, "../", DEFAULT_STATE_FILENAME);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function resolveManifestPath(input: ResumePlanInput, env: NodeJS.ProcessEnv): string | undefined {
  if (input.manifestPath) return input.manifestPath;
  const candidate = path.join(__dirname, "../deployed-manifest.json");
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Build a read-only resume plan (Issue #146).
 *
 * Inspects persisted deployment state and existing evidence (manifest,
 * recorded transaction hashes, addresses) and decides, per contract, whether
 * to reuse, resume, redeploy, or block. It never mutates anything and never
 * infers that a partial deployment is safe solely because an address exists.
 */
export function buildResumePlan(input: ResumePlanInput = {}): ResumePlan {
  const env = input.env ?? process.env;
  const blockers: string[] = [];
  const entries: ResumePlanEntry[] = [];

  let network = "";
  try {
    network = resolveNetwork(input.network, env);
  } catch (err: any) {
    blockers.push(err.message);
    network = "unresolved";
  }

  const statePath = resolveStatePath(input, env);
  const manifestPath = resolveManifestPath(input, env);

  let state: DeploymentStateRecord | undefined;
  if (statePath) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8")) as DeploymentStateRecord;
      if (state.network && state.network !== network) {
        blockers.push(
          `Persisted state network "${state.network}" does not match selected network "${network}".`
        );
      }
    } catch (err: any) {
      blockers.push(`Failed to read deployment state at ${statePath}: ${err.message}`);
    }
  }

  let manifestComplete = false;
  if (manifestPath) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DeploymentManifest;
      const validation = validateManifest(manifestPath, network);
      manifestComplete = validation.ok;
      if (!validation.ok) {
        blockers.push(
          `Manifest at ${manifestPath} is incomplete or inconsistent: ${validation.errors.join("; ")}`
        );
      }
    } catch (err: any) {
      blockers.push(`Failed to read manifest at ${manifestPath}: ${err.message}`);
    }
  }

  const expected = input.expectedContracts ?? Object.keys(state?.contracts ?? {});
  for (const name of expected) {
    const record = state?.contracts?.[name];
    if (!record) {
      entries.push({
        name,
        decision: "redeploy",
        reason: "No persisted state for this contract; a fresh deploy is required.",
      });
      continue;
    }

    switch (record.stage) {
      case "complete":
        entries.push({
          name,
          recordedStage: record.stage,
          transactionHash: record.transactionHash,
          address: record.address,
          decision: "reuse",
          reason: "Recorded as complete with captured transaction evidence.",
        });
        break;
      case "initialized":
        entries.push({
          name,
          recordedStage: record.stage,
          transactionHash: record.transactionHash,
          address: record.address,
          decision: "resume",
          reason: "Initialized but not marked complete; resume finalization only.",
        });
        break;
      case "deployed":
        entries.push({
          name,
          recordedStage: record.stage,
          transactionHash: record.transactionHash,
          address: record.address,
          decision: "resume",
          reason: "Deployed but not initialized; resume initialization (no redeploy).",
        });
        break;
      case "uploaded":
        entries.push({
          name,
          recordedStage: record.stage,
          transactionHash: record.transactionHash,
          address: record.address,
          decision: "resume",
          reason: "WASM uploaded but not deployed; resume deployment.",
        });
        break;
      case "started":
      default:
        entries.push({
          name,
          recordedStage: record.stage,
          transactionHash: record.transactionHash,
          address: record.address,
          decision: "blocked",
          reason:
            "Operation started but no captured transaction hash; cannot confirm whether it landed. " +
            "Manual verification required before redeploying.",
        });
        blockers.push(
          `Contract "${name}" is in stage "${record.stage}" without a captured transaction hash; ` +
          `refusing to infer safety from an address alone.`
        );
        break;
    }
  }

  const requiresConfirmation = entries.some((e) => e.decision !== "reuse");
  const ok = blockers.length === 0;
  const summary = ok
    ? `Resume plan for network "${network}": ${entries.length} contract(s) analyzed, ` +
      `${entries.filter((e) => e.decision === "reuse").length} reusable, ` +
      `${entries.filter((e) => e.decision === "resume").length} resumable, ` +
      `${entries.filter((e) => e.decision === "redeploy").length} to redeploy.`
    : `Resume plan blocked for network "${network}" with ${blockers.length} blocker(s).`;

  return {
    readOnly: true,
    network,
    statePath,
    statePresent: !!state,
    manifestComplete,
    entries,
    blockers,
    requiresConfirmation,
    summary,
  };
}

// ── CLI Runner ────────────────────────────────────────────────────────────────

if (require.main === module) {
  dotenv.config({ path: path.join(__dirname, "../.env") });

  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const networkArg = getArg("--network");
  const rpcArg = getArg("--rpc");
  const passphraseArg = getArg("--passphrase");
  const manifestArg = getArg("--manifest");
  const stateArg = getArg("--state");
  const artifactDirArg = getArg("--artifacts");
  const strictArg = args.includes("--strict");
  const jsonArg = args.includes("--json");
  const dryRunArg = args.includes("--dry-run");
  const resumeArg = args.includes("--resume-plan");

  if (resumeArg) {
    const plan = buildResumePlan({
      network: networkArg,
      statePath: stateArg,
      manifestPath: manifestArg,
    });
    if (jsonArg) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log("\n========================================================");
      console.log("         CIRCLEUP DEPLOYMENT RESUME PLAN (READ-ONLY)     ");
      console.log("========================================================\n");
      console.log(`[Target Network] : ${plan.network}`);
      console.log(`[State File]     : ${plan.statePath ?? "(none)"}`);
      console.log(`[Manifest]       : ${plan.manifestComplete ? "COMPLETE" : "INCOMPLETE/ABSENT"}`);
      console.log("\n--------------------------------------------------------");
      plan.entries.forEach((e) => {
        console.log(`  ${e.name}: ${e.decision.toUpperCase()} — ${e.reason}`);
      });
      if (plan.blockers.length > 0) {
        console.log("\nBLOCKERS:");
        plan.blockers.forEach((b) => console.log(`  ❌ ${b}`));
      }
      if (plan.requiresConfirmation) {
        console.log("\n⚠ Operator confirmation is required before any mutating recovery step.");
      }
      console.log("\nSUMMARY: " + plan.summary + "\n");
    }
    process.exit(plan.blockers.length === 0 ? 0 : 1);
  }

  const run = dryRunArg
    ? runDeployDryRun(
        {
          network: networkArg,
          rpcUrl: rpcArg,
          networkPassphrase: passphraseArg,
          manifestPath: manifestArg,
          strict: strictArg,
        },
        process.env,
        artifactDirArg
      )
    : runDeployPreflight({
        network: networkArg,
        rpcUrl: rpcArg,
        networkPassphrase: passphraseArg,
        manifestPath: manifestArg,
        strict: strictArg,
      });

  run
    .then((report) => {
      if (jsonArg) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log("\n========================================================");
        console.log(
          dryRunArg
            ? "     CIRCLEUP DEPLOYMENT DRY-RUN PREFLIGHT (READ-ONLY)   "
            : "       CIRCLEUP DEPLOYMENT CONFIGURATION PREFLIGHT       "
        );
        console.log("========================================================\n");
        console.log(`[Target Network] : ${report.configuredFacts.resolvedNetwork}`);
        console.log(`[Configured RPC] : ${report.configuredFacts.rpcUrl}`);
        console.log(`[Passphrase]     : ${report.configuredFacts.networkPassphrase}`);
        if (report.configuredFacts.deployerPublicKey) {
          console.log(`[Deployer Key]   : ${report.configuredFacts.deployerPublicKey}`);
        }
        console.log(`[Remote RPC]     : ${report.verifiedFacts.remoteRpcStatus.toUpperCase()}`);
        if (report.verifiedFacts.remoteRpcError) {
          console.log(`  └ Reason       : ${report.verifiedFacts.remoteRpcError}`);
        }
        console.log(`[Addresses Valid]: ${report.verifiedFacts.addressTypesValid ? "YES" : "NO"}`);
        console.log(`[Token Status]   : ${(report.verifiedFacts.tokenStatus ?? "SKIPPED").toUpperCase()}`);
        console.log(`[Manifest Valid] : ${report.verifiedFacts.manifestConsistencyVerified ? "YES" : "NO"}`);
        if ("targetSummary" in report) {
          const dry = report as DryRunReport;
          console.log("\n--------------------------------------------------------");
          console.log("TARGET & INTENDED OPERATIONS:");
          console.log(dry.targetSummary);
          console.log("\nNo transaction was constructed, signed, or submitted.");
        }
        console.log("\n--------------------------------------------------------");
        if (report.warnings.length > 0) {
          console.log("\nWARNINGS:");
          report.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
        }
        if (report.errors.length > 0) {
          console.log("\nERRORS:");
          report.errors.forEach((e) => console.log(`  ❌ ${e}`));
        }
        console.log("\nSUMMARY: " + report.summary + "\n");
      }
      process.exit(report.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("Fatal preflight error:", err);
      process.exit(1);
    });
}

