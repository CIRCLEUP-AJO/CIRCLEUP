#!/usr/bin/env ts-node
/** Read-only mainnet release readiness gate. */

import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { SorobanRpc, StrKey } from "@stellar/stellar-sdk";
import { runFundingDiagnostics } from "./funding-diagnostics";
import { validateManifest } from "./deployment-manifest";

const ROOT = path.resolve(__dirname, "..", "..");
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const MAINNET_USDC_CONTRACT = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const ARTIFACTS = ["reputation.wasm", "circle_factory.wasm", "circle.wasm"];

interface Check {
  name: string;
  ok: boolean;
}

interface ReadinessOptions {
  network?: string;
  confirmMainnet: boolean;
  env: Record<string, string | undefined>;
  root?: string;
}

export interface ReadinessResult {
  ready: boolean;
  checks: Check[];
}

function addCheck(checks: Check[], name: string, ok: boolean): void {
  checks.push({ name, ok });
}

function isContractAddress(value: string | undefined): value is string {
  return !!value && StrKey.isValidContract(value);
}

export function evaluateMainnetContext(options: ReadinessOptions): ReadinessResult {
  const root = options.root ?? ROOT;
  const checks: Check[] = [];

  addCheck(checks, "explicit-mainnet-network", options.network === "mainnet");
  addCheck(checks, "explicit-mainnet-confirmation", options.confirmMainnet);
  addCheck(checks, "production-profile", options.env.CIRCLEUP_PROFILE === "production");

  const rpcUrl = options.env.STELLAR_RPC_URL;
  let rpcIsMainnet = false;
  try {
    const rpc = new URL(rpcUrl ?? "");
    rpcIsMainnet = rpc.protocol === "https:" && !/(testnet|futurenet)/i.test(rpc.hostname);
  } catch {
    rpcIsMainnet = false;
  }
  addCheck(checks, "mainnet-rpc", rpcIsMainnet);
  const horizonUrl = options.env.HORIZON_URL;
  let horizonIsMainnet = false;
  try {
    const horizon = new URL(horizonUrl ?? "");
    horizonIsMainnet = horizon.protocol === "https:" && !/(testnet|futurenet)/i.test(horizon.hostname);
  } catch {
    horizonIsMainnet = false;
  }
  addCheck(checks, "mainnet-horizon", horizonIsMainnet);
  addCheck(checks, "mainnet-passphrase", options.env.NETWORK_PASSPHRASE === MAINNET_PASSPHRASE);

  const addressKeys = ["CIRCLE_FACTORY_ADDRESS", "REPUTATION_ADDRESS", "USDC_ADDRESS"] as const;
  const addressesValid = addressKeys.every((key) => isContractAddress(options.env[key]));
  addCheck(checks, "contract-addresses", addressesValid);
  addCheck(checks, "mainnet-usdc-identity", options.env.USDC_ADDRESS === MAINNET_USDC_CONTRACT);
  const adminPublicKey = options.env.ADMIN_PUBLIC_KEY;
  const adminKeyValid = !!adminPublicKey && StrKey.isValidEd25519PublicKey(adminPublicKey);
  addCheck(checks, "admin-custody-context", adminKeyValid && !!options.env.ADMIN_IDENTITY);

  const manifestPath = path.join(root, "scripts", "deployed-manifest.json");
  const manifestResult = validateManifest(manifestPath, "mainnet");
  const manifest = manifestResult.manifest;
  let expected: {
    toolchain?: string;
    target?: string;
    profile?: string;
    artifacts?: Record<string, string>;
  } | undefined;
  let hashesMatch = false;
  try {
    const hashesPath = path.join(root, "contracts", "expected-hashes.json");
    const parsedExpected = JSON.parse(fs.readFileSync(hashesPath, "utf8")) as NonNullable<typeof expected>;
    expected = parsedExpected;
    const pinnedToolchain = fs.readFileSync(path.join(root, "contracts", "rust-toolchain.toml"), "utf8")
      .match(/channel\s*=\s*"([^"]+)"/)?.[1];
    const wasmDir = path.join(root, "contracts", "target", "wasm32-unknown-unknown", "release");
    hashesMatch = parsedExpected.toolchain === pinnedToolchain && parsedExpected.target === "wasm32-unknown-unknown" && parsedExpected.profile === "release" &&
      ARTIFACTS.every((name) => {
        const expectedHash = parsedExpected.artifacts?.[name];
        const artifactPath = path.join(wasmDir, name);
        if (!expectedHash || !fs.existsSync(artifactPath)) return false;
        const actualHash = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
        return actualHash === expectedHash;
      });
  } catch {
    hashesMatch = false;
  }
  addCheck(checks, "release-artifact-hashes", hashesMatch);

  const manifestMatches = manifestResult.ok && !!manifest && addressesValid &&
    manifest.contracts.circleFactory.contractId === options.env.CIRCLE_FACTORY_ADDRESS &&
    manifest.contracts.reputation.contractId === options.env.REPUTATION_ADDRESS &&
    manifest.contracts.usdc === options.env.USDC_ADDRESS &&
    manifest.deployerPublicKey === adminPublicKey;
  addCheck(checks, "mainnet-manifest-and-identities", manifestMatches);

  return { ready: checks.every((check) => check.ok), checks };
}

function loadEnvironment(): Record<string, string | undefined> {
  const profilesPath = path.join(ROOT, "profiles", "production.env");
  const localPath = path.join(__dirname, "..", ".env");
  const profile = fs.existsSync(profilesPath) ? dotenv.parse(fs.readFileSync(profilesPath)) : {};
  const local = fs.existsSync(localPath) ? dotenv.parse(fs.readFileSync(localPath)) : {};
  return { ...profile, ...local, ...process.env };
}

function parseArguments(argv: string[]): { network?: string; confirmMainnet: boolean; valid: boolean } {
  let network: string | undefined;
  let valid = true;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--network" && argv[index + 1]) {
      network = argv[++index];
    } else if (argv[index] !== "--confirm-mainnet") {
      valid = false;
    }
  }
  return { network, confirmMainnet: argv.includes("--confirm-mainnet"), valid };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const env = loadEnvironment();
  const result = evaluateMainnetContext({
    network: args.network,
    confirmMainnet: args.confirmMainnet,
    env,
  });
  if (!args.valid) {
    result.checks.push({ name: "recognized-options", ok: false });
    result.ready = false;
  }

  for (const check of result.checks) {
    console.log(`[mainnet-readiness] ${check.ok ? "PASS" : "FAIL"} ${check.name}`);
  }

  if (!result.ready) {
    console.error("Mainnet readiness failed. No transaction was submitted; configuration values were not printed.");
    process.exitCode = 1;
    return;
  }

  let rpcNetworkMatches = false;
  try {
    const rpc = new SorobanRpc.Server(env.STELLAR_RPC_URL!, { allowHttp: false });
    rpcNetworkMatches = (await rpc.getNetwork()).passphrase === MAINNET_PASSPHRASE;
  } catch {
    rpcNetworkMatches = false;
  }
  console.log(`[mainnet-readiness] ${rpcNetworkMatches ? "PASS" : "FAIL"} rpc-network-identity`);

  let adminIdentityMatches = false;
  try {
    const address = execFileSync("stellar", ["keys", "address", env.ADMIN_IDENTITY!], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    adminIdentityMatches = address === env.ADMIN_PUBLIC_KEY;
  } catch {
    adminIdentityMatches = false;
  }
  console.log(`[mainnet-readiness] ${adminIdentityMatches ? "PASS" : "FAIL"} local-admin-identity`);
  if (!rpcNetworkMatches || !adminIdentityMatches) {
    console.error("Mainnet readiness failed. The RPC network or local admin identity did not match; no transaction was submitted.");
    process.exitCode = 1;
    return;
  }

  let horizonNetworkMatches = false;
  try {
    const response = await fetch(env.HORIZON_URL!, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const root = await response.json() as { network_passphrase?: string };
      horizonNetworkMatches = root.network_passphrase === MAINNET_PASSPHRASE;
    }
  } catch {
    horizonNetworkMatches = false;
  }
  console.log(`[mainnet-readiness] ${horizonNetworkMatches ? "PASS" : "FAIL"} horizon-network-identity`);
  if (!horizonNetworkMatches) {
    console.error("Mainnet readiness failed. Horizon network identity could not be verified; no transaction was submitted.");
    process.exitCode = 1;
    return;
  }

  const funding = await runFundingDiagnostics({
    rpcUrl: env.STELLAR_RPC_URL!,
    horizonUrl: env.HORIZON_URL,
    deployerPublicKey: env.ADMIN_PUBLIC_KEY!,
    networkPassphrase: MAINNET_PASSPHRASE,
  });
  console.log(`[mainnet-readiness] ${funding.ok ? "PASS" : "FAIL"} mainnet-funding`);
  if (!funding.ok) {
    console.error("Mainnet funding could not be verified or is below the release threshold. No transaction was submitted.");
    process.exitCode = 1;
    return;
  }

  console.log("Mainnet release context is ready. This command is read-only and does not deploy contracts.");
}

if (require.main === module) {
  const args = parseArguments(process.argv.slice(2));
  if (!args.valid || args.network !== "mainnet" || !args.confirmMainnet) {
    console.error("Usage: mainnet-readiness --network mainnet --confirm-mainnet");
    process.exit(1);
  }
  main().catch(() => {
    console.error("Mainnet readiness failed while checking remote funding. No transaction was submitted.");
    process.exit(1);
  });
}