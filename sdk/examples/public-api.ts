/**
 * Public API usage fixture for @circleup/sdk (issue #348).
 *
 * Every import below comes from the package root ("@circleup/sdk") — there are
 * no deep "@circleup/sdk/dist/..." or "../src/..." paths. If this file
 * type-checks, the documented public surface is reachable from the root exactly
 * as a consumer would use it, and the declaration output exposes those symbols.
 *
 * Compiled by examples/tsconfig.json (which maps "@circleup/sdk" to the package
 * entry point). Excluded from the published build. Side-effect free — nothing
 * runs at import time, so it is safe to include in a type-check step.
 */
import {
  // Clients
  CircleUpClient,
  // Errors
  GateError,
  IndexerError,
  // Config & network
  getNetworkConfig,
  TESTNET_RPC_URL,
  TESTNET_PASSPHRASE,
  // Units
  usdcToStroops,
  stroopsToUsdc,
  formatUsdc,
  STROOPS_PER_USDC,
  // Gating
  computeActionEligibility,
  isGateBlocked,
  // Types (type-only imports also resolve from the root)
  type CircleUpConfig,
  type NetworkConfig,
  type StateSnapshot,
  // Deprecated symbol verification (issue #909 — planned removal in 0.4.0)
  type CircleDetailResponse,
} from "@circleup/sdk";

/** Verified import of deprecated alias — removed in 0.4.0. */
export type PublicApiDeprecatedAliasCheck = CircleDetailResponse;

/** Construct the top-level client from the documented config shape. */
export function makeClient(): CircleUpClient {
  const config: CircleUpConfig = {
    rpcUrl: TESTNET_RPC_URL,
    networkPassphrase: TESTNET_PASSPHRASE,
    contracts: {
      circleFactory: "C".padEnd(56, "A"),
      reputation: "C".padEnd(56, "B"),
      usdc: "C".padEnd(56, "D"),
    },
    indexerUrl: "http://localhost:3001",
  };
  return new CircleUpClient(config);
}

/** Resolve a network's RPC + passphrase via the documented helper. */
export function testnetConfig(): NetworkConfig {
  return getNetworkConfig("testnet");
}

/** Round-trip an amount through the documented unit helpers. */
export function money(): { stroops: bigint; usdc: string; display: string } {
  const stroops = usdcToStroops(100);
  return {
    stroops,
    usdc: stroopsToUsdc(stroops),
    display: `${formatUsdc(stroops)} (1 USDC = ${STROOPS_PER_USDC} stroops)`,
  };
}

/** Gate an action against a snapshot the caller already holds. */
export function contributeBlockReason(snapshot: StateSnapshot): string | null {
  const result = computeActionEligibility("contribute", snapshot, {
    hasContributedCurrentRound: false,
  });
  return isGateBlocked(result) ? result.message : null;
}

/** Distinguish the SDK's public error types. */
export function describeError(err: unknown): string {
  if (err instanceof GateError) return `gate blocked (${err.reason}): ${err.message}`;
  if (err instanceof IndexerError) return `indexer ${err.status} at ${err.url}: ${err.message}`;
  return "unknown error";
}

// ─── Indexer paging, decoding, and write recovery ─────────────────────────────

import {
  IndexerClient,
  INDEXER_MAX_PAGE_SIZE,
  isRetryable,
  isTxFailure,
  mapRawConfig,
  assertValidCircleStatus,
  decodeI128,
  type ApiCircleRow,
  type CircleConfig,
  type CircleStatus,
  type IndexerPagination,
  type SubmissionDiagnostics,
  type TxLookup,
  type TxResult,
} from "@circleup/sdk";

/** Walk at most three pages of Active circles, keeping each page's metadata. */
export async function activeCircles(
  indexer: IndexerClient,
): Promise<{ rows: ApiCircleRow[]; last: IndexerPagination | null }> {
  const rows: ApiCircleRow[] = [];
  let last: IndexerPagination | null = null;
  for await (const page of indexer.iterateCircles(
    { status: "Active", limit: INDEXER_MAX_PAGE_SIZE },
    { maxPages: 3 },
  )) {
    rows.push(...page.circles);
    last = page.pagination;
  }
  return { rows, last };
}

/** Narrow raw `scValToNative` output through the root-exported decoders. */
export function decodeReads(
  rawConfig: unknown,
  rawStatus: unknown,
  rawCollateral: unknown,
): { config: CircleConfig; status: CircleStatus; collateral: bigint } {
  return {
    config: mapRawConfig(rawConfig),
    status: assertValidCircleStatus(rawStatus),
    collateral: decodeI128(rawCollateral, "collateral", { min: 0n }),
  };
}

/**
 * Decide how to recover from a write: resubmit only when the SDK says it is
 * safe, otherwise settle the original hash first.
 */
export async function recover(
  client: CircleUpClient,
  result: TxResult,
): Promise<"done" | "resubmit" | TxLookup["status"] | "lookup_failed"> {
  if (!isTxFailure(result)) return "done";
  if (isRetryable(result)) return "resubmit";
  const diagnostics: SubmissionDiagnostics | undefined = result.diagnostics;
  const hash = diagnostics?.txHash ?? result.txHash;
  if (!hash) return "lookup_failed";
  const lookup = await client.lookupTransaction(hash);
  return lookup.ok ? lookup.value.status : "lookup_failed";
}

// ─── API deprecation policy (issue #149) ─────────────────────────────────────

import {
  readDeprecations,
  isDeprecated,
  type Deprecation,
  type DeprecationHeaders,
} from "@circleup/sdk";

/**
 * Observe a deprecation before it breaks anything.
 *
 * Deprecated fields and endpoints keep working for the full migration window
 * (see docs/api-deprecation-policy.md). The indexer advertises each pending
 * change in the response body's `deprecations` array and mirrors it in the
 * `Deprecation` / `Sunset` response headers, so a consumer can warn and migrate
 * without parsing logs. `Sunset` is the RFC 8594 date after which the old form
 * may be removed; nothing is removed before it.
 */
export function pendingDeprecations(
  headers: DeprecationHeaders,
  body: { deprecations?: Deprecation[] },
): { warnings: string[]; sunsetAt: Date | null } {
  // Headers are the observable signal; the body array carries the detail.
  const deprecations = readDeprecations(headers, body);
  const warnings = deprecations.map(
    (d) => `${d.field} is deprecated in favor of ${d.replacement}; removed after ${d.sunset}`,
  );
  const sunsetAt = deprecations.length
    ? new Date(Math.min(...deprecations.map((d) => Date.parse(d.sunset))))
    : null;
  return { warnings, sunsetAt };
}

/**
 * Migrate a read model to the replacement field while the old one still works.
 *
 * Read the replacement when present and fall back to the deprecated field only
 * during the window; after `sunset` the fallback can be deleted. `isDeprecated`
 * lets a consumer assert it is no longer relying on a field slated for removal.
 */
export function circleName(row: { name?: string; title?: string }): string {
  if (isDeprecated("name")) {
    // Transitional: prefer the replacement, fall back to the old field.
    return row.title ?? row.name ?? "";
  }
  return row.title ?? "";
}

// ─── Network identity, error taxonomy, and lifecycle (issues #900–#903) ──────

import {
  resolveNetworkIdentity,
  classifySdkError,
  txLifecycleFromResult,
  txLifecycleFromLookup,
  RETRY_POLICY,
  type NetworkIdentity,
  type SdkErrorInfo,
  type TxLifecycle,
} from "@circleup/sdk";

/** A custom (standalone) network needs its name, URL, and passphrase together. */
export function standaloneIdentity(): NetworkIdentity {
  return resolveNetworkIdentity({
    network: "custom",
    rpcUrl: "http://localhost:8000/soroban/rpc",
    networkPassphrase: "Standalone Network ; February 2017",
  });
}

/** Branch on the stable error code — never on message text. */
export function errorBanner(err: unknown): { text: string; info: SdkErrorInfo } {
  const info = classifySdkError(err);
  switch (info.code) {
    case "wallet_rejected":
      return { text: "You declined the signature.", info };
    case "network_mismatch":
      return { text: "Switch your wallet to the configured network.", info };
    case "send_ambiguous":
    case "poll_timeout":
      return { text: `Checking transaction ${info.txHash ?? ""}…`, info };
    default:
      return { text: info.message, info };
  }
}

/**
 * Settle a write without resubmitting: a local polling timeout is `pending`,
 * so resume by hash instead of sending a second transaction.
 */
export async function settle(client: CircleUpClient, result: TxResult): Promise<TxLifecycle> {
  let state = txLifecycleFromResult(result);
  if (state.state === "pending" || state.state === "submitted" || state.state === "unavailable") {
    if (!state.txHash) return state;
    const validUntil = isTxFailure(result) ? result.diagnostics?.validUntil : undefined;
    // Resume polling after the original budget ran out (no new signature).
    state = txLifecycleFromResult(await client.waitForTransaction(state.txHash, { validUntil }));
    if (state.state === "unavailable" && state.txHash) {
      state = txLifecycleFromLookup(await client.lookupTransaction(state.txHash), {
        txHash: state.txHash,
        validUntil,
      });
    }
  }
  return state;
}

/** Writes never resend a new transaction automatically; reads retry a bounded number of times. */
export const sendRetries = RETRY_POLICY.submission.retries; // "same_envelope"
