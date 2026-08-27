/**
 * funding-diagnostics.ts — Read-only balance checks (Issue #399)
 *
 * Identifies which accounts or token balances are insufficient before any
 * write transaction is submitted, providing threshold-specific, actionable
 * guidance for every shortfall.
 *
 * Rules:
 *  - NEVER submits a transaction.
 *  - NEVER reads or logs private keys.
 *  - Returns a structured result so callers can decide whether to abort.
 */

import {
  SorobanRpc,
  Horizon,
  Networks,
  StrKey,
} from "@stellar/stellar-sdk";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum XLM (in stroops) a deployer account must hold to pay deployment fees.
 *  Rough estimate: 3 contract deployments × ~200 000 stroops + 200 000 headroom.
 */
const MIN_DEPLOYER_STROOPS = 800_000n;

/** Minimum XLM (in stroops) a seed-demo participant must hold to pay tx fees. */
const MIN_MEMBER_STROOPS = 200_000n;

/** Minimum USDC (in stroops, 7-decimal) needed per member to join + contribute. */
const MIN_MEMBER_USDC_STROOPS = 200_000_000n; // $20 USDC

const STROOPS_PER_XLM = 10_000_000n;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BalanceDiagnostic {
  /** short label for the account, e.g. "deployer" */
  label: string;
  /** Stellar public key */
  address: string;
  /** Type of check performed */
  checkType: "xlm" | "token";
  /** Token contract ID (only for token checks) */
  tokenId?: string;
  /** Actual balance in stroops, or null when account/token is inaccessible */
  actualStroops: bigint | null;
  /** Minimum required balance in stroops */
  requiredStroops: bigint;
  /** Whether the balance meets the requirement */
  sufficient: boolean;
  /** Human-readable guidance when insufficient */
  guidance?: string;
}

export interface FundingDiagnosticsResult {
  /** true only when every check passed */
  ok: boolean;
  /** All individual checks */
  checks: BalanceDiagnostic[];
  /** Convenience list of failed checks */
  failures: BalanceDiagnostic[];
  /** Suggested next action when ok === false */
  summary?: string;
}

export interface FundingDiagnosticsOptions {
  rpcUrl: string;
  horizonUrl?: string;
  /** Public key of the deployer account */
  deployerPublicKey: string;
  /** Public keys of seed-demo members (optional) */
  memberPublicKeys?: string[];
  /** USDC token contract ID (optional, for token balance checks) */
  usdcContractId?: string;
  /** Network passphrase — used to detect testnet vs mainnet */
  networkPassphrase?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac  = stroops % STROOPS_PER_XLM;
  return `${whole}.${frac.toString().padStart(7, "0").replace(/0+$/, "") || "0"} XLM`;
}

function stroopsToUsdc(stroops: bigint): string {
  // USDC has 7 decimal places on Stellar
  const whole = stroops / 10_000_000n;
  const frac  = stroops % 10_000_000n;
  return `$${whole}.${frac.toString().padStart(7, "0").slice(0, 2)} USDC`;
}

/** Validate that a string is a G... Stellar public key. */
function isValidPublicKey(key: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(key);
  } catch {
    return false;
  }
}

/** Check if the RPC endpoint is reachable by fetching the latest ledger. */
export async function checkRpcReachability(rpcUrl: string): Promise<boolean> {
  try {
    const rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: true });
    await rpc.getLatestLedger();
    return true;
  } catch {
    return false;
  }
}

/** Read the native (XLM) balance of an account in stroops via Soroban RPC.
 *  Returns null when the account does not exist or the RPC is unreachable.
 */
async function getNativeBalanceStroops(
  rpc: SorobanRpc.Server,
  publicKey: string,
): Promise<bigint | null> {
  try {
    const account = await rpc.getAccount(publicKey);
    // stellar-sdk returns sequence as a string; balance is not directly
    // exposed on getAccount — use Horizon for balance reads.
    // We use a lightweight Horizon fetch here since it's read-only.
    return null; // will be filled by Horizon path below
  } catch {
    return null;
  }
}

/** Fetch XLM balance for an account via Horizon REST API (read-only). */
async function getXlmBalanceStroops(
  horizonUrl: string,
  publicKey: string,
): Promise<bigint | null> {
  try {
    const server = new Horizon.Server(horizonUrl, { allowHttp: true });
    const account = await server.loadAccount(publicKey);
    const xlmBalance = account.balances.find(
      (b) => b.asset_type === "native",
    );
    if (!xlmBalance) return 0n;
    // Convert "123.4567890" string to stroops
    const [whole, frac = ""] = xlmBalance.balance.split(".");
    const fracPadded = frac.padEnd(7, "0").slice(0, 7);
    return BigInt(whole) * STROOPS_PER_XLM + BigInt(fracPadded);
  } catch {
    return null;
  }
}

/** Fetch a USDC token balance via Soroban RPC simulation (read-only, no fee). */
async function getTokenBalanceStroops(
  rpcUrl: string,
  networkPassphrase: string,
  tokenContractId: string,
  ownerPublicKey: string,
): Promise<bigint | null> {
  try {
    const {
      SorobanRpc: Rpc,
      Contract,
      Address,
      TransactionBuilder,
      BASE_FEE,
      scValToNative,
      nativeToScVal,
    } = await import("@stellar/stellar-sdk");

    const rpc = new Rpc.Server(rpcUrl, { allowHttp: true });

    // Use a well-known fake account for simulation (no auth required for balance reads)
    const FAKE_ACCOUNT_ID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const fakeAccount = {
      id: FAKE_ACCOUNT_ID,
      sequence: "0",
      incrementSequenceNumber() {},
    } as never;

    const contract = new Contract(tokenContractId);
    const tx = new TransactionBuilder(fakeAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          "balance",
          new Address(ownerPublicKey).toScVal(),
        ),
      )
      .setTimeout(30)
      .build();

    const sim = await rpc.simulateTransaction(tx);
    if (Rpc.Api.isSimulationError(sim)) return null;
    if (!("result" in sim) || !sim.result) return null;

    const raw = scValToNative(sim.result.retval);
    return typeof raw === "bigint" ? raw : BigInt(String(raw));
  } catch {
    return null;
  }
}

// ── Core diagnostic runner ────────────────────────────────────────────────────

/**
 * Run all funding diagnostics.  Read-only — submits no transactions.
 */
export async function runFundingDiagnostics(
  opts: FundingDiagnosticsOptions,
): Promise<FundingDiagnosticsResult> {
  const {
    rpcUrl,
    horizonUrl = rpcUrl.includes("testnet")
      ? "https://horizon-testnet.stellar.org"
      : "https://horizon.stellar.org",
    deployerPublicKey,
    memberPublicKeys = [],
    usdcContractId,
    networkPassphrase = Networks.TESTNET,
  } = opts;

  const checks: BalanceDiagnostic[] = [];

  // ── 1. RPC reachability ───────────────────────────────────────────────────

  const rpcOk = await checkRpcReachability(rpcUrl);
  if (!rpcOk) {
    return {
      ok: false,
      checks: [],
      failures: [],
      summary:
        `❌  RPC endpoint is unreachable: ${rpcUrl}\n` +
        "    Check your internet connection or set STELLAR_RPC_URL to an available endpoint.\n" +
        "    Testnet RPC: https://soroban-testnet.stellar.org",
    };
  }

  // ── 2. Deployer public-key validity ──────────────────────────────────────

  if (!isValidPublicKey(deployerPublicKey)) {
    return {
      ok: false,
      checks: [],
      failures: [],
      summary:
        `❌  DEPLOYER_PUBLIC_KEY is not a valid Stellar public key: "${deployerPublicKey}"\n` +
        "    Generate a keypair with: stellar keys generate --global deployer --network testnet",
    };
  }

  // ── 3. Deployer XLM balance ───────────────────────────────────────────────

  const deployerXlm = await getXlmBalanceStroops(horizonUrl, deployerPublicKey);
  const deployerCheck: BalanceDiagnostic = {
    label:           "deployer",
    address:         deployerPublicKey,
    checkType:       "xlm",
    actualStroops:   deployerXlm,
    requiredStroops: MIN_DEPLOYER_STROOPS,
    sufficient:
      deployerXlm !== null && deployerXlm >= MIN_DEPLOYER_STROOPS,
  };

  if (deployerXlm === null) {
    deployerCheck.guidance =
      "Deployer account does not exist on this network.\n" +
      "  Fund it via Friendbot (testnet only):\n" +
      `    stellar keys fund deployer --network testnet\n` +
      "  Or transfer at least " +
      stroopsToXlm(MIN_DEPLOYER_STROOPS) +
      " to " + deployerPublicKey;
  } else if (!deployerCheck.sufficient) {
    deployerCheck.guidance =
      `Deployer balance is ${stroopsToXlm(deployerXlm)}; ` +
      `need at least ${stroopsToXlm(MIN_DEPLOYER_STROOPS)}.\n` +
      "  Top up via Friendbot (testnet only):\n" +
      `    curl "https://friendbot.stellar.org?addr=${deployerPublicKey}"\n` +
      "  On mainnet, transfer XLM to the deployer address.";
  }
  checks.push(deployerCheck);

  // ── 4. Member XLM balances ────────────────────────────────────────────────

  for (const memberKey of memberPublicKeys) {
    if (!isValidPublicKey(memberKey)) {
      checks.push({
        label:           `member (${memberKey.slice(0, 8)}…)`,
        address:         memberKey,
        checkType:       "xlm",
        actualStroops:   null,
        requiredStroops: MIN_MEMBER_STROOPS,
        sufficient:      false,
        guidance:
          `"${memberKey}" is not a valid Stellar public key.\n` +
          "  Generate accounts with: stellar keys generate alice --network testnet",
      });
      continue;
    }

    const bal = await getXlmBalanceStroops(horizonUrl, memberKey);
    const sufficient = bal !== null && bal >= MIN_MEMBER_STROOPS;

    const check: BalanceDiagnostic = {
      label:           `member (${memberKey.slice(0, 8)}…)`,
      address:         memberKey,
      checkType:       "xlm",
      actualStroops:   bal,
      requiredStroops: MIN_MEMBER_STROOPS,
      sufficient,
    };

    if (bal === null) {
      check.guidance =
        `Member account ${memberKey.slice(0, 8)}… does not exist.\n` +
        "  Fund via Friendbot:\n" +
        `    curl "https://friendbot.stellar.org?addr=${memberKey}"`;
    } else if (!sufficient) {
      check.guidance =
        `Member ${memberKey.slice(0, 8)}… has ${stroopsToXlm(bal)}, ` +
        `needs ${stroopsToXlm(MIN_MEMBER_STROOPS)} for transaction fees.\n` +
        `  Fund: curl "https://friendbot.stellar.org?addr=${memberKey}"`;
    }

    checks.push(check);
  }

  // ── 5. Member USDC balances (if token contract is known) ──────────────────

  if (usdcContractId && memberPublicKeys.length > 0) {
    for (const memberKey of memberPublicKeys) {
      if (!isValidPublicKey(memberKey)) continue;

      const usdcBal = await getTokenBalanceStroops(
        rpcUrl,
        networkPassphrase,
        usdcContractId,
        memberKey,
      );
      const sufficient =
        usdcBal !== null && usdcBal >= MIN_MEMBER_USDC_STROOPS;

      const check: BalanceDiagnostic = {
        label:           `member-usdc (${memberKey.slice(0, 8)}…)`,
        address:         memberKey,
        checkType:       "token",
        tokenId:         usdcContractId,
        actualStroops:   usdcBal,
        requiredStroops: MIN_MEMBER_USDC_STROOPS,
        sufficient,
      };

      if (usdcBal === null) {
        check.guidance =
          `Could not read USDC balance for ${memberKey.slice(0, 8)}…\n` +
          "  The token contract may not be deployed or the member may not have a trustline.\n" +
          `  Token: ${usdcContractId}`;
      } else if (!sufficient) {
        check.guidance =
          `Member ${memberKey.slice(0, 8)}… has ${stroopsToUsdc(usdcBal)} USDC, ` +
          `needs at least ${stroopsToUsdc(MIN_MEMBER_USDC_STROOPS)}.\n` +
          "  On testnet, mint USDC via the token admin or use a test USDC faucet.";
      }

      checks.push(check);
    }
  }

  // ── 6. Compile result ─────────────────────────────────────────────────────

  const failures = checks.filter((c) => !c.sufficient);
  const ok = failures.length === 0;

  let summary: string | undefined;
  if (!ok) {
    const lines = [
      `❌  ${failures.length} funding check(s) failed — deployment aborted before any write.`,
      "",
    ];
    for (const f of failures) {
      lines.push(`  • ${f.label} (${f.checkType})`);
      if (f.guidance) {
        for (const line of f.guidance.split("\n")) {
          lines.push(`    ${line}`);
        }
      }
    }
    summary = lines.join("\n");
  }

  return { ok, checks, failures, summary };
}

// ── Pretty-printer ────────────────────────────────────────────────────────────

/** Log funding diagnostic results to stdout in a human-readable format. */
export function printFundingDiagnostics(result: FundingDiagnosticsResult): void {
  console.log("\n[funding] Funding diagnostics");
  console.log("─".repeat(50));

  for (const c of result.checks) {
    const icon = c.sufficient ? "✅" : "❌";
    const actual =
      c.actualStroops === null
        ? "account not found"
        : c.checkType === "xlm"
        ? stroopsToXlm(c.actualStroops)
        : stroopsToUsdc(c.actualStroops);
    const required =
      c.checkType === "xlm"
        ? stroopsToXlm(c.requiredStroops)
        : stroopsToUsdc(c.requiredStroops);

    console.log(`  ${icon} ${c.label}: ${actual} (need ${required})`);
    if (!c.sufficient && c.guidance) {
      for (const line of c.guidance.split("\n")) {
        console.log(`       ${line}`);
      }
    }
  }

  console.log("─".repeat(50));

  if (result.ok) {
    console.log("  ✅ All funding checks passed.\n");
  } else {
    console.log(`\n${result.summary}\n`);
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const dotenv = await import("dotenv");
    const path   = await import("path");
    dotenv.default.config({ path: path.default.join(__dirname, "../.env") });

    const deployerPublicKey = process.env.DEPLOYER_PUBLIC_KEY ?? "";
    const rpcUrl            = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
    const usdcContractId    = process.env.USDC_ADDRESS;
    const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

    if (!deployerPublicKey) {
      console.error(
        "[funding] DEPLOYER_PUBLIC_KEY is not set.\n" +
        "  Export it or add it to scripts/.env:\n" +
        "    DEPLOYER_PUBLIC_KEY=$(stellar keys address deployer)",
      );
      process.exit(1);
    }

    const result = await runFundingDiagnostics({
      rpcUrl,
      deployerPublicKey,
      usdcContractId,
      networkPassphrase,
    });

    printFundingDiagnostics(result);
    process.exit(result.ok ? 0 : 1);
  })();
}
