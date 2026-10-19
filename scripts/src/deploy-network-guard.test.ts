import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(__dirname, "..", "..");

function runDeploy(args: string[]) {
  return spawnSync(process.execPath, [
    "--require",
    "ts-node/register",
    path.join(ROOT, "scripts", "src", "deploy.ts"),
    ...args,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      TS_NODE_COMPILER_OPTIONS: '{"module":"CommonJS"}',
      NETWORK: "testnet",
      DEPLOYER_IDENTITY: "test-deployer",
      STELLAR_RPC_URL: "https://rpc-secret-marker.example",
      ADMIN_SECRET_KEY: "secret-marker",
    },
  });
}

for (const network of ["mainnet", "preview"]) {
  test(`deploy CLI rejects ${network} before any write, including skip-preflight`, () => {
    const result = runDeploy(["--network", network, "--skip-preflight"]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /testnet-only/i);
    assert.equal(output.includes("secret-marker"), false);
    assert.equal(output.includes("rpc-secret-marker"), false);
  });
}