import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeManifest } from "./deployment-manifest";

const manifestInput = {
  network: "testnet",
  deployerPublicKey: `G${"A".repeat(55)}`,
  rustToolchain: "1.81.0",
  sorobanSdkVersion: "21.7.7",
  reputation: {
    contractId: `C${"A".repeat(55)}`,
    wasmHash: "a".repeat(64),
    deployTxHash: "reputation-tx",
    deployedAtLedger: 1,
  },
  circleFactory: {
    contractId: `C${"B".repeat(55)}`,
    wasmHash: "b".repeat(64),
    deployTxHash: "factory-tx",
    deployedAtLedger: 2,
  },
  circlWasmHash: "c".repeat(64),
  usdc: `C${"D".repeat(55)}`,
};

test("writeManifest removes its temporary file when the atomic rename fails", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "circleup-manifest-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const outputPath = path.join(directory, "manifest.json");
  fs.mkdirSync(outputPath);

  assert.throws(() => writeManifest(manifestInput, outputPath));
  assert.deepEqual(fs.readdirSync(directory), ["manifest.json"]);
});

test("writeManifest writes a complete manifest atomically", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "circleup-manifest-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const outputPath = path.join(directory, "manifest.json");
  const manifest = writeManifest(manifestInput, outputPath);

  assert.equal(JSON.parse(fs.readFileSync(outputPath, "utf8")).integrityHash, manifest.integrityHash);
  assert.deepEqual(fs.readdirSync(directory), ["manifest.json"]);
});

test("writeManifest rejects malformed artifact hashes before writing", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "circleup-manifest-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const outputPath = path.join(directory, "manifest.json");
  const invalidInput = {
    ...manifestInput,
    reputation: { ...manifestInput.reputation, wasmHash: "not-a-sha256" },
  };

  assert.throws(() => writeManifest(invalidInput, outputPath), /Invalid SHA-256 hash/);
  assert.deepEqual(fs.readdirSync(directory), []);
});