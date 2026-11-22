#!/usr/bin/env ts-node
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const TOOLCHAIN_PATH = path.join(ROOT, "contracts", "rust-toolchain.toml");
const EXPECTED_RUST = "1.81.0";
const EXPECTED_SOROBAN_SDK = "29.0.1";

interface ToolchainPin {
  channel: string;
  targets: string[];
  components: string[];
}

function parseTomlArray(value: string): string[] {
  const inner = value.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((entry) => entry.trim().replace(/^["']/, "").replace(/["']$/, ""))
    .filter((entry) => entry.length > 0);
}

function readToolchainPin(): ToolchainPin {
  const raw = fs.readFileSync(TOOLCHAIN_PATH, "utf8");
  const channelMatch = raw.match(/^\s*channel\s*=\s*"([^"]+)"/m);
  if (!channelMatch) {
    throw new Error(`contracts/rust-toolchain.toml must declare a channel, e.g. channel = "1.81.0".`);
  }
  const targetsMatch = raw.match(/^\s*targets\s*=\s*(\[[^\]]*\])/m);
  const componentsMatch = raw.match(/^\s*components\s*=\s*(\[[^\]]*\])/m);
  return {
    channel: channelMatch[1],
    targets: targetsMatch ? parseTomlArray(targetsMatch[1]) : [],
    components: componentsMatch ? parseTomlArray(componentsMatch[1]) : [],
  };
}

function runVersion(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      cwd: path.join(ROOT, "contracts"),
    }).trim();
  } catch {
    return "unavailable";
  }
}

function main(): void {
  let failed = false;

  let pin: ToolchainPin;
  try {
    pin = readToolchainPin();
    console.log(`[toolchain] Expected Rust ${pin.channel} (from contracts/rust-toolchain.toml)`);
    console.log(`[toolchain] Expected targets: ${pin.targets.length ? pin.targets.join(", ") : "(none declared)"}`);
    console.log(`[toolchain] Expected components: ${pin.components.length ? pin.components.join(", ") : "(none declared)"}`);
  } catch (error) {
    console.error(`[toolchain] FAIL ${(error as Error).message}`);
    process.exit(1);
  }

  try {
    const nodeCheck = execFileSync(process.execPath, [path.join(ROOT, "scripts", "check-node.cjs")], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    console.log(`[toolchain] PASS ${nodeCheck}`);
  } catch {
    console.error("[toolchain] FAIL Node.js/npm unsupported. Run npm run check:node for guidance.");
    failed = true;
  }

  const rust = runVersion("rustc", ["--version"]);
  const rustVersionMatch = rust.match(/^rustc\s+(\S+)/);
  const actualRust = rustVersionMatch ? rustVersionMatch[1] : rust;
  if (!rustVersionMatch || actualRust !== pin.channel) {
    console.error(
      `[toolchain] FAIL Rust version mismatch: expected ${pin.channel}, found ${actualRust}. ` +
        `Run: rustup toolchain install ${pin.channel} (or rustup override set ${pin.channel}).`,
    );
    failed = true;
  } else {
    console.log(`[toolchain] PASS Rust ${actualRust} (expected ${pin.channel})`);
  }

  const cargo = runVersion("cargo", ["--version"]);
  if (cargo === "unavailable") {
    console.error("[toolchain] FAIL Cargo is unavailable. Install the pinned Rust toolchain with rustup.");
    failed = true;
  } else {
    console.log(`[toolchain] PASS ${cargo}`);
  }

  const installedTargets = runVersion("rustup", ["target", "list", "--installed"]).split(/\r?\n/).filter(Boolean);
  const requiredTargets = pin.targets.length ? pin.targets : ["wasm32-unknown-unknown"];
  for (const target of requiredTargets) {
    if (!installedTargets.includes(target)) {
      console.error(`[toolchain] FAIL target ${target} is not installed. Run: rustup target add ${target}`);
      failed = true;
    } else {
      console.log(`[toolchain] PASS target ${target}`);
    }
  }

  const installedComponents = runVersion("rustup", ["component", "list", "--installed"]).split(/\r?\n/).filter(Boolean);
  for (const component of pin.components) {
    if (!installedComponents.includes(component)) {
      console.error(`[toolchain] FAIL component ${component} is not installed. Run: rustup component add ${component}`);
      failed = true;
    } else {
      console.log(`[toolchain] PASS component ${component}`);
    }
  }

  const workspaceCargo = fs.readFileSync(path.join(ROOT, "contracts", "Cargo.toml"), "utf8");
  const lock = fs.readFileSync(path.join(ROOT, "contracts", "Cargo.lock"), "utf8");
  const lockSdk = new RegExp(`name = "soroban-sdk"\\nversion = "${EXPECTED_SOROBAN_SDK.replace(/\./g, "\\.")}"`);
  if (!workspaceCargo.includes(`soroban-sdk = { version = "${EXPECTED_SOROBAN_SDK}"`) || !lockSdk.test(lock)) {
    console.error(`[toolchain] FAIL Soroban SDK must be ${EXPECTED_SOROBAN_SDK} in Cargo.toml and Cargo.lock.`);
    failed = true;
  } else {
    console.log(`[toolchain] PASS Soroban SDK ${EXPECTED_SOROBAN_SDK}`);
  }

  if (failed) process.exit(1);
  console.log(
    `[toolchain] Active versions: rustc ${actualRust}, ${cargo}, targets ${requiredTargets.join(", ")}; ` +
      `Soroban SDK ${EXPECTED_SOROBAN_SDK}.`,
  );
  console.log(
    `[toolchain] Supported tuples: Node.js 18/npm 9, Node.js 22/npm 10, Node.js 24/npm 11; ` +
      `Rust ${pin.channel}, Soroban SDK ${EXPECTED_SOROBAN_SDK}, targets ${requiredTargets.join(", ")}.`,
  );
}

main();