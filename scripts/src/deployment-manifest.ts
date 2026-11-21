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

const MANIFEST_VERSION = "2";
const SUPPORTED_MANIFEST_VERSIONS = ["1", "2"] as const;

/**
 * Versions that may be used to author a NEW deployment manifest.
 * Older versions remain readable (see READ_ONLY_MANIFEST_VERSIONS) but are
 * never written again — a new deployment must use the current schema.
 */
const WRITABLE_MANIFEST_VERSIONS = ["2"] as const;

/**
 * Versions that are still accepted for inspection / read-only consumption.
 * They are validated against their own historical schema and checksum
 * algorithm, but must not be used to drive a new deployment.
 */
const READ_ONLY_MANIFEST_VERSIONS = ["1"] as const;

const KNOWN_NETWORKS: Record<string, string> = {
  testnet:  "Test SDF Network ; September 2015",
  mainnet:  "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

/** StrKey version bytes for the address types a manifest may reference. */
const STRKEY_VERSION_BYTES = {
  /** Contract address (C...) */
  contract: 0x10,
  /** Account public key (G...) */
  account: 0x30,
} as const;
=======

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
  manifestVersion: typeof SUPPORTED_MANIFEST_VERSIONS[number];
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

/**
 * Lifecycle state of a single deployment operation.  Persisted alongside the
 * manifest so an interrupted deployment can be diagnosed and resumed without
 * guessing (Issue #146).
 */
export type DeploymentOperationState =
  | "started"
  | "uploaded"
  | "deployed"
  | "initialized"
  | "complete";

export interface DeploymentOperationRecord {
  /** Logical step name, e.g. "reputation", "circleFactory", "circlWasm" */
  step: string;
  state: DeploymentOperationState;
  /** Transaction hash captured for the irreversible side effect, if any */
  txHash?: string;
  /** Contract ID / WASM hash produced by the step, if any */
  contractId?: string;
  wasmHash?: string;
  /** ISO 8601 timestamp of the last state transition */
  updatedAt: string;
  /** Human-readable note for the operator (e.g. failure reason) */
  note?: string;
}

/**
 * Persisted deployment-state record.  This is written incrementally as the
 * deploy script progresses and is deliberately a DIFFERENT shape from
 * DeploymentManifest: a partial state can never be mistaken for, or
 * serialized as, a complete manifest.
 */
export interface DeploymentStateRecord {
  /** Always "deployment-state" — discriminates this file from a manifest. */
  kind: "deployment-state";
  /** Schema version of the state record itself */
  stateVersion: "1";
  network: string;
  networkPassphrase: string;
  /** Overall status; only "complete" may be promoted to a manifest. */
  status: "in-progress" | "failed" | "complete";
  operations: DeploymentOperationRecord[];
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Schema 1 keeps its historical checksum; schema 2 covers every manifest field. */
function computeIntegrityHash(manifest: Omit<DeploymentManifest, "integrityHash">): string {
  const legacyPayload = JSON.stringify({
    network:           manifest.network,
    networkPassphrase: manifest.networkPassphrase,
    reputation:        manifest.contracts.reputation.contractId,
    circleFactory:     manifest.contracts.circleFactory.contractId,
    circlWasmHash:     manifest.contracts.circlWasmHash,
    usdc:              manifest.contracts.usdc,
    deployedAt:        manifest.deployedAt,
  });
  const payload = manifest.manifestVersion === "1" ? legacyPayload : canonicalJson(manifest);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/** Resolve the network passphrase from a short name, or return the value as-is
 *  when it's already a full passphrase.
 */
function resolvePassphrase(networkOrPassphrase: string): string {
  return KNOWN_NETWORKS[networkOrPassphrase] ?? networkOrPassphrase;
}

function isSha256Hash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isTransactionHash(value: string): boolean {
  // Stellar transaction hashes are 32-byte SHA-256 digests rendered as hex.
  return /^[a-f0-9]{64}$/i.test(value);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Validate a Stellar StrKey address (C... contract or G... account) including
 * its embedded CRC16-XModem checksum.  A merely non-empty string must never
 * pass this check.
 */
function isValidStrKey(value: string, expectedVersion: number): boolean {
  if (typeof value !== "string" || value.length < 8) return false;
  const decoded = base32Decode(value);
  if (!decoded || decoded.length < 3) return false;
  if (decoded[0] !== expectedVersion) return false;

  const payload = decoded.subarray(0, decoded.length - 2);
  const checksum = decoded.readUInt16LE(decoded.length - 2);

  let crc = 0x0000;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc === checksum;
}

function isContractAddress(value: string): boolean {
  return isValidStrKey(value, STRKEY_VERSION_BYTES.contract);
}

function isAccountAddress(value: string): boolean {
  return isValidStrKey(value, STRKEY_VERSION_BYTES.account);
}

// ── Per-version runtime schemas ───────────────────────────────────────────────

type FieldKind =
  | "string"
  | "nonEmptyString"
  | "sha256"
  | "txHash"
  | "contractAddress"
  | "accountAddress"
  | "nonNegativeInteger"
  | "isoTimestamp"
  | "object";

interface FieldSpec {
  /** Dotted path relative to the manifest root */
  path: string;
  kind: FieldKind;
  optional?: boolean;
}

interface VersionSchema {
  version: string;
  /** Fields required (or optionally present) for this version */
  fields: FieldSpec[];
  /** Top-level keys allowed; anything else is an unknown-field error */
  allowedTopLevel: string[];
  /** Nested object key allow-lists, keyed by dotted path */
  allowedNested: Record<string, string[]>;
}

const CONTRACT_ENTRY_FIELDS: FieldSpec[] = [
  { path: "contractId", kind: "contractAddress" },
  { path: "wasmHash", kind: "sha256" },
  { path: "deployTxHash", kind: "txHash" },
  { path: "deployedAtLedger", kind: "nonNegativeInteger" },
];

const SCHEMA_V2: VersionSchema = {
  version: "2",
  fields: [
    { path: "manifestVersion", kind: "nonEmptyString" },
    { path: "network", kind: "nonEmptyString" },
    { path: "networkPassphrase", kind: "nonEmptyString" },
    { path: "build", kind: "object" },
    { path: "build.rustToolchain", kind: "nonEmptyString" },
    { path: "build.sorobanSdkVersion", kind: "nonEmptyString" },
    { path: "build.gitCommit", kind: "string", optional: true },
    { path: "deployerPublicKey", kind: "accountAddress" },
    { path: "contracts", kind: "object" },
    ...CONTRACT_ENTRY_FIELDS.map((f) => ({ ...f, path: `contracts.reputation.${f.path}` })),
    ...CONTRACT_ENTRY_FIELDS.map((f) => ({ ...f, path: `contracts.circleFactory.${f.path}` })),
    { path: "contracts.circlWasmHash", kind: "sha256" },
    { path: "contracts.usdc", kind: "contractAddress" },
    { path: "deployedAt", kind: "isoTimestamp" },
    { path: "integrityHash", kind: "sha256" },
  ],
  allowedTopLevel: [
    "manifestVersion", "network", "networkPassphrase", "build", "deployerPublicKey",
    "contracts", "deployedAt", "integrityHash",
  ],
  allowedNested: {
    build: ["rustToolchain", "sorobanSdkVersion", "gitCommit"],
    contracts: ["reputation", "circleFactory", "circlWasmHash", "usdc"],
    "contracts.reputation": ["contractId", "wasmHash", "deployTxHash", "deployedAtLedger"],
    "contracts.circleFactory": ["contractId", "wasmHash", "deployTxHash", "deployedAtLedger"],
  },
};

/**
 * Schema 1 is the historical shape.  It is read-only: it is validated with the
 * same structural rules where the fields exist, but its checksum uses the
 * legacy payload (see computeIntegrityHash).
 */
const SCHEMA_V1: VersionSchema = {
  version: "1",
  fields: [
    { path: "manifestVersion", kind: "nonEmptyString" },
    { path: "network", kind: "nonEmptyString" },
    { path: "networkPassphrase", kind: "nonEmptyString" },
    { path: "build", kind: "object" },
    { path: "build.rustToolchain", kind: "nonEmptyString" },
    { path: "build.sorobanSdkVersion", kind: "nonEmptyString" },
    { path: "build.gitCommit", kind: "string", optional: true },
    { path: "deployerPublicKey", kind: "accountAddress" },
    { path: "contracts", kind: "object" },
    ...CONTRACT_ENTRY_FIELDS.map((f) => ({ ...f, path: `contracts.reputation.${f.path}` })),
    ...CONTRACT_ENTRY_FIELDS.map((f) => ({ ...f, path: `contracts.circleFactory.${f.path}` })),
    { path: "contracts.circlWasmHash", kind: "sha256" },
    { path: "contracts.usdc", kind: "contractAddress" },
    { path: "deployedAt", kind: "isoTimestamp" },
    { path: "integrityHash", kind: "sha256" },
  ],
  allowedTopLevel: [
    "manifestVersion", "network", "networkPassphrase", "build", "deployerPublicKey",
    "contracts", "deployedAt", "integrityHash",
  ],
  allowedNested: {
    build: ["rustToolchain", "sorobanSdkVersion", "gitCommit"],
    contracts: ["reputation", "circleFactory", "circlWasmHash", "usdc"],
    "contracts.reputation": ["contractId", "wasmHash", "deployTxHash", "deployedAtLedger"],
    "contracts.circleFactory": ["contractId", "wasmHash", "deployTxHash", "deployedAtLedger"],
  },
};

const VERSION_SCHEMAS: Record<string, VersionSchema> = {
  "1": SCHEMA_V1,
  "2": SCHEMA_V2,
};

function getPath(root: unknown, dotted: string): unknown {
  let current: unknown = root;
  for (const segment of dotted.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateFieldKind(kind: FieldKind, value: unknown): string | null {
  switch (kind) {
    case "string":
      return typeof value === "string" ? null : "expected a string";
    case "nonEmptyString":
      return typeof value === "string" && value.trim() !== ""
        ? null
        : "expected a non-empty string";
    case "sha256":
      return typeof value === "string" && isSha256Hash(value)
        ? null
        : "expected a 64-character hex SHA-256 hash";
    case "txHash":
      return typeof value === "string" && isTransactionHash(value)
        ? null
        : "expected a 64-character hex transaction hash";
    case "contractAddress":
      return typeof value === "string" && isContractAddress(value)
        ? null
        : "expected a valid Stellar contract address (C..., StrKey checksum verified)";
    case "accountAddress":
      return typeof value === "string" && isAccountAddress(value)
        ? null
        : "expected a valid Stellar account public key (G..., StrKey checksum verified)";
    case "nonNegativeInteger":
      return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? null
        : "expected a non-negative integer";
    case "isoTimestamp":
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? null
        : "expected an ISO 8601 timestamp";
    case "object":
      return value && typeof value === "object" && !Array.isArray(value)
        ? null
        : "expected an object";
    default:
      return "unknown field kind";
  }
}

/**
 * Validate a parsed manifest against the runtime schema for its declared
 * version.  Returns field-level error strings; an empty array means the
 * structure and semantics are valid (checksum is verified separately).
 */
function validateAgainstSchema(manifest: Record<string, unknown>, schema: VersionSchema): string[] {
  const errors: string[] = [];

  for (const field of schema.fields) {
    const value = getPath(manifest, field.path);
    if (value === undefined || value === null) {
      if (!field.optional) errors.push(`Missing required field: ${field.path}`);
      continue;
    }
    const problem = validateFieldKind(field.kind, value);
    if (problem) errors.push(`Invalid field ${field.path}: ${problem}`);
  }

  for (const key of Object.keys(manifest)) {
    if (!schema.allowedTopLevel.includes(key)) {
      errors.push(`Unknown schema ${schema.version} field: ${key}`);
    }
  }
  for (const [parentPath, allowed] of Object.entries(schema.allowedNested)) {
    const parent = getPath(manifest, parentPath);
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
    for (const key of Object.keys(parent as Record<string, unknown>)) {
      if (!allowed.includes(key)) {
        errors.push(`Unknown schema ${schema.version} field: ${parentPath}.${key}`);
      }
    }
  }

  return errors;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Build and atomically write the deployment manifest.
 *
 * Throws if any required field is missing — this is intentional so partial
 * deployments cannot produce a manifest that looks complete.
 */
export function writeManifest(input: ManifestInput, outputPath: string): DeploymentManifest {
  if (!Object.prototype.hasOwnProperty.call(KNOWN_NETWORKS, input.network)) {
    throw new Error(`[manifest] Unsupported network "${input.network}". Expected: ${Object.keys(KNOWN_NETWORKS).join(", ")}`);
  }

  if (!(WRITABLE_MANIFEST_VERSIONS as readonly string[]).includes(MANIFEST_VERSION)) {
    throw new Error(
      `[manifest] Refusing to write manifest version "${MANIFEST_VERSION}": ` +
      `only versions ${WRITABLE_MANIFEST_VERSIONS.join(", ")} may be used for new deployments.`,
    );
  }

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

  const hashes: Array<[string, string]> = [
    ["reputation.wasmHash", input.reputation.wasmHash],
    ["circleFactory.wasmHash", input.circleFactory.wasmHash],
    ["circlWasmHash", input.circlWasmHash],
  ];
  const invalidHashes = hashes.filter(([, value]) => !isSha256Hash(value)).map(([field]) => field);
  if (invalidHashes.length > 0) {
    throw new Error(`[manifest] Invalid SHA-256 hash: ${invalidHashes.join(", ")}`);
  }

  const txHashes: Array<[string, string]> = [
    ["reputation.deployTxHash", input.reputation.deployTxHash],
    ["circleFactory.deployTxHash", input.circleFactory.deployTxHash],
  ];
  const invalidTxHashes = txHashes.filter(([, value]) => !isTransactionHash(value)).map(([field]) => field);
  if (invalidTxHashes.length > 0) {
    throw new Error(`[manifest] Invalid transaction hash: ${invalidTxHashes.join(", ")}`);
  }

  const addresses: Array<[string, string, "contract" | "account"]> = [
    ["reputation.contractId", input.reputation.contractId, "contract"],
    ["circleFactory.contractId", input.circleFactory.contractId, "contract"],
    ["usdc", input.usdc, "contract"],
    ["deployerPublicKey", input.deployerPublicKey, "account"],
  ];
  const invalidAddresses = addresses
    .filter(([, value, kind]) => (kind === "contract" ? !isContractAddress(value) : !isAccountAddress(value)))
    .map(([field]) => field);
  if (invalidAddresses.length > 0) {
    throw new Error(`[manifest] Invalid Stellar address: ${invalidAddresses.join(", ")}`);
  }

  const networkPassphrase =
    input.networkPassphrase ?? resolvePassphrase(input.network);
  if (networkPassphrase !== KNOWN_NETWORKS[input.network]) {
    throw new Error(`[manifest] Network passphrase does not match the declared network "${input.network}".`);
  }

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
  try {
    fs.writeFileSync(tmpOut, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf-8" });
    fs.renameSync(tmpOut, outputPath);
  } finally {
    fs.rmSync(tmpOut, { force: true });
  }

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    return {
      ok: false,
      errors: [`Failed to parse manifest JSON: ${(e as Error).message}`],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["Manifest must be a JSON object."] };
  }
  const raw = parsed as Record<string, unknown>;

  // 2. Version gate — fail clearly on unsupported versions before anything else.
  const declaredVersion = raw.manifestVersion;
  if (typeof declaredVersion !== "string" || declaredVersion.trim() === "") {
    return {
      ok: false,
      errors: [
        `Missing or invalid manifestVersion (got ${JSON.stringify(declaredVersion)}). ` +
        `Supported versions: ${SUPPORTED_MANIFEST_VERSIONS.join(", ")}.`,
      ],
    };
  }
  const schema = VERSION_SCHEMAS[declaredVersion];
  if (!schema) {
    return {
      ok: false,
      errors: [
        `Unsupported manifestVersion "${declaredVersion}". ` +
        `Supported versions: ${SUPPORTED_MANIFEST_VERSIONS.join(", ")}. ` +
        `This manifest cannot be used; regenerate it with a supported version.`,
      ],
    };
  }

  // 3. Structural + semantic validation against the version's runtime schema.
  errors.push(...validateAgainstSchema(raw, schema));

  if (errors.length > 0) {
    return { ok: false, manifest: raw as unknown as DeploymentManifest, errors };
  }

  const manifest = raw as unknown as DeploymentManifest;

  // 4. Network name must be one we know.
  if (!Object.prototype.hasOwnProperty.call(KNOWN_NETWORKS, manifest.network)) {
    errors.push(`Unsupported network "${manifest.network}". Known networks: ${Object.keys(KNOWN_NETWORKS).join(", ")}.`);
  }

  // 5. Integrity hash
  const { integrityHash, ...rest } = manifest;
  const expectedHash = computeIntegrityHash(rest as Omit<DeploymentManifest, "integrityHash">);
  if (integrityHash !== expectedHash) {
    errors.push(
      `Integrity hash mismatch — manifest content is inconsistent with its stored checksum.\n` +
      `  stored  : ${integrityHash}\n` +
      `  expected: ${expectedHash}`,
    );
  }

  // 6. Network passphrase consistency
  const knownPassphrase = KNOWN_NETWORKS[manifest.network];
  if (knownPassphrase && manifest.networkPassphrase !== knownPassphrase) {
    errors.push(
      `Network passphrase mismatch for network "${manifest.network}".\n` +
      `  stored  : "${manifest.networkPassphrase}"\n` +
      `  expected: "${knownPassphrase}"`,
    );
  }

  // 7. Expected network guard
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

/**
 * Validate a manifest for use in a NEW deployment.  Historical (read-only)
 * versions are refused with an actionable message so an old manifest is never
 * silently reused to drive a fresh deployment.
 */
export function validateManifestForNewDeployment(
  manifestPath: string,
  expectedNetwork?: string,
): ManifestValidationResult {
  const result = validateManifest(manifestPath, expectedNetwork);
  if (!result.ok) return result;

  const version = result.manifest?.manifestVersion;
  if (version && (READ_ONLY_MANIFEST_VERSIONS as readonly string[]).includes(version)) {
    return {
      ok: false,
      manifest: result.manifest,
      errors: [
        `Manifest version "${version}" is read-only and cannot be used for a new deployment. ` +
        `Re-run the deploy script to produce a version ${MANIFEST_VERSION} manifest.`,
      ],
    };
  }
  return result;
}

// ── Deployment state (Issue #146) ─────────────────────────────────────────────

/**
 * Persist an in-progress deployment state record.  This is intentionally a
 * separate file from the manifest: a partial state can never be serialized as
 * a complete manifest, and only a "complete" state may be promoted.
 */
export function writeDeploymentState(state: DeploymentStateRecord, outputPath: string): void {
  if (state.kind !== "deployment-state") {
    throw new Error(`[deployment-state] Refusing to write record with kind "${state.kind}".`);
  }
  if (state.status === "complete") {
    const incomplete = state.operations.filter((op) => op.state !== "complete");
    if (incomplete.length > 0) {
      throw new Error(
        `[deployment-state] Refusing to mark state complete: operations not complete: ` +
        incomplete.map((op) => `${op.step}(${op.state})`).join(", "),
      );
    }
  }
  const dir = path.dirname(outputPath);
  const tmpOut = path.join(dir, `.deployment-state-${Date.now()}.tmp.json`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpOut, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8" });
    fs.renameSync(tmpOut, outputPath);
  } finally {
    fs.rmSync(tmpOut, { force: true });
  }
}

/** Read a persisted deployment state record, or null if none exists. */
export function readDeploymentState(statePath: string): DeploymentStateRecord | null {
  if (!fs.existsSync(statePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[deployment-state] State file is not a JSON object: ${statePath}`);
  }
  const record = parsed as DeploymentStateRecord;
  if (record.kind !== "deployment-state") {
    throw new Error(
      `[deployment-state] File ${statePath} is not a deployment-state record (kind="${String((record as { kind?: unknown }).kind)}").`,
    );
  }
  return record;
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
  // `--for-new-deployment` refuses read-only historical versions.
  const forNewDeployment = process.argv.includes("--for-new-deployment");

  const result = forNewDeployment
    ? validateManifestForNewDeployment(manifestPath, expectedNetwork)
    : validateManifest(manifestPath, expectedNetwork);
  if (result.ok && result.manifest) {
    console.log("✅ Manifest is valid.");
    if ((READ_ONLY_MANIFEST_VERSIONS as readonly string[]).includes(result.manifest.manifestVersion)) {
      console.log(`ℹ️  Manifest version "${result.manifest.manifestVersion}" is read-only (inspection only).`);
    }
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
