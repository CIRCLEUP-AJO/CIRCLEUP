/**
 * Deploy CircleUp contracts to Stellar Testnet.
 *
 * Prerequisites:
 *   - Rust + stellar-cli installed
 *   - `stellar keys generate --global deployer --network testnet` run once
 *   - contracts built: `cargo build --release --target wasm32-unknown-unknown`
 *
 * Usage:
 *   npx ts-node src/deploy.ts
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load scripts/.env
dotenv.config({ path: path.join(__dirname, "../.env") });

const NETWORK = "testnet";
const DEPLOYER = process.env.DEPLOYER_IDENTITY || "deployer";

interface DeployedAddresses {
  reputation: string;
  circleFactory: string;
  usdc: string;
  network: string;
  deployedAt: string;
}

function run(cmd: string, label: string): string {
  console.log(`\n[deploy] ${label}...`);
  console.log(`  > ${cmd}`);
  const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  console.log(`  ✅ ${result.trim()}`);
  return result.trim();
}

async function main() {
  const contractsDir = path.join(__dirname, "../../contracts");
  const wasmDir = path.join(contractsDir, "target/wasm32-unknown-unknown/release");

  // 1. Build all contracts
  run(
    `cargo build --release --target wasm32-unknown-unknown --manifest-path ${contractsDir}/Cargo.toml`,
    "Building contracts",
  );

  // 2. Deploy reputation contract
  const repWasm = path.join(wasmDir, "reputation.wasm");
  const repContractId = run(
    `stellar contract deploy --wasm ${repWasm} --source ${DEPLOYER} --network ${NETWORK}`,
    "Deploying reputation contract",
  );

  // 3. Initialize reputation
  const deployerAddress = run(
    `stellar keys address ${DEPLOYER}`,
    "Getting deployer address",
  );

  run(
    `stellar contract invoke --id ${repContractId} --source ${DEPLOYER} --network ${NETWORK} -- initialize --admin ${deployerAddress}`,
    "Initializing reputation contract",
  );

  // 4. Deploy circle factory
  const factoryWasm = path.join(wasmDir, "circle_factory.wasm");
  const factoryContractId = run(
    `stellar contract deploy --wasm ${factoryWasm} --source ${DEPLOYER} --network ${NETWORK}`,
    "Deploying circle_factory contract",
  );

  // 5. Upload circle WASM (get its hash)
  const circleWasm = path.join(wasmDir, "circle.wasm");
  const circleWasmHash = run(
    `stellar contract install --wasm ${circleWasm} --source ${DEPLOYER} --network ${NETWORK}`,
    "Installing circle contract WASM",
  );

  // 6. Get USDC address on testnet
  // On testnet we use the Stellar test USDC asset issued by centre.io
  // For a fully self-contained demo, deploy a test token instead
  const usdcContractId = run(
    `stellar contract deploy --wasm ${path.join(wasmDir, "circle.wasm")} --source ${DEPLOYER} --network ${NETWORK}`,
    "Note: In production use real USDC. For demo, using a test token address",
  );
  // In a real deploy you'd use the actual USDC contract address:
  // const usdcContractId = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

  // 7. Initialize factory
  run(
    `stellar contract invoke --id ${factoryContractId} --source ${DEPLOYER} --network ${NETWORK} -- initialize --admin ${deployerAddress} --circle-wasm-hash ${circleWasmHash} --reputation-contract ${repContractId} --usdc-token ${usdcContractId}`,
    "Initializing circle factory",
  );

  // 8. Write deployed addresses
  const deployed: DeployedAddresses = {
    reputation: repContractId,
    circleFactory: factoryContractId,
    usdc: usdcContractId,
    network: NETWORK,
    deployedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "../deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(deployed, null, 2));

  console.log("\n✅ All contracts deployed!");
  console.log(JSON.stringify(deployed, null, 2));
  console.log(`\nSaved to ${outPath}`);
  console.log("\nCopy these into your .env files:");
  console.log(`CIRCLE_FACTORY_ADDRESS=${deployed.circleFactory}`);
  console.log(`REPUTATION_ADDRESS=${deployed.reputation}`);
  console.log(`USDC_ADDRESS=${deployed.usdc}`);
}

main().catch((err) => {
  console.error("[deploy] Fatal:", err.message);
  process.exit(1);
});
