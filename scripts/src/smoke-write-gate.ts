/**
 * smoke-write-gate.ts — Disposable-testnet gate for write-based smoke tests (#865)
 *
 * Read-only smoke checks (smoke-test.ts) are safe for any release candidate.
 * Smoke scenarios that SUBMIT TRANSACTIONS (create a circle, join, contribute)
 * are only allowed when every condition below holds:
 *
 *   1. The target environment is "testnet". Mainnet is refused unconditionally
 *      — there is no override flag, by design.
 *   2. SMOKE_TESTNET=true is set explicitly.
 *   3. SMOKE_NETWORK_PASSPHRASE equals the public testnet passphrase.
 *   4. SMOKE_RPC_URL and SMOKE_HORIZON_URL are set and do not point at a
 *      mainnet/pubnet endpoint.
 *   5. SMOKE_DISPOSABLE_ACCOUNT=true acknowledges the signing account is a
 *      throwaway testnet account holding no real value.
 *   6. SMOKE_TESTNET_PUBLIC_KEY is a valid G… key and SMOKE_TESTNET_SECRET is
 *      present (its value is never logged or returned).
 *   7. The account holds at least MIN_SMOKE_FUNDING_XLM native balance, checked
 *      with a read-only Horizon GET before any write runs.
 *
 * `evaluateWriteGate` is pure (env in, decision out) so it can be reported by
 * the non-mutating smoke-test command. `runGatedTestnetWrites` is the only
 * entry point write scenarios may use; it re-evaluates the gate and checks
 * funding immediately before invoking the scenario.
 */

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Minimum native balance (XLM) the disposable account must hold. */
export const MIN_SMOKE_FUNDING_XLM = 50;

const MAINNET_URL_PATTERN = /mainnet|pubnet|^horizon\.stellar\.org$/i;
const PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

export type WriteGateDecision =
  | { allowed: true; publicKey: string; rpcUrl: string; horizonUrl: string; checks: string[] }
  | { allowed: false; status: "skip" | "fail"; reason: string };

type Env = Record<string, string | undefined>;

function looksLikeMainnetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return MAINNET_URL_PATTERN.test(u.host) || MAINNET_URL_PATTERN.test(u.pathname);
  } catch {
    return true; // unparseable URLs are treated as unsafe
  }
}

/**
 * Decide whether write-based smoke tests may run. Never reads the secret's
 * value beyond checking that it is present.
 */
export function evaluateWriteGate(environment: string, env: Env = process.env): WriteGateDecision {
  const requested = env.SMOKE_TESTNET === "true";

  if (environment === "mainnet") {
    return requested
      ? {
          allowed: false,
          status: "fail",
          reason:
            "SMOKE_TESTNET=true was set for a mainnet release candidate. Write-based smoke " +
            "tests never run against mainnet; unset SMOKE_TESTNET for mainnet checks.",
        }
      : {
          allowed: false,
          status: "skip",
          reason: "Mainnet release candidate: write-based smoke tests are never run (read-only checks only).",
        };
  }

  if (!requested) {
    return {
      allowed: false,
      status: "skip",
      reason: "SMOKE_TESTNET is not 'true' — write-based testnet smoke tests skipped.",
    };
  }

  if (environment !== "testnet") {
    return {
      allowed: false,
      status: "fail",
      reason: `Write-based smoke tests require environment "testnet", got "${environment}".`,
    };
  }

  const passphrase = env.SMOKE_NETWORK_PASSPHRASE;
  if (passphrase === MAINNET_PASSPHRASE) {
    return { allowed: false, status: "fail", reason: "SMOKE_NETWORK_PASSPHRASE is the MAINNET passphrase." };
  }
  if (passphrase !== TESTNET_PASSPHRASE) {
    return {
      allowed: false,
      status: "fail",
      reason: "SMOKE_NETWORK_PASSPHRASE must equal the public testnet passphrase.",
    };
  }

  const rpcUrl = env.SMOKE_RPC_URL ?? "";
  const horizonUrl = env.SMOKE_HORIZON_URL ?? "";
  if (!rpcUrl || !horizonUrl) {
    return { allowed: false, status: "fail", reason: "SMOKE_RPC_URL and SMOKE_HORIZON_URL are required." };
  }
  if (looksLikeMainnetUrl(rpcUrl) || looksLikeMainnetUrl(horizonUrl)) {
    return {
      allowed: false,
      status: "fail",
      reason: "SMOKE_RPC_URL / SMOKE_HORIZON_URL look like mainnet or are not valid URLs.",
    };
  }

  if (env.SMOKE_DISPOSABLE_ACCOUNT !== "true") {
    return {
      allowed: false,
      status: "fail",
      reason: "Set SMOKE_DISPOSABLE_ACCOUNT=true to confirm the signing account is a disposable testnet account.",
    };
  }

  const publicKey = env.SMOKE_TESTNET_PUBLIC_KEY ?? "";
  if (!PUBLIC_KEY_PATTERN.test(publicKey)) {
    return { allowed: false, status: "fail", reason: "SMOKE_TESTNET_PUBLIC_KEY must be a valid G… public key." };
  }
  if (!env.SMOKE_TESTNET_SECRET || !env.SMOKE_TESTNET_SECRET.startsWith("S")) {
    return { allowed: false, status: "fail", reason: "SMOKE_TESTNET_SECRET is missing or malformed." };
  }

  return {
    allowed: true,
    publicKey,
    rpcUrl,
    horizonUrl,
    checks: [
      "environment=testnet",
      "SMOKE_TESTNET=true",
      "testnet passphrase",
      "non-mainnet RPC/Horizon URLs",
      "disposable account acknowledged",
      "signing key present (not logged)",
    ],
  };
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FundingResult {
  ok: boolean;
  balanceXlm: number | null;
  reason: string;
}

/** Read-only Horizon balance lookup. Never submits anything. */
export async function checkFunding(
  horizonUrl: string,
  publicKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  minXlm: number = MIN_SMOKE_FUNDING_XLM,
): Promise<FundingResult> {
  const url = `${horizonUrl.replace(/\/+$/, "")}/accounts/${publicKey}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    return { ok: false, balanceXlm: null, reason: `Horizon request failed: ${String(err)}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      balanceXlm: null,
      reason: res.status === 404 ? "Account not found on testnet — fund it via friendbot." : `Horizon HTTP ${res.status}`,
    };
  }
  const body = (await res.json()) as { balances?: Array<{ asset_type?: string; balance?: string }> };
  const native = body.balances?.find((b) => b.asset_type === "native");
  const balanceXlm = native?.balance !== undefined ? Number(native.balance) : null;
  if (balanceXlm === null || !Number.isFinite(balanceXlm)) {
    return { ok: false, balanceXlm: null, reason: "No native balance reported for the account." };
  }
  if (balanceXlm < minXlm) {
    return { ok: false, balanceXlm, reason: `Balance ${balanceXlm} XLM is below the ${minXlm} XLM minimum.` };
  }
  return { ok: true, balanceXlm, reason: `Funded: ${balanceXlm} XLM.` };
}

/**
 * The single entry point for write-based smoke scenarios. Throws (and never
 * runs `scenario`) unless the gate and the funding check both pass.
 */
export async function runGatedTestnetWrites<T>(
  environment: string,
  scenario: (ctx: { publicKey: string; rpcUrl: string; horizonUrl: string }) => Promise<T>,
  opts: { env?: Env; fetchImpl?: FetchLike } = {},
): Promise<T> {
  const decision = evaluateWriteGate(environment, opts.env ?? process.env);
  if (!decision.allowed) {
    throw new Error(`[smoke-write-gate] refused: ${decision.reason}`);
  }
  const funding = await checkFunding(decision.horizonUrl, decision.publicKey, opts.fetchImpl);
  if (!funding.ok) {
    throw new Error(`[smoke-write-gate] refused: ${funding.reason}`);
  }
  return scenario({
    publicKey: decision.publicKey,
    rpcUrl: decision.rpcUrl,
    horizonUrl: decision.horizonUrl,
  });
}
