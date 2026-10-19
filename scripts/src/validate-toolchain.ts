#!/usr/bin/env ts-node
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const EXPECTED_RUST = "1.81.0";
const EXPECTED_SOROBAN_SDK = "21.7.7";

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
  if (!rust.includes(` ${EXPECTED_RUST} `)) {
    console.error(`[toolchain] FAIL Rust: expected ${EXPECTED_RUST}, found ${rust}.`);
    failed = true;
  } else {
    console.log(`[toolchain] PASS Rust ${EXPECTED_RUST}`);
  }

  const rustToolchain = fs.readFileSync(path.join(ROOT, "contracts", "rust-toolchain.toml"), "utf8");
  if (!new RegExp(`channel\\s*=\\s*"${EXPECTED_RUST.replace(/\./g, "\\.")}"`).test(rustToolchain)) {
    console.error(`[toolchain] FAIL contracts/rust-toolchain.toml must pin Rust ${EXPECTED_RUST}.`);
    failed = true;
  }

  const cargo = runVersion("cargo", ["--version"]);
  if (cargo === "unavailable") {
    console.error("[toolchain] FAIL Cargo is unavailable. Install the pinned Rust toolchain with rustup.");
    failed = true;
  } else {
    console.log(`[toolchain] PASS ${cargo}`);
  }

  const targetOutput = runVersion("rustup", ["target", "list", "--installed"]);
  if (!targetOutput.split(/\r?\n/).includes("wasm32-unknown-unknown")) {
    console.error("[toolchain] FAIL wasm32-unknown-unknown is not installed. Run: rustup target add wasm32-unknown-unknown");
    failed = true;
  } else {
    console.log("[toolchain] PASS wasm32-unknown-unknown target");
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
  console.log(`[toolchain] Supported tuples: Node.js 18/npm 9, Node.js 22/npm 10, Node.js 24/npm 11; Rust ${EXPECTED_RUST}, Soroban SDK ${EXPECTED_SOROBAN_SDK}, wasm32-unknown-unknown.`);
}

main();