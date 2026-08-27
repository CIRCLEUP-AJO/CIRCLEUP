/**
 * deployment-manifest.ts — Deployment manifest generation and validation (Issue #398)
 *
 * Records every contract ID, transaction hash, network, and build version
 * together in a single atomic manifest file.  A partial deployment cannot
 * produce a valid manifest; consumers can detect network mismatches before
 * use.
 *
 * Design decisions:
 *  - The manifest is written only after ALL contracts are successfully deployed.
 *  - Any missing required field causes writeManifest() to throw (atomic write).
 *  - Consumers call validateManifest() to guard against network mismatches
 *    or incomplete files before they read contract addresses.
 *  - The file is human-readable JSON so it can be diffed in git or reviewed
 *    in a PR without tooling.
 *  - Private keys and passphrases are NEVER included in the manifest.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

const MANIFEST_VERSION = "1";

const KNOWN_NETWORKS: Record<string, string> = {
  testnet:  "Test SDF Network ; September 2015",
  mainnet:  "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContractEntry {
  /** Bech32 contract address (C...) */
  contractId: string;
  /** SHA-256 of the WASM file used for this deployment */
  wasmHash: string;
  /** Transaction hash of the deploy transaction */
  deployTxHash: string;
  /** Ledger sequence number at which the contract was deployed */
  deployedAtLedger: number;
}

export interface DeploymentManifest {
  /** Schema version — bump when the shape changes */
  manifestVersion: string;
  /** Network name: "testnet" | "mainnet" | "futurenet" */
  network: string;
  /** Stellar network passphrase (for consumer validation — not a secret) */
  networkPassphrase: string;
  /** Build metadata */
  build: {
    /** Rust toolchain channel, e.g. "1.81.0" */
    rustToolchain: string;
    /** soroban-sdk version from Cargo.toml workspace dependencies */
    sorobanSdkVersion: string;
    /** Git commit SHA at time of deployment, if available */
    gitCommit?: string;
  };
  /** Deployer public key (NOT the secret key) */
  deployerPublicKey: string;
  /** Individual contract entries — ALL must be present for a valid manifest */
  contracts: {
    reputation:    ContractEntry;
    circleFactory: ContractEntry;
    circlWasmHash: string; // installed WASM hash (not a deployed contract ID)
    usdc:          string; // token contract ID (pre-existing, not deployed by us)
  };
  /** ISO 8601 timestamp when the manifest was written */
  deployedAt: string;
  /** SHA-256 of all contract IDs + network passphrase; used for integrity check */
  integrityHash: string;
}

/** Partial input collected during deployment before the manifest is finalised. */
export interface ManifestInput {
  network: string;
  networkPassphrase?: string;
  deployerPublicKey: string;
  rustToolchain: string;
  sorobanSdkVersion: string;
  gitCommit?: string;
  reputation: ContractEntry;
  circleFactory: ContractEntry;
  circlWasmHash: string;
  usdc: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute an integrity hash over the core fields so tampering is detectable. */
function computeIntegrityHash(manifest: Omit<DeploymentManifest, "integrityHash">): string {
  const payload = JSON.stringify({
    network:           manifest.network,
    networkPassphrase: manifest.networkPassphrase,
    reputation:        manifest.contracts.reputation.contractId,
    circleFactory:     manifest.contracts.circleFactory.contractId,
    circlWasmHash:     manifest.contracts.circlWasmHash,
    usdc:              manifest.contracts.usdc,
    deployedAt:        manifest.deployedAt,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/** Resolve the network passphrase from a short name, or return the value as-is
 *  when it's already a full passphrase.
 */
function resolvePassphrase(networkOrPassphrase: string): string {
  return KNOWN_NETWORKS[networkOrPassphrase] ?? networkOrPassphrase;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Build and atomically write the deployment manifest.
 *
 * Throws if any required field is missing — this is intentional so partial
 * deployments cannot produce a manifest that looks complete.
 */
export function writeManifest(input: ManifestInput, outputPath: string): DeploymentManifest {
  // Validate required fields — fail loudly before writing anything
  const required: Array<[string, unknown]> = [
    ["network",                        input.network],
    ["deployerPublicKey",              input.deployerPublicKey],
    ["rustToolchain",                  input.rustToolchain],
    ["sorobanSdkVersion",              input.sorobanSdkVersion],
    ["reputation.contractId",          input.reputation?.contractId],
    ["reputation.wasmHash",            input.reputation?.wasmHash],
    ["reputation.deployTxHash",        input.reputation?.deployTxHash],
    ["circleFactory.contractId",       input.circleFactory?.contractId],
    ["circleFactory.wasmHash",         input.circleFactory?.wasmHash],
    ["circleFactory.deployTxHash",     input.circleFactory?.deployTxHash],
    ["circlWasmHash",                  input.circlWasmHash],
    ["usdc",                           input.usdc],
  ];

  const missing = required
    .filter(([, v]) => !v || (typeof v === "string" && v.trim() === ""))
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `[manifest] Refusing to write incomplete manifest.\n` +
      `  Missing fields: ${missing.join(", ")}\n` +
      "  All contracts must be successfully deployed before the manifest is written.",
    );
  }

  const networkPassphrase =
    input.networkPassphrase ?? resolvePassphrase(input.network);

  const deployedAt = new Date().toISOString();

  const partial: Omit<DeploymentManifest, "integrityHash"> = {
    manifestVersion:  MANIFEST_VERSION,
    network:          input.network,
    networkPassphrase,
    build: {
      rustToolchain:     input.rustToolchain,
      sorobanSdkVersion: input.sorobanSdkVersion,
      gitCommit:         input.gitCommit,
    },
    deployerPublicKey: input.deployerPublicKey,
    contracts: {
      reputation:    input.reputation,
      circleFactory: input.circleFactory,
      circlWasmHash: input.circlWasmHash,
      usdc:          input.usdc,
    },
    deployedAt,
  };

  const manifest: DeploymentManifest = {
    ...partial,
    integrityHash: computeIntegrityHash(partial),
  };

  // Atomic write: write to a temp file first, then rename
  const dir    = path.dirname(outputPath);
  const tmpOut = path.join(dir, `.manifest-${Date.now()}.tmp.json`);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmpOut, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf-8" });
  fs.renameSync(tmpOut, outputPath);

  return manifest;
}

// ── Read & Validate ───────────────────────────────────────────────────────────

export interface ManifestValidationResult {
  ok: boolean;
  manifest?: DeploymentManifest;
  errors: string[];
}

/**
 * Read and validate a manifest file.
 *
 * Checks:
 *  1. File exists and is valid JSON.
 *  2. All required fields are present and non-empty.
 *  3. Integrity hash matches the stored fields.
 *  4. Network passphrase matches the declared network name (when known).
 *  5. If expectedNetwork is provided, the manifest's network matches.
 */
export function validateManifest(
  manifestPath: string,
  expectedNetwork?: string,
): ManifestValidationResult {
  const errors: string[] = [];

  // 1. Read
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      errors: [`Manifest file not found: ${manifestPath}`],
    };
  }

  let manifest: DeploymentManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as DeploymentManifest;
  } catch (e) {
    return {
      ok: false,
      errors: [`Failed to parse manifest JSON: ${(e as Error).message}`],
    };
  }

  // 2. Required fields
  const required: Array<[string, unknown]> = [
    ["manifestVersion",                manifest.manifestVersion],
    ["network",                        manifest.network],
    ["networkPassphrase",              manifest.networkPassphrase],
    ["deployerPublicKey",              manifest.deployerPublicKey],
    ["build.rustToolchain",            manifest.build?.rustToolchain],
    ["build.sorobanSdkVersion",        manifest.build?.sorobanSdkVersion],
    ["contracts.reputation.contractId",    manifest.contracts?.reputation?.contractId],
    ["contracts.reputation.wasmHash",      manifest.contracts?.reputation?.wasmHash],
    ["contracts.reputation.deployTxHash",  manifest.contracts?.reputation?.deployTxHash],
    ["contracts.circleFactory.contractId", manifest.contracts?.circleFactory?.contractId],
    ["contracts.circleFactory.wasmHash",   manifest.contracts?.circleFactory?.wasmHash],
    ["contracts.circleFactory.deployTxHash", manifest.contracts?.circleFactory?.deployTxHash],
    ["contracts.circlWasmHash",        manifest.contracts?.circlWasmHash],
    ["contracts.usdc",                 manifest.contracts?.usdc],
    ["deployedAt",                     manifest.deployedAt],
    ["integrityHash",                  manifest.integrityHash],
  ];

  for (const [field, value] of required) {
    if (!value || (typeof value === "string" && value.trim() === "")) {
      errors.push(`Missing or empty field: ${field}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, manifest, errors };
  }

  // 3. Integrity hash
  const { integrityHash, ...rest } = manifest;
  const expectedHash = computeIntegrityHash(rest as Omit<DeploymentManifest, "integrityHash">);
  if (integrityHash !== expectedHash) {
    errors.push(
      `Integrity hash mismatch — manifest may have been tampered with.\n` +
      `  stored  : ${integrityHash}\n` +
      `  expected: ${expectedHash}`,
    );
  }

  // 4. Network passphrase consistency
  const knownPassphrase = KNOWN_NETWORKS[manifest.network];
  if (knownPassphrase && manifest.networkPassphrase !== knownPassphrase) {
    errors.push(
      `Network passphrase mismatch for network "${manifest.network}".\n` +
      `  stored  : "${manifest.networkPassphrase}"\n` +
      `  expected: "${knownPassphrase}"`,
    );
  }

  // 5. Expected network guard
  if (expectedNetwork && manifest.network !== expectedNetwork) {
    errors.push(
      `Network mismatch: manifest is for "${manifest.network}" but caller expected "${expectedNetwork}".\n` +
      "  Do not use a testnet manifest against a mainnet deployment or vice-versa.",
    );
  }

  return {
    ok: errors.length === 0,
    manifest,
    errors,
  };
}

// ── CLI: print manifest summary ───────────────────────────────────────────────

export function printManifestSummary(manifest: DeploymentManifest): void {
  console.log("\n[manifest] Deployment manifest");
  console.log("─".repeat(50));
  console.log(`  Network          : ${manifest.network}`);
  console.log(`  Deployed at      : ${manifest.deployedAt}`);
  console.log(`  Rust toolchain   : ${manifest.build.rustToolchain}`);
  console.log(`  Soroban SDK      : ${manifest.build.sorobanSdkVersion}`);
  if (manifest.build.gitCommit) {
    console.log(`  Git commit       : ${manifest.build.gitCommit}`);
  }
  console.log(`  Deployer         : ${manifest.deployerPublicKey}`);
  console.log("");
  console.log(`  reputation       : ${manifest.contracts.reputation.contractId}`);
  console.log(`    wasm hash      : ${manifest.contracts.reputation.wasmHash}`);
  console.log(`    tx             : ${manifest.contracts.reputation.deployTxHash}`);
  console.log(`  circleFactory    : ${manifest.contracts.circleFactory.contractId}`);
  console.log(`    wasm hash      : ${manifest.contracts.circleFactory.wasmHash}`);
  console.log(`    tx             : ${manifest.contracts.circleFactory.deployTxHash}`);
  console.log(`  circle wasm hash : ${manifest.contracts.circlWasmHash}`);
  console.log(`  usdc             : ${manifest.contracts.usdc}`);
  console.log(`  integrity hash   : ${manifest.integrityHash}`);
  console.log("─".repeat(50));
}

// ── Standalone validation CLI ──────────────────────────────────────────────

if (require.main === module) {
  const manifestPath = process.argv[2] ?? path.join(__dirname, "../deployed-manifest.json");
  const expectedNetwork = process.argv[3];

  const result = validateManifest(manifestPath, expectedNetwork);
  if (result.ok && result.manifest) {
    console.log("✅ Manifest is valid.");
    printManifestSummary(result.manifest);
    process.exit(0);
  } else {
    console.error("❌ Manifest validation failed:");
    for (const e of result.errors) {
      console.error(`   • ${e}`);
    }
    process.exit(1);
  }
}
