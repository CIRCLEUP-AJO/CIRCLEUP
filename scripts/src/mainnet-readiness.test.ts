import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StrKey } from "@stellar/stellar-sdk";
import { writeManifest } from "./deployment-manifest";
import { evaluateMainnetContext } from "./mainnet-readiness";

const MAINNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

test("mainnet readiness requires explicit network intent", () => {
  const result = evaluateMainnetContext({
    confirmMainnet: false,
    env: {},
  });

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.checks.filter((check) => !check.ok).map((check) => check.name),
    [
      "explicit-mainnet-network",
      "explicit-mainnet-confirmation",
      "production-profile",
      "mainnet-rpc",
      "mainnet-horizon",
      "mainnet-passphrase",
      "contract-addresses",
      "mainnet-usdc-identity",
      "admin-custody-context",
      "release-artifact-hashes",
      "mainnet-manifest-and-identities",
    ],
  );
});

test("unknown networks cannot inherit mainnet or testnet readiness", () => {
  const result = evaluateMainnetContext({
    network: "preview",
    confirmMainnet: true,
    env: {
      CIRCLEUP_PROFILE: "production",
      STELLAR_RPC_URL: "https://soroban-rpc.stellar.org",
      NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.find((check) => check.name === "explicit-mainnet-network")?.ok, false);
});

test("readiness results never contain environment values", () => {
  const secret = "do-not-print-this-secret";
  const result = evaluateMainnetContext({
    network: "testnet",
    confirmMainnet: false,
    env: { ADMIN_SECRET_KEY: secret, STELLAR_RPC_URL: `https://${secret}.example` },
  });

  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("complete mainnet context passes with matching manifest and release artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "circleup-mainnet-readiness-"));
  try {
    const wasmDir = path.join(root, "contracts", "target", "wasm32-unknown-unknown", "release");
    fs.mkdirSync(wasmDir, { recursive: true });
    const artifactNames = ["reputation.wasm", "circle_factory.wasm", "circle.wasm"];
    const artifactHashes: Record<string, string> = {};
    for (const name of artifactNames) {
      const bytes = Buffer.from(`${name}-release-fixture`);
      fs.writeFileSync(path.join(wasmDir, name), bytes);
      artifactHashes[name] = crypto.createHash("sha256").update(bytes).digest("hex");
    }
    fs.mkdirSync(path.join(root, "contracts"), { recursive: true });
    fs.writeFileSync(path.join(root, "contracts", "rust-toolchain.toml"), '[toolchain]\nchannel = "1.81.0"\n');
    fs.writeFileSync(path.join(root, "contracts", "expected-hashes.json"), JSON.stringify({
      toolchain: "1.81.0",
      target: "wasm32-unknown-unknown",
      profile: "release",
      artifacts: artifactHashes,
    }));

    const reputation = StrKey.encodeContract(Buffer.alloc(32, 1));
    const circleFactory = StrKey.encodeContract(Buffer.alloc(32, 2));
    const admin = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
    writeManifest({
      network: "mainnet",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      deployerPublicKey: admin,
      rustToolchain: "1.81.0",
      sorobanSdkVersion: "21.7.7",
      reputation: {
        contractId: reputation,
        wasmHash: "d".repeat(64),
        deployTxHash: "reputation-tx",
        deployedAtLedger: 10,
      },
      circleFactory: {
        contractId: circleFactory,
        wasmHash: "e".repeat(64),
        deployTxHash: "factory-tx",
        deployedAtLedger: 11,
      },
      circlWasmHash: "f".repeat(64),
      usdc: MAINNET_USDC,
    }, path.join(root, "scripts", "deployed-manifest.json"));

    const options = {
      root,
      network: "mainnet",
      confirmMainnet: true,
      env: {
        CIRCLEUP_PROFILE: "production",
        STELLAR_RPC_URL: "https://soroban-rpc.stellar.org",
        HORIZON_URL: "https://horizon.stellar.org",
        NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
        CIRCLE_FACTORY_ADDRESS: circleFactory,
        REPUTATION_ADDRESS: reputation,
        USDC_ADDRESS: MAINNET_USDC,
        ADMIN_PUBLIC_KEY: admin,
        ADMIN_IDENTITY: "release-admin",
      },
    };
    const result = evaluateMainnetContext(options);

    assert.equal(result.ready, true);
    assert.equal(result.checks.every((check) => check.ok), true);

    fs.writeFileSync(path.join(wasmDir, "circle.wasm"), "modified artifact");
    const tamperedArtifacts = evaluateMainnetContext(options);
    assert.equal(tamperedArtifacts.ready, false);
    assert.equal(tamperedArtifacts.checks.find((check) => check.name === "release-artifact-hashes")?.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});