/**
 * networkGuard.ts — Network identity validation for shareable circle URLs
 *
 * # Problem
 *
 * CircleUp runs against different Stellar networks depending on the deployment
 * (testnet for development, mainnet for production).  A circle address is a
 * Soroban contract ID — it is valid on every network, so the URL
 *   /circles/CAAA...
 * carries no inherent network signal.  If a link is shared between deployments
 * the browser could silently load circle data from the wrong indexer, display
 * wrong USDC amounts, or generate explorer links pointing at the wrong network.
 *
 * # Strategy (single-origin, config-driven)
 *
 * CircleUp uses a *deployment-origin* model: each deployment is locked to
 * exactly one network via environment variables set at build time
 * (NEXT_PUBLIC_NETWORK_PASSPHRASE).  The network is not encoded in circle
 * URLs — the deployment itself is the network selector.
 *
 * Shareable circle URLs therefore look like:
 *   https://app.circleup.xyz/circles/CAAA...          ← mainnet deployment
 *   https://testnet.circleup.xyz/circles/CAAA...      ← testnet deployment
 *
 * A link opened on the wrong deployment will either:
 *   a) 404 (the circle address doesn't exist on that indexer), or
 *   b) show data from that deployment's network — which is always clearly
 *      labelled in the UI via ACTIVE_NETWORK.
 *
 * # What this module adds
 *
 * Some entry points (future deep-link schemes, OAuth redirects, or admin tools)
 * may accept an explicit `network` query/path parameter to allow cross-network
 * navigation from a single host.  When that parameter is present it MUST be
 * validated against a strict allowlist before any data access, and it MUST
 * agree with the deployment's configured network — an address alone must never
 * silently select a different network.
 *
 * This module provides:
 *   - `SUPPORTED_NETWORKS`   — the exhaustive allowlist of recognised networks
 *   - `validateNetworkParam` — validates & normalises an untrusted network string
 *   - `assertNetworkMatch`   — asserts that a validated network param agrees
 *                              with the deployment's active network
 *   - `resolveNetworkForUrl` — full pipeline: validate → match → return or throw
 *   - `NetworkValidationError` — typed error thrown by the above functions
 *
 * # Usage in page code
 *
 * ```ts
 * import { resolveNetworkForUrl } from "@/lib/networkGuard";
 * import { ACTIVE_NETWORK } from "@/lib/config";
 *
 * // In a Next.js page that accepts ?network=testnet
 * const network = resolveNetworkForUrl(searchParams.get("network"), ACTIVE_NETWORK);
 * // network is now a validated NetworkName — safe to pass to getExplorerLink()
 * ```
 *
 * If `resolveNetworkForUrl` throws a `NetworkValidationError` the caller should
 * render an explicit "unsupported network" error rather than silently falling
 * through to the deployment default.
 */

import { isValidNetwork, type NetworkName } from "./config";

// ─── Allowlist ────────────────────────────────────────────────────────────────

/**
 * Exhaustive set of network identifiers CircleUp recognises.
 *
 * Any value NOT in this set must be rejected before it reaches data-access
 * code.  Adding a new network requires an explicit change here and a
 * corresponding deployment profile.
 */
export const SUPPORTED_NETWORKS: ReadonlySet<NetworkName> = new Set([
  "testnet",
  "mainnet",
]);

// ─── Error type ───────────────────────────────────────────────────────────────

/**
 * Thrown by network-validation helpers when an untrusted network string fails
 * validation.  Distinct from generic `Error` so callers can branch on the
 * specific failure reason without inspecting message strings.
 */
export class NetworkValidationError extends Error {
  /**
   * Machine-readable reason code so callers can produce different UI messages
   * for different failure modes.
   *
   * `"unsupported_value"` — the string is not in SUPPORTED_NETWORKS.
   * `"deployment_mismatch"` — the value is recognised but disagrees with the
   *                           deployment's configured network.
   * `"empty"` — the parameter was present but blank.
   */
  readonly reason:
    | "unsupported_value"
    | "deployment_mismatch"
    | "empty";

  /**
   * The raw untrusted value that triggered the error (may be undefined when
   * the parameter was missing entirely).  Useful for logging.
   */
  readonly rawValue: string | undefined;

  constructor(
    reason: NetworkValidationError["reason"],
    rawValue: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "NetworkValidationError";
    this.reason = reason;
    this.rawValue = rawValue;
  }
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Validate and normalise an untrusted network string from a query or path
 * parameter against the strict {@link SUPPORTED_NETWORKS} allowlist.
 *
 * Returns the validated {@link NetworkName} on success.
 * Throws {@link NetworkValidationError} when:
 *   - `raw` is `null` or `undefined` (missing parameter) — returns `null`
 *     instead of throwing, so callers can distinguish "not provided" from
 *     "provided but invalid".
 *   - `raw` is blank after trimming — reason `"empty"`.
 *   - `raw` is not in `SUPPORTED_NETWORKS` — reason `"unsupported_value"`.
 *
 * An absent parameter (`null`/`undefined`) returns `null` without throwing,
 * allowing callers to treat it as "use deployment default".
 *
 * @example
 * validateNetworkParam("testnet")   // → "testnet"
 * validateNetworkParam("MAINNET")   // → "mainnet"  (normalised to lowercase)
 * validateNetworkParam("")          // throws NetworkValidationError("empty")
 * validateNetworkParam("stagenet")  // throws NetworkValidationError("unsupported_value")
 * validateNetworkParam(null)        // → null  (parameter absent)
 */
export function validateNetworkParam(
  raw: string | null | undefined,
): NetworkName | null {
  // Absent parameter → caller uses deployment default
  if (raw === null || raw === undefined) return null;

  const trimmed = raw.trim();

  if (trimmed === "") {
    throw new NetworkValidationError(
      "empty",
      raw,
      `Network parameter is present but blank. ` +
        `Omit the parameter to use the deployment default, or provide one of: ` +
        `${[...SUPPORTED_NETWORKS].join(", ")}.`,
    );
  }

  // Normalise to lowercase before allowlist check so "Testnet", "MAINNET", etc.
  // are accepted.  The network name is a simple ASCII identifier so toLowerCase
  // is safe without locale considerations.
  const lower = trimmed.toLowerCase();

  if (!isValidNetwork(lower)) {
    throw new NetworkValidationError(
      "unsupported_value",
      raw,
      `"${trimmed}" is not a supported network. ` +
        `Supported values: ${[...SUPPORTED_NETWORKS].join(", ")}. ` +
        `An address alone can never select a network implicitly.`,
    );
  }

  return lower;
}

/**
 * Assert that a validated network parameter agrees with the deployment's
 * active network.
 *
 * A circle URL that explicitly names a network different from the current
 * deployment must never silently load data from the wrong indexer — instead
 * the caller must present a clear "wrong network" message.
 *
 * @param requested  A validated {@link NetworkName} from {@link validateNetworkParam}.
 * @param deploymentNetwork  The deployment's active network (typically
 *   `ACTIVE_NETWORK` from `lib/config.ts`).  When this is `"custom"` (a
 *   private or standalone chain) the check is skipped because there is no
 *   canonical passphrase to compare against.
 *
 * @throws {@link NetworkValidationError} with reason `"deployment_mismatch"` when
 *   `requested !== deploymentNetwork` and `deploymentNetwork` is a recognised
 *   public network.
 *
 * @example
 * // Deployment is testnet, URL says ?network=mainnet → throws
 * assertNetworkMatch("mainnet", "testnet");
 *
 * // Same network → no-op
 * assertNetworkMatch("testnet", "testnet");
 *
 * // Private chain → skip check
 * assertNetworkMatch("testnet", "custom");
 */
export function assertNetworkMatch(
  requested: NetworkName,
  deploymentNetwork: string,
): void {
  // Custom / private networks have no canonical passphrase — skip the check
  // so operators on standalone chains aren't blocked.
  if (deploymentNetwork === "custom") return;

  if (requested !== deploymentNetwork) {
    throw new NetworkValidationError(
      "deployment_mismatch",
      requested,
      `The URL requests network "${requested}" but this deployment is configured ` +
        `for "${deploymentNetwork}". ` +
        `To view this circle on "${requested}", open the correct deployment origin. ` +
        `An address alone never silently selects a different network.`,
    );
  }
}

/**
 * Full validation pipeline for an untrusted network parameter.
 *
 * Combines {@link validateNetworkParam} and {@link assertNetworkMatch}:
 *   1. If `rawParam` is absent (`null`/`undefined`), return `deploymentNetwork`
 *      (the deployment default) — no explicit choice, no mismatch possible.
 *   2. Validate `rawParam` against the allowlist.
 *   3. Assert it agrees with `deploymentNetwork`.
 *   4. Return the validated {@link NetworkName}.
 *
 * Callers that catch a `NetworkValidationError` should render an explicit
 * error page rather than falling back to a silent default.
 *
 * @param rawParam  The untrusted value from `searchParams.get("network")` or
 *   a path segment.
 * @param deploymentNetwork  The active network for this deployment, e.g.
 *   `ACTIVE_NETWORK` from `lib/config.ts`.
 *
 * @returns A validated `NetworkName` that is safe to pass to
 *   `getExplorerLink()` and data-access functions.
 *
 * @throws `NetworkValidationError` on any validation failure.
 *
 * @example
 * // Page handler
 * try {
 *   const network = resolveNetworkForUrl(searchParams.get("network"), ACTIVE_NETWORK);
 *   // ... use network
 * } catch (err) {
 *   if (err instanceof NetworkValidationError) {
 *     return <NetworkErrorPage reason={err.reason} />;
 *   }
 *   throw err;
 * }
 */
export function resolveNetworkForUrl(
  rawParam: string | null | undefined,
  deploymentNetwork: string,
): NetworkName {
  // Absent parameter → use deployment default
  const validated = validateNetworkParam(rawParam);
  if (validated === null) {
    // deploymentNetwork comes from the build-time env — it is already a trusted
    // value.  If it is not a recognised network name (e.g. "custom") return the
    // closest sensible default.  Pages that need an exact NetworkName for
    // explorer links will receive null from getExplorerLink() gracefully.
    if (isValidNetwork(deploymentNetwork)) {
      return deploymentNetwork;
    }
    // Private/custom network — fall back to testnet as a safe display default
    // (explorer links will return null anyway for "custom").
    return "testnet";
  }

  // Explicit parameter — must agree with deployment
  assertNetworkMatch(validated, deploymentNetwork);
  return validated;
}

// ─── URL strategy documentation (exported constants) ─────────────────────────
//
// These constants are exported for use in diagnostic panels and developer docs
// so the strategy is defined in one place and never copy-pasted.

/**
 * Human-readable summary of CircleUp's URL network strategy.
 * Exported for use in diagnostic displays and developer documentation.
 */
export const NETWORK_URL_STRATEGY = [
  "CircleUp uses a deployment-origin model: each deployment is locked to one network.",
  "Circle URLs do not encode a network — the deployment origin IS the network selector.",
  "Shareable circle links should reference the deployment-specific origin (e.g. testnet.circleup.xyz vs app.circleup.xyz).",
  "An explicit ?network= parameter is validated against the deployment's configured network and rejected if mismatched.",
  "An address alone never silently selects mainnet or testnet.",
] as const;
