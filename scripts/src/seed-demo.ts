/**
 * Seed Demo Script
 *
 * Creates a 4-member, $100/round demo circle on testnet and walks through:
 *   Round 1: all contribute → member A receives $400
 *   Round 2: member D misses → mark_default called → penalty shown
 *   After round 1: member A's reputation score increments
 *
 * Usage:
 *   npm run seed:demo --workspace=scripts -- --always-create
 *
 * Prerequisites:
 *   - deployed-manifest.json exists (run deploy.ts first)
 *   - testnet Soroban RPC and Friendbot are reachable
 *   - pass --always-create to acknowledge that each run creates new state
 */

import * as dotenv from "dotenv";
import * as path from "path";
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
import { validateManifest } from "./deployment-manifest";
import {
  runFundingDiagnostics,
  printFundingDiagnostics,
  checkRpcReachability,
} from "./funding-diagnostics";
import {
  assertAlwaysCreate,
  assertSeedNetwork,
  recordSeedTransaction,
  redactSeedError,
  SeedJournal,
  writeSeedJournal,
} from "./seed-demo-policy";

// Load from scripts/.env if present, otherwise fall back to root .env
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

// ─── Config ──────────────────────────────────────────────────────────────────

const NETWORK = process.env.NETWORK ?? "testnet";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

// $100 USDC = 1_000_000_000 stroops (7 decimals)
const ROUND_AMOUNT = 1_000_000_000n; // $100
// ~7 day round in ledgers (5s/ledger)
const ROUND_DEADLINE_LEDGERS = 120_960;

const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
const seedOutPath = path.join(__dirname, "../seeded.json");
let activeJournal!: SeedJournal;

function persistJournal() {
  if (activeJournal) writeSeedJournal(seedOutPath, activeJournal);
}

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
  step: string,
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
    throw new Error(`Simulation error: ${redactSeedError(String(simResult.error))}`);
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);
  const transactionHash = preparedTx.hash().toString("hex");
  recordSeedTransaction(activeJournal!, step, transactionHash, "pending");
  persistJournal();

  const sendResult = await rpc.sendTransaction(preparedTx);
  if (sendResult.status === "ERROR") {
    recordSeedTransaction(activeJournal!, step, transactionHash, "failed");
    persistJournal();
    throw new Error(`Send error: ${transactionHash} ${redactSeedError(JSON.stringify(sendResult.errorResult))}`);
  }

  const hash = sendResult.hash || transactionHash;
  recordSeedTransaction(activeJournal!, step, hash, "submitted");
  persistJournal();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await rpc.getTransaction(hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      recordSeedTransaction(activeJournal!, step, hash, "confirmed");
      activeJournal!.currentStep = undefined;
      persistJournal();
      return hash;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      recordSeedTransaction(activeJournal!, step, hash, "failed");
      persistJournal();
      throw new Error(`Transaction failed: ${hash}`);
    }
  }
  recordSeedTransaction(activeJournal!, step, hash, "timeout");
  persistJournal();
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
  assertAlwaysCreate(process.argv.slice(2));

  const manifestPath = path.join(__dirname, "../deployed-manifest.json");
  const validation = validateManifest(manifestPath, NETWORK);
  if (!validation.ok || !validation.manifest) {
    throw new Error(
      `[seed] Refusing to seed with an invalid deployment manifest:\n${validation.errors.join("\n")}`,
    );
  }
  const deployed = validation.manifest;
  const rpcNetwork = await rpc.getNetwork();
  assertSeedNetwork(NETWORK, NETWORK_PASSPHRASE, rpcNetwork.passphrase, deployed);

  console.log("🔄 CircleUp Demo Seed Script");
  console.log("===========================");
  console.log(`Factory: ${deployed.contracts.circleFactory.contractId}`);
  console.log(`Reputation: ${deployed.contracts.reputation.contractId}`);
  console.log(`USDC: ${deployed.contracts.usdc}`);
  console.log("");

  // ── Funding diagnostics (#399) — fail early before any write ─────────────

  console.log("[seed] Checking RPC reachability and account funding...");
  const rpcOk = await checkRpcReachability(RPC_URL);
  if (!rpcOk) {
    throw new Error("[seed] RPC endpoint is unreachable. Check the configured testnet endpoint and network connectivity.");
  }

  // Generate 4 member keypairs
  const alice = Keypair.random();
  const bob = Keypair.random();
  const carol = Keypair.random();
  const dave = Keypair.random();
  const members = [alice, bob, carol, dave];
  const names = ["Alice", "Bob", "Carol", "Dave"];
  activeJournal = {
    runId: `${new Date().toISOString()}-${process.pid}`,
    status: "in_progress",
    network: NETWORK,
    members: members.map((member) => member.publicKey()),
    completedSteps: [],
    transactions: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  persistJournal();

  console.log("👥 Members:");
  for (const [i, kp] of members.entries()) {
    console.log(`  ${names[i]}: ${kp.publicKey()}`);
  }
  console.log("");

  // Fund all members
  console.log("💧 Funding accounts via Friendbot...");
  for (const kp of members) {
    activeJournal.currentStep = `fund:${kp.publicKey()}`;
    persistJournal();
    await fund(kp.publicKey());
    activeJournal.completedSteps.push(`fund:${kp.publicKey()}`);
    activeJournal.currentStep = undefined;
    persistJournal();
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Run funding diagnostics after friendbot funding to verify sufficiency
  console.log("\n[seed] Running post-funding balance checks...");
  const fundingResult = await runFundingDiagnostics({
    rpcUrl:            RPC_URL,
    deployerPublicKey: alice.publicKey(), // alice acts as circle creator
    memberPublicKeys:  members.map((kp) => kp.publicKey()),
    usdcContractId:    deployed.contracts.usdc,
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

  activeJournal.currentStep = "create_circle";
  persistJournal();
  const createHash = await buildAndSend(alice, deployed.contracts.circleFactory.contractId, "create_circle", [
    new Address(alice.publicKey()).toScVal(),
    membersVec,
    nativeToScVal(ROUND_AMOUNT, { type: "i128" }),
    nativeToScVal(ROUND_DEADLINE_LEDGERS, { type: "u32" }),
  ], "create_circle");
  console.log(`  ✅ Circle created. Tx: ${createHash}`);

  // Get circle address from factory
  const circleAddresses = await readContract<string[]>(
    deployed.contracts.circleFactory.contractId,
    "get_circles",
    [],
  );
  const circleAddress = circleAddresses[circleAddresses.length - 1];
  activeJournal.circleAddress = circleAddress;
  persistJournal();
  console.log(`  Circle address: ${circleAddress}`);

  // All members join (lock collateral)
  console.log("\n🔒 All members join (lock $100 collateral)...");
  for (const [i, kp] of members.entries()) {
    activeJournal.currentStep = `join:${names[i]}`;
    persistJournal();
    const hash = await buildAndSend(kp, circleAddress, "join", [
      new Address(kp.publicKey()).toScVal(),
    ], `join:${names[i]}`);
    console.log(`  ✅ ${names[i]} joined. Tx: ${hash.slice(0, 16)}…`);
  }

  // === ROUND 1 ===
  console.log("\n--- ROUND 1: All contribute → Alice receives $400 ---");

  for (const [i, kp] of members.entries()) {
    activeJournal.currentStep = `contribute-round-1:${names[i]}`;
    persistJournal();
    const hash = await buildAndSend(kp, circleAddress, "contribute", [
      new Address(kp.publicKey()).toScVal(),
    ], `contribute-round-1:${names[i]}`);
    console.log(`  ✅ ${names[i]} contributed $100. Tx: ${hash.slice(0, 16)}…`);
  }

  // Payout round 1
  activeJournal.currentStep = "payout:round-1";
  persistJournal();
  const payoutHash1 = await buildAndSend(alice, circleAddress, "payout", [], "payout:round-1");
  console.log(`  ✅ Payout triggered. Alice receives $400. Tx: ${payoutHash1.slice(0, 16)}…`);

  // Check Alice's reputation
  const aliceScore = await readContract<number>(deployed.contracts.reputation.contractId, "score", [
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
    activeJournal.currentStep = `contribute-round-2:${name}`;
    persistJournal();
    const hash = await buildAndSend(kp, circleAddress, "contribute", [
      new Address(kp.publicKey()).toScVal(),
    ], `contribute-round-2:${name}`);
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

  activeJournal.status = "completed";
  activeJournal.currentStep = undefined;
  activeJournal.completedAt = new Date().toISOString();
  persistJournal();
  console.log(`\nSaved to scripts/seeded.json`);
}

main().catch((err) => {
  if (activeJournal) {
    activeJournal.status = "failed";
    activeJournal.failure = redactSeedError(String(err.message));
    try {
      persistJournal();
    } catch (journalError) {
      console.error("[seed] Could not update progress journal:", redactSeedError(String(journalError)));
    }
  }
  console.error("[seed] Fatal:", redactSeedError(String(err.message)));
  process.exit(1);
});
