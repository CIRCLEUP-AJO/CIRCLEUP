import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateManifest, writeManifest, type ManifestInput } from "./deployment-manifest";

const input: ManifestInput = {
  network: "testnet",
  deployerPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  rustToolchain: "1.81.0",
  sorobanSdkVersion: "21.7.7",
  reputation: {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    wasmHash: "a".repeat(64),
    deployTxHash: "reputation-tx",
    deployedAtLedger: 10,
  },
  circleFactory: {
    contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    wasmHash: "b".repeat(64),
    deployTxHash: "factory-tx",
    deployedAtLedger: 11,
  },
  circlWasmHash: "c".repeat(64),
  usdc: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
};

function inTempDirectory(run: (directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "circleup-manifest-"));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function legacyChecksum(manifest: Record<string, any>): string {
  const payload = JSON.stringify({
    network: manifest.network,
    networkPassphrase: manifest.networkPassphrase,
    reputation: manifest.contracts.reputation.contractId,
    circleFactory: manifest.contracts.circleFactory.contractId,
    circlWasmHash: manifest.contracts.circlWasmHash,
    usdc: manifest.contracts.usdc,
    deployedAt: manifest.deployedAt,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

test("writes and validates the current full-content schema", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const written = writeManifest(input, manifestPath);
    assert.equal(written.manifestVersion, "2");
    assert.equal(validateManifest(manifestPath, "testnet").ok, true);
  });
});

test("accepts supported historical schema 1 manifests", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = writeManifest(input, manifestPath) as unknown as Record<string, any>;
    manifest.manifestVersion = "1";
    manifest.integrityHash = legacyChecksum(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.equal(validateManifest(manifestPath, "testnet").ok, true);
  });
});

test("rejects schema 2 changes outside the former checksum fields", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = writeManifest(input, manifestPath) as unknown as Record<string, any>;
    manifest.contracts.reputation.deployTxHash = "tampered-tx";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = validateManifest(manifestPath);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /integrity hash mismatch/i);
  });
});

test("rejects unknown schema versions and network names", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = writeManifest(input, manifestPath) as unknown as Record<string, any>;
    manifest.manifestVersion = "999";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.match(validateManifest(manifestPath).errors.join("\n"), /unsupported manifestVersion/i);

    assert.throws(() => writeManifest({ ...input, network: "preview" }, manifestPath), /unsupported network/i);
    assert.throws(() => writeManifest({ ...input, networkPassphrase: "wrong passphrase" }, manifestPath), /passphrase does not match/i);
    manifest.manifestVersion = "2";
    manifest.network = "preview";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.match(validateManifest(manifestPath).errors.join("\n"), /unsupported network/i);
  });
});

test("requires schema 2 fields to be explicitly versioned", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = writeManifest(input, manifestPath) as unknown as Record<string, any>;
    manifest.extraMetadata = "future format";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = validateManifest(manifestPath);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /unknown schema 2 field: manifest\.extraMetadata/i);
  });
});