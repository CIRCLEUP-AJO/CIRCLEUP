import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateManifest, writeManifest, type ManifestInput } from "./deployment-manifest";

const FIXTURES_DIR = path.join(import.meta.dirname, "..", "fixtures", "deployment-manifest");

function readFixture(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

function copyFixtureTo(name: string, directory: string): string {
  const manifestPath = path.join(directory, "manifest.json");
  fs.copyFileSync(path.join(FIXTURES_DIR, name), manifestPath);
  return manifestPath;
}

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

test("historical schema 1 fixture remains readable", () => {
  inTempDirectory((directory) => {
    const manifestPath = copyFixtureTo("v1-valid.json", directory);
    const result = validateManifest(manifestPath, "testnet");
    assert.equal(result.ok, true, result.errors.join("\n"));
  });
});

test("current schema 2 fixture validates", () => {
  inTempDirectory((directory) => {
    const manifestPath = copyFixtureTo("v2-valid.json", directory);
    const result = validateManifest(manifestPath, "testnet");
    assert.equal(result.ok, true, result.errors.join("\n"));
  });
});

test("rejects malformed nested contract fields with field-level errors", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = writeManifest(input, manifestPath) as unknown as Record<string, any>;
    delete manifest.contracts.reputation.contractId;
    manifest.contracts.circleFactory.wasmHash = 42;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = validateManifest(manifestPath);
    assert.equal(result.ok, false);
    const errors = result.errors.join("\n");
    assert.match(errors, /contracts\.reputation\.contractId/i);
    assert.match(errors, /contracts\.circleFactory\.wasmHash/i);
  });
});

test("rejects invalid addresses and hashes that are merely non-empty strings", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = writeManifest(input, manifestPath) as unknown as Record<string, any>;
    manifest.contracts.reputation.contractId = "not-a-contract";
    manifest.contracts.circleFactory.contractId = "C" + "Z".repeat(55);
    manifest.contracts.circlWasmHash = "xyz";
    manifest.contracts.usdc = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = validateManifest(manifestPath);
    assert.equal(result.ok, false);
    const errors = result.errors.join("\n");
    assert.match(errors, /contracts\.reputation\.contractId/i);
    assert.match(errors, /contracts\.circleFactory\.contractId/i);
    assert.match(errors, /contracts\.circlWasmHash/i);
    assert.match(errors, /contracts\.usdc/i);
  });
});

test("rejects a bad checksum with an integrity error", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = writeManifest(input, manifestPath) as unknown as Record<string, any>;
    manifest.integrityHash = "0".repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = validateManifest(manifestPath);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /integrity hash mismatch/i);
  });
});

test("rejects unsupported versions with a clear message", () => {
  inTempDirectory((directory) => {
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = writeManifest(input, manifestPath) as unknown as Record<string, any>;
    manifest.manifestVersion = "0";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = validateManifest(manifestPath);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /unsupported manifestVersion/i);
  });
});

test("partial deployment fixtures are never accepted as a complete manifest", () => {
  inTempDirectory((directory) => {
    const manifestPath = copyFixtureTo("v2-partial.json", directory);
    const result = validateManifest(manifestPath, "testnet");
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /incomplete|partial|missing/i);
  });
});

test("fixtures with malformed nested fields fail validation", () => {
  inTempDirectory((directory) => {
    const manifestPath = copyFixtureTo("v2-malformed-nested.json", directory);
    const result = validateManifest(manifestPath, "testnet");
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /contracts\./i);
  });
});