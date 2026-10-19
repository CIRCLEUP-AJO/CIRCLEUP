import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hasSufficientBalance } from "./funding-diagnostics";
import { redactSecrets } from "./redact";

test("deployment preflight fails offline before build or deployment commands", (t) => {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "circleup-empty-path-"));
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));

  const manifestPath = path.join(__dirname, "../deployed-manifest.json");
  const manifestExistedBefore = fs.existsSync(manifestPath);
  const result = spawnSync(
    process.execPath,
    ["--require", "ts-node/register", path.join(__dirname, "deploy.ts"), "--network", "unsupported"],
    {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPath, NETWORK_PASSPHRASE: "", STELLAR_RPC_URL: "" },
    },
  );

  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /Unknown network "unsupported"/);
  assert.match(output, /stellar-cli is not installed/);
  assert.doesNotMatch(output, /Building contracts|Deploying .* contract|stellar contract deploy/);
  assert.equal(fs.existsSync(manifestPath), manifestExistedBefore);
});

test("funding preflight treats missing and below-threshold balances as insufficient", () => {
  assert.equal(hasSufficientBalance(null, 10n), false);
  assert.equal(hasSufficientBalance(9n, 10n), false);
  assert.equal(hasSufficientBalance(10n, 10n), true);
});

test("deployment logs redact Stellar secret keys", () => {
  const secret = `S${"A".repeat(55)}`;
  assert.equal(redactSecrets(`stellar command failed for ${secret}`), "stellar command failed for [SECRET_REDACTED]");
});