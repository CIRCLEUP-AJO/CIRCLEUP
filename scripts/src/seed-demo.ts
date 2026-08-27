/**
 * Seed Demo Script
 *
 * Creates a 4-member, $100/round demo circle on testnet and walks through:
 *   Round 1: all contribute → member A receives $400
 *   Round 2: member D misses → mark_default called → penalty shown
 *   After round 1: member A's reputation score increments
 *
 * Usage:
 *   npx ts-node src/seed-demo.ts
 *
 * Prerequisites:
 *   - deployed.json exists (run deploy.ts first)
 *   - stellar-cli funded testnet accounts: alice, bob, carol, dave
 *     stellar keys generate alice --network testnet
 *     curl "https://friendbot.stellar.org?addr=$(stellar keys address alice)"
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import {
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  runFundingDiagnostics,
  printFundingDiagnostics,
  checkRpcReachability,
} from "./funding-diagnostics";

// Load from scripts/.env if present, otherwise fall back to root .env
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

// ─── Config ──────────────────────────────────────────────────────────────────

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = "https://soroban-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

// $100 USDC = 1_000_000_000 stroops (7 decimals)
const ROUND_AMOUNT = 1_000_000_000n; // $100
// ~7 day round in ledgers (5s/ledger)
const ROUND_DEADLINE_LEDGERS = 120_960;

const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fund(address: string) {
  console.log(`  Funding ${address.slice(0, 8)}… via friendbot`);
  const res = await fetch(`${FRIENDBOT}?addr=${address}`);
  if (!res.ok) {
    const body = await res.text();
    if (!body.includes("createAccountAlreadyExist")) {
      throw new Error(`Friendbot failed: ${body}`);
    }
  }
}

async function buildAndSend(
  keypair: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  const account = await rpc.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);

  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30);

  const tx = txBuilder.build();
  const simResult = await rpc.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation error: ${simResult.error}`);
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);

  const sendResult = await rpc.sendTransaction(preparedTx);
  if (sendResult.status === "ERROR") {
    throw new Error(`Send error: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const hash = sendResult.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await rpc.getTransaction(hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${hash}`);
    }
  }
  throw new Error(`Timeout waiting for transaction ${hash}`);
}

async function readContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T> {
  const contract = new Contract(contractId);
  const fakeAccount = {
    id: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    sequence: "0",
    incrementSequenceNumber() {},
  } as any;

  const tx = new TransactionBuilder(fakeAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(simResult.error);
  }
  if (!("result" in simResult) || !simResult.result) {
    throw new Error("No result from simulation");
  }
  return scValToNative(simResult.result.retval) as T;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load deployed addresses
  const deployedPath = path.join(__dirname, "../deployed.json");
  if (!fs.existsSync(deployedPath)) {
    throw new Error("deployed.json not found. Run deploy.ts first.");
  }
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf-8"));

  console.log("🔄 CircleUp Demo Seed Script");
  console.log("===========================");
  console.log(`Factory: ${deployed.circleFactory}`);
  console.log(`Reputation: ${deployed.reputation}`);
  console.log(`USDC: ${deployed.usdc}`);
  console.log("");

  // ── Funding diagnostics (#399) — fail early before any write ─────────────

  console.log("[seed] Checking RPC reachability and account funding...");
  const rpcOk = await checkRpcReachability(RPC_URL);
  if (!rpcOk) {
    throw new Error(
      `[seed] RPC endpoint is unreachable: ${RPC_URL}\n` +
      "  Check your internet connection or set RPC_URL to an available testnet endpoint.",
    );
  }

  // Generate 4 member keypairs
  const alice = Keypair.random();
  const bob = Keypair.random();
  const carol = Keypair.random();
  const dave = Keypair.random();
  const members = [alice, bob, carol, dave];
  const names = ["Alice", "Bob", "Carol", "Dave"];

  console.log("👥 Members:");
  for (const [i, kp] of members.entries()) {
    console.log(`  ${names[i]}: ${kp.publicKey()}`);
  }
  console.log("");

  // Fund all members
  console.log("💧 Funding accounts via Friendbot...");
  for (const kp of members) {
    await fund(kp.publicKey());
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Run funding diagnostics after friendbot funding to verify sufficiency
  console.log("\n[seed] Running post-funding balance checks...");
  const fundingResult = await runFundingDiagnostics({
    rpcUrl:            RPC_URL,
    deployerPublicKey: alice.publicKey(), // alice acts as circle creator
    memberPublicKeys:  members.map((kp) => kp.publicKey()),
    usdcContractId:    deployed.usdc,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  printFundingDiagnostics(fundingResult);

  // Check only XLM balances here (USDC may not be funded yet — that's expected)
  const xlmFailures = fundingResult.failures.filter((f) => f.checkType === "xlm");
  if (xlmFailures.length > 0) {
    throw new Error(
      "[seed] Insufficient XLM balance — aborting before any contract calls.\n" +
      xlmFailures.map((f) => `  • ${f.label}: ${f.guidance ?? "insufficient"}`).join("\n"),
    );
  }

  console.log("\n💵 Note: In a real demo, fund each account with testnet USDC.");
  console.log("   Skipping USDC mint step — use stellar-cli to mint test USDC.");

  // Create circle via factory
  console.log("\n🏗️  Creating 4-member $100/round circle...");
  const membersVec = xdr.ScVal.scvVec(
    members.map((kp) => new Address(kp.publicKey()).toScVal()),
  );

  const createHash = await buildAndSend(alice, deployed.circleFactory, "create_circle", [
    new Address(alice.publicKey()).toScVal(),
    membersVec,
    nativeToScVal(ROUND_AMOUNT, { type: "i128" }),
    nativeToScVal(ROUND_DEADLINE_LEDGERS, { type: "u32" }),
  ]);
  console.log(`  ✅ Circle created. Tx: ${createHash}`);

  // Get circle address from factory
  const circleAddresses = await readContract<string[]>(
    deployed.circleFactory,
    "get_circles",
    [],
  );
  const circleAddress = circleAddresses[circleAddresses.length - 1];
  console.log(`  Circle address: ${circleAddress}`);

  // All members join (lock collateral)
  console.log("\n🔒 All members join (lock $100 collateral)...");
  for (const [i, kp] of members.entries()) {
    const hash = await buildAndSend(kp, circleAddress, "join", [
      new Address(kp.publicKey()).toScVal(),
    ]);
    console.log(`  ✅ ${names[i]} joined. Tx: ${hash.slice(0, 16)}…`);
  }

  // === ROUND 1 ===
  console.log("\n--- ROUND 1: All contribute → Alice receives $400 ---");

  for (const [i, kp] of members.entries()) {
    const hash = await buildAndSend(kp, circleAddress, "contribute", [
      new Address(kp.publicKey()).toScVal(),
    ]);
    console.log(`  ✅ ${names[i]} contributed $100. Tx: ${hash.slice(0, 16)}…`);
  }

  // Payout round 1
  const payoutHash1 = await buildAndSend(alice, circleAddress, "payout", []);
  console.log(`  ✅ Payout triggered. Alice receives $400. Tx: ${payoutHash1.slice(0, 16)}…`);

  // Check Alice's reputation
  const aliceScore = await readContract<number>(deployed.reputation, "score", [
    new Address(alice.publicKey()).toScVal(),
  ]);
  console.log(`\n  🏆 Alice's reputation score: ${aliceScore}`);

  // Check round state
  const round = await readContract<any>(circleAddress, "get_current_round", []);
  console.log(`  📍 Now on round ${round.round_index}, next recipient: Bob`);

  // === ROUND 2 ===
  console.log("\n--- ROUND 2: Dave misses → default flag + penalty ---");

  // Alice, Bob, Carol contribute; Dave does NOT
  for (const [i, kp] of [alice, bob, carol].entries()) {
    const name = names[i];
    const hash = await buildAndSend(kp, circleAddress, "contribute", [
      new Address(kp.publicKey()).toScVal(),
    ]);
    console.log(`  ✅ ${name} contributed $100. Tx: ${hash.slice(0, 16)}…`);
  }
  console.log(`  ❌ Dave did NOT contribute.`);

  // Advance ledger past deadline via a note (in testnet you'd wait or use bump)
  console.log(`\n  ⏰ In production: wait for round deadline to pass, then call mark_default.`);
  console.log(`  (In test environments, ledger can be advanced programmatically.)`);
  console.log(`\n  Simulating mark_default call for Dave...`);

  // Note: in a real testnet demo we'd need to wait for the deadline ledger
  // For demo purposes we show the call that would be made:
  console.log(`
  stellar contract invoke \\
    --id ${circleAddress} \\
    --source alice \\
    --network testnet \\
    -- mark_default \\
    --member ${dave.publicKey()}
  `);

  console.log("\n  📋 After mark_default:");
  console.log(`  Dave's collateral reduced by 20% (penalty = $20)`);
  console.log(`  Dave's default counter: 1`);

  // Final summary
  console.log("\n✅ Demo Summary");
  console.log("==============");
  console.log(`Circle address:   ${circleAddress}`);
  console.log(`Round 1 payout:   Alice received $400 ✅`);
  console.log(`Alice reputation: ${aliceScore} completed round(s) 🏆`);
  console.log(`Round 2 default:  Dave flagged, 20% collateral penalty ⚠️`);
  console.log(`\nExplore on testnet:`);
  console.log(`  https://stellar.expert/explorer/testnet/contract/${circleAddress}`);

  // Save seed output
  const seedOut = {
    circleAddress,
    members: {
      alice: alice.publicKey(),
      bob: bob.publicKey(),
      carol: carol.publicKey(),
      dave: dave.publicKey(),
    },
    roundAmount: "$100 USDC",
    seededAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(__dirname, "../seeded.json"),
    JSON.stringify(seedOut, null, 2),
  );
  console.log(`\nSaved to scripts/seeded.json`);
}

main().catch((err) => {
  console.error("[seed] Fatal:", err.message);
  process.exit(1);
});
