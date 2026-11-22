// ─── Network constants shared across all CircleUp packages ───────────────────

export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const MAINNET_RPC_URL = "https://soroban-mainnet.stellar.org";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Stellar Friendbot endpoint (testnet only) */
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

/** 1 USDC = 10,000,000 stroops (7 decimal places) */
export const USDC_DECIMALS = 7;
export const STROOPS_PER_USDC = 10_000_000;

/** Minimum members in a circle (enforced by contract). */
export const CONTRACT_MIN_MEMBERS = 2;
export const MIN_MEMBERS = CONTRACT_MIN_MEMBERS;

/** Architectural ceiling for member count in smart contracts (contracts/circle/src/lib.rs). */
export const CONTRACT_MAX_MEMBERS = 256;
export const MAX_MEMBERS = CONTRACT_MAX_MEMBERS;

/** Advisory UI product limit: practical circles keep rotation under 20 members for usability. */
export const APP_MAX_MEMBERS = 20;

/** Minimum round deadline in ledgers (~8.3 min @ 5s/ledger) (contracts/circle/src/lib.rs). */
export const MIN_ROUND_DEADLINE_LEDGERS = 100;

/** Maximum round deadline in ledgers (~60 days @ 5s/ledger) (contracts/circle/src/lib.rs). */
export const MAX_ROUND_DEADLINE_LEDGERS = 1_036_800;

/** Collateral multiplier: required collateral = round_amount * COLLATERAL_MULTIPLIER. */
export const COLLATERAL_MULTIPLIER = 1;

/** Approximate ledgers per day at ~5 seconds per ledger */
export const LEDGERS_PER_DAY = 17_280;
export const LEDGERS_PER_WEEK = LEDGERS_PER_DAY * 7;
export const LEDGERS_PER_MONTH = LEDGERS_PER_DAY * 30;

/** Default penalty for a missed contribution: 20% of collateral */
export const DEFAULT_PENALTY_BPS = 2_000; // 20%
export const PENALTY_BPS = DEFAULT_PENALTY_BPS;
export const BPS_DENOM = 10_000;

/**
 * Page-size bounds of the indexer's paged list endpoints (mirrors
 * DEFAULT_LIMIT / MAX_LIMIT in indexer/src/api.ts). `IndexerClient` rejects a
 * `limit` outside `1..INDEXER_MAX_PAGE_SIZE` before sending the request.
 */
export const INDEXER_DEFAULT_PAGE_SIZE = 20;
export const INDEXER_MAX_PAGE_SIZE = 100;

/**
 * Largest page `CircleFactory.get_circles_paginated` returns (mirrors
 * `circle_factory::MAX_PAGE_SIZE`). Larger limits are clamped on-chain.
 */
export const FACTORY_MAX_PAGE_SIZE = 50;

// ─── Protocol Parameter Inventory (#885) ──────────────────────────────────────

export type ParameterEnforcingLayer =
  | "contract-authoritative"
  | "display-only"
  | "operational-configuration"
  | "advisory-client";

export interface ProtocolParameterDefinition {
  id: string;
  name: string;
  description: string;
  enforcingLayer: ParameterEnforcingLayer;
  contractSource?: {
    crate: string;
    file: string;
    symbol: string;
    value: string | number;
  };
  clientMirror?: {
    pkg: string;
    symbol: string;
    value: string | number;
  };
  changeProcess: string;
}

export const PROTOCOL_PARAMETERS_INVENTORY: readonly ProtocolParameterDefinition[] = [
  {
    id: "max_members",
    name: "Maximum Circle Members",
    description: "Hard upper bound on the number of members allowed in a single circle contract.",
    enforcingLayer: "contract-authoritative",
    contractSource: {
      crate: "circle",
      file: "contracts/circle/src/lib.rs",
      symbol: "MAX_MEMBERS",
      value: 256,
    },
    clientMirror: {
      pkg: "sdk",
      symbol: "CONTRACT_MAX_MEMBERS",
      value: 256,
    },
    changeProcess: "Smart contract upgrade and migration. Requires verifying storage gas and transaction footprint limits.",
  },
  {
    id: "app_max_members",
    name: "Application Advisory Member Ceiling",
    description: "Deliberate UI UX ceiling for human ROSCA coordination and mobile rendering usability.",
    enforcingLayer: "advisory-client",
    clientMirror: {
      pkg: "app",
      symbol: "MAX_MEMBERS",
      value: 20,
    },
    changeProcess: "Frontend product review and release cycle; strictly advisory to contract ceiling of 256.",
  },
  {
    id: "min_members",
    name: "Minimum Circle Members",
    description: "Minimum number of participants required to initialize a peer ROSCA circle.",
    enforcingLayer: "contract-authoritative",
    contractSource: {
      crate: "circle",
      file: "contracts/circle/src/lib.rs",
      symbol: "MIN_MEMBERS",
      value: 2,
    },
    clientMirror: {
      pkg: "sdk",
      symbol: "CONTRACT_MIN_MEMBERS",
      value: 2,
    },
    changeProcess: "Contract upgrade.",
  },
  {
    id: "min_round_deadline_ledgers",
    name: "Minimum Round Deadline Window",
    description: "Minimum duration in ledgers before a contribution window can expire (~8.3 min @ 5s/ledger).",
    enforcingLayer: "contract-authoritative",
    contractSource: {
      crate: "circle",
      file: "contracts/circle/src/lib.rs",
      symbol: "MIN_ROUND_DEADLINE_LEDGERS",
      value: 100,
    },
    clientMirror: {
      pkg: "sdk",
      symbol: "MIN_ROUND_DEADLINE_LEDGERS",
      value: 100,
    },
    changeProcess: "Contract parameter governance / redeployment.",
  },
  {
    id: "max_round_deadline_ledgers",
    name: "Maximum Round Deadline Window",
    description: "Maximum allowable contribution deadline (~60 days @ 5s/ledger).",
    enforcingLayer: "contract-authoritative",
    contractSource: {
      crate: "circle",
      file: "contracts/circle/src/lib.rs",
      symbol: "MAX_ROUND_DEADLINE_LEDGERS",
      value: 1_036_800,
    },
    clientMirror: {
      pkg: "sdk",
      symbol: "MAX_ROUND_DEADLINE_LEDGERS",
      value: 1_036_800,
    },
    changeProcess: "Contract parameter governance / redeployment.",
  },
  {
    id: "collateral_multiplier",
    name: "Collateral Requirement Multiplier",
    description: "Multiple of round contribution amount required as upfront member security deposit.",
    enforcingLayer: "contract-authoritative",
    contractSource: {
      crate: "circle",
      file: "contracts/circle/src/lib.rs",
      symbol: "COLLATERAL_MULTIPLIER",
      value: 1,
    },
    clientMirror: {
      pkg: "sdk",
      symbol: "COLLATERAL_MULTIPLIER",
      value: 1,
    },
    changeProcess: "Contract upgrade and risk model review.",
  },
  {
    id: "penalty_bps",
    name: "Default Penalty Basis Points",
    description: "Basis points deducted from member collateral on default (2,000 BPS = 20%).",
    enforcingLayer: "contract-authoritative",
    contractSource: {
      crate: "circle",
      file: "contracts/circle/src/lib.rs",
      symbol: "PENALTY_BPS",
      value: 2_000,
    },
    clientMirror: {
      pkg: "sdk",
      symbol: "DEFAULT_PENALTY_BPS",
      value: 2_000,
    },
    changeProcess: "Contract upgrade and economic parameter review.",
  },
  {
    id: "bps_denom",
    name: "Basis Points Denominator",
    description: "Canonical denominator for basis points calculation (10,000 = 100%).",
    enforcingLayer: "contract-authoritative",
    contractSource: {
      crate: "circle",
      file: "contracts/circle/src/lib.rs",
      symbol: "BPS_DENOM",
      value: 10_000,
    },
    clientMirror: {
      pkg: "sdk",
      symbol: "BPS_DENOM",
      value: 10_000,
    },
    changeProcess: "Mathematical invariant across finance protocols; immutable.",
  },
  {
    id: "usdc_decimals",
    name: "USDC Token Precision",
    description: "Decimal places for Stellar USDC / token contracts (7 decimals = 10,000,000 stroops per token).",
    enforcingLayer: "contract-authoritative",
    clientMirror: {
      pkg: "sdk",
      symbol: "USDC_DECIMALS",
      value: 7,
    },
    changeProcess: "Fixed by Stellar classic asset precision standard (1 stroop = 10^-7 USDC).",
  },
  {
    id: "factory_max_page_size",
    name: "Factory Registry Page Size Ceiling",
    description: "Maximum items returned in a single page by CircleFactory.get_circles_paginated.",
    enforcingLayer: "contract-authoritative",
    contractSource: {
      crate: "circle_factory",
      file: "contracts/circle_factory/src/registry.rs",
      symbol: "MAX_PAGE_SIZE",
      value: 50,
    },
    clientMirror: {
      pkg: "sdk",
      symbol: "FACTORY_MAX_PAGE_SIZE",
      value: 50,
    },
    changeProcess: "Factory contract upgrade, bounded by Soroban transaction read gas.",
  },
  {
    id: "indexer_max_page_size",
    name: "Indexer API Page Limit Ceiling",
    description: "Maximum records returned in a single REST request by indexer endpoints.",
    enforcingLayer: "operational-configuration",
    clientMirror: {
      pkg: "sdk",
      symbol: "INDEXER_MAX_PAGE_SIZE",
      value: 100,
    },
    changeProcess: "Indexer API configuration and deployment.",
  },
] as const;

// ─── Network config helpers ───────────────────────────────────────────────────

/** Identifies which Stellar network to target. */
export type NetworkName = "testnet" | "mainnet";

/**
 * All the network-level constants needed to initialise an RPC client or build
 * a `CircleUpConfig`.  Prefer using `getNetworkConfig` over hard-coding these
 * values directly so callers get a clear error when an unsupported network is
 * requested.
 */
export interface NetworkConfig {
  network: NetworkName;
  rpcUrl: string;
  passphrase: string;
  /**
   * Friendbot URL for funding accounts.  Only available on testnet; `null` on
   * mainnet so callers can branch without an extra network check.
   */
  friendbotUrl: string | null;
}

const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    network: "testnet",
    rpcUrl: TESTNET_RPC_URL,
    passphrase: TESTNET_PASSPHRASE,
    friendbotUrl: FRIENDBOT_URL,
  },
  mainnet: {
    network: "mainnet",
    rpcUrl: MAINNET_RPC_URL,
    passphrase: MAINNET_PASSPHRASE,
    friendbotUrl: null,
  },
};

/**
 * Return the `NetworkConfig` for the requested network.
 *
 * Throws a descriptive `Error` when an unrecognised network name is passed so
 * misconfigured callers get an explicit message rather than a silent `undefined`
 * access downstream.
 *
 * @example
 * const cfg = getNetworkConfig("testnet");
 * const rpc = new SorobanRpc.Server(cfg.rpcUrl);
 */
export function getNetworkConfig(network: NetworkName): NetworkConfig {
  const cfg = NETWORK_CONFIGS[network];
  if (!cfg) {
    const valid = Object.keys(NETWORK_CONFIGS).join(", ");
    throw new Error(
      `Unknown network "${network}". Valid options are: ${valid}.`,
    );
  }
  return cfg;
}

/**
 * Return `true` when the given string is a recognised `NetworkName`.
 * Useful for validating user input or environment variable values before
 * calling `getNetworkConfig`.
 *
 * @example
 * const raw = process.env.NETWORK ?? "";
 * if (!isValidNetwork(raw)) throw new Error(`Invalid NETWORK env var: "${raw}"`);
 * const cfg = getNetworkConfig(raw);
 */
export function isValidNetwork(value: string): value is NetworkName {
  return value === "testnet" || value === "mainnet";
}

// ─── Network identity (issue #903) ────────────────────────────────────────────
//
// A client's network identity is the pair (network name, passphrase). The
// passphrase is what a signature commits to, so it is the only thing that
// decides which network a transaction belongs to; the RPC URL is merely where
// requests are sent.
//
// Validation rule:
//
// | `network`               | `networkPassphrase` must be             | Notes |
// |-------------------------|-----------------------------------------|-------|
// | omitted                 | a preset passphrase (testnet / mainnet) | Name is resolved from the passphrase — never from the URL. |
// | `"testnet"`/`"mainnet"` | exactly that preset's passphrase        | A mismatch is rejected. |
// | `"custom"`              | a non-empty, non-preset passphrase      | Custom networks need the URL and passphrase supplied together. |
//
// In every case `rpcUrl` is required. An RPC URL that exactly matches a
// *different* preset's public endpoint is rejected as inconsistent, but a URL
// is never accepted as proof of identity on its own: an unknown URL is allowed
// for any network, and identity still comes from the passphrase.
//
// Explorer links are only produced for preset networks; a custom network has
// `explorerNetwork: null`, so `getExplorerLink` callers render plain text.

/** Network name accepted in `CircleUpConfig.network`. `"custom"` opts into a non-preset passphrase. */
export type ConfiguredNetworkName = NetworkName | "custom";

/** The validated, read-only network identity a client is bound to. */
export interface NetworkIdentity {
  /** Preset name, or `"custom"` for an explicitly configured network. */
  readonly network: ConfiguredNetworkName;
  /** Passphrase every transaction built by the client commits to. */
  readonly passphrase: string;
  /** RPC endpoint requests are sent to. Not part of the identity proof. */
  readonly rpcUrl: string;
  /** `true` when `network` is one of the named presets. */
  readonly preset: boolean;
  /** Network to pass to {@link getExplorerLink}; `null` for custom networks (no public explorer). */
  readonly explorerNetwork: NetworkName | null;
}

/** The subset of `CircleUpConfig` that determines network identity. */
export interface NetworkIdentityInput {
  network?: unknown;
  networkPassphrase?: unknown;
  rpcUrl?: unknown;
}

function presetForPassphrase(passphrase: string): NetworkName | undefined {
  return (Object.keys(NETWORK_CONFIGS) as NetworkName[]).find(
    (name) => NETWORK_CONFIGS[name].passphrase === passphrase,
  );
}

function presetForRpcUrl(rpcUrl: string): NetworkName | undefined {
  const normalised = rpcUrl.trim().replace(/\/+$/, "").toLowerCase();
  return (Object.keys(NETWORK_CONFIGS) as NetworkName[]).find(
    (name) => NETWORK_CONFIGS[name].rpcUrl.toLowerCase() === normalised,
  );
}

/**
 * Check a network name / passphrase / RPC URL combination against the rule
 * above and return every problem found (empty when consistent). Does not
 * check URL syntax — `validateCircleUpConfig` does that.
 */
export function networkIdentityErrors(input: NetworkIdentityInput): string[] {
  const errors: string[] = [];
  const { network, networkPassphrase, rpcUrl } = input;

  if (network !== undefined && network !== "testnet" && network !== "mainnet" && network !== "custom") {
    errors.push(
      `config.network ${JSON.stringify(network)} is not supported. Use "testnet", "mainnet", or "custom".`,
    );
    return errors;
  }
  if (typeof networkPassphrase !== "string" || networkPassphrase.trim() === "") {
    // Reported by validateCircleUpConfig with its own message.
    return errors;
  }

  const passphrasePreset = presetForPassphrase(networkPassphrase);
  if (network === "custom") {
    if (passphrasePreset) {
      errors.push(
        `config.network is "custom" but config.networkPassphrase is the ${passphrasePreset} passphrase. ` +
          `Use network: "${passphrasePreset}" for the preset network.`,
      );
    }
    if (typeof rpcUrl !== "string" || rpcUrl.trim() === "") {
      errors.push('config.network "custom" requires config.rpcUrl and config.networkPassphrase to be supplied together.');
    }
  } else if (network === "testnet" || network === "mainnet") {
    if (networkPassphrase !== NETWORK_CONFIGS[network].passphrase) {
      errors.push(
        `config.networkPassphrase does not match config.network "${network}". ` +
          `Expected ${JSON.stringify(NETWORK_CONFIGS[network].passphrase)}.`,
      );
    }
  } else if (!passphrasePreset) {
    errors.push(
      `config.networkPassphrase ${JSON.stringify(networkPassphrase)} is not recognised. ` +
        `Expected one of: ${(Object.keys(NETWORK_CONFIGS) as NetworkName[])
          .map((n) => JSON.stringify(NETWORK_CONFIGS[n].passphrase))
          .join(", ")}, or set config.network to "custom" for a custom network.`,
    );
  }

  // A preset's public endpoint paired with another network's passphrase would
  // build for one network and send to another.
  const resolved = network === "custom" ? undefined : (network as NetworkName | undefined) ?? passphrasePreset;
  const urlPreset = typeof rpcUrl === "string" ? presetForRpcUrl(rpcUrl) : undefined;
  if (urlPreset && (network === "custom" || (resolved !== undefined && urlPreset !== resolved))) {
    errors.push(
      `config.rpcUrl is the public ${urlPreset} endpoint but the configured network is ` +
        `${network === "custom" ? "custom" : resolved}. Use a matching RPC URL and passphrase.`,
    );
  }
  return errors;
}

/**
 * Resolve and validate a client's network identity.
 *
 * Identity always comes from the explicit `network` name and the passphrase,
 * never from the RPC URL. The result is frozen.
 *
 * @throws `Error` listing every inconsistency (see the rule table above).
 *
 * @example
 * resolveNetworkIdentity({ rpcUrl: TESTNET_RPC_URL, networkPassphrase: TESTNET_PASSPHRASE });
 *   // → { network: "testnet", preset: true, explorerNetwork: "testnet", … }
 * resolveNetworkIdentity({ network: "custom", rpcUrl: "http://localhost:8000/rpc",
 *   networkPassphrase: "Standalone Network ; February 2017" });
 *   // → { network: "custom", preset: false, explorerNetwork: null, … }
 */
export function resolveNetworkIdentity(input: NetworkIdentityInput): NetworkIdentity {
  const errors = networkIdentityErrors(input);
  if (typeof input.networkPassphrase !== "string" || input.networkPassphrase.trim() === "") {
    errors.push("config.networkPassphrase is required.");
  }
  if (typeof input.rpcUrl !== "string" || input.rpcUrl.trim() === "") {
    if (!errors.some((e) => e.includes("config.rpcUrl"))) errors.push("config.rpcUrl is required.");
  }
  if (errors.length > 0) {
    throw new Error(`Inconsistent network configuration:\n${errors.map((e) => `  • ${e}`).join("\n")}`);
  }
  const passphrase = input.networkPassphrase as string;
  const network: ConfiguredNetworkName =
    input.network === "custom" ? "custom" : ((input.network as NetworkName | undefined) ?? presetForPassphrase(passphrase)!);
  const preset = network !== "custom";
  return Object.freeze({
    network,
    passphrase,
    rpcUrl: input.rpcUrl as string,
    preset,
    explorerNetwork: preset ? network : null,
  });
}

// ─── Block explorer links ─────────────────────────────────────────────────────

/** Host prefix shared by every Stellar Expert explorer URL. */
export const EXPLORER_BASE_URL = "https://stellar.expert/explorer";

/**
 * The kinds of on-chain entity a block explorer link can point at.  These map
 * directly onto Stellar Expert's URL path segments (`/tx/…`, `/account/…`,
 * `/contract/…`).
 */
export type ExplorerEntityType = "tx" | "account" | "contract";

/**
 * Stellar Expert's URL path segment for each supported network.
 *
 * Note the mainnet segment is `public`, **not** `mainnet` — Stellar Expert
 * names the mainnet network "public".  Getting this wrong silently points every
 * mainnet link at a non-existent (or worse, testnet) page, so the mapping is
 * centralised here rather than string-built at each call site.
 */
const EXPLORER_NETWORK_SEGMENT: Record<NetworkName, string> = {
  testnet: "testnet",
  mainnet: "public",
};

/**
 * Build a Stellar Expert explorer URL for a transaction, account, or contract
 * on a given network.
 *
 * The returned link always matches the requested network (mainnet correctly
 * maps to Stellar Expert's `public` segment).  The identifier is URL-encoded so
 * a value containing slashes, spaces, or other path characters can never break
 * out of the intended path.
 *
 * Returns `null` — a safe "non-link" result the caller can render as plain text
 * instead of an anchor — when:
 *   - `network` is not a supported {@link NetworkName} (e.g. a custom/standalone
 *     network for which no public explorer exists), or
 *   - `identifier` is empty or whitespace-only (there is nothing to link to).
 *
 * @param network     Target network name. Unknown values yield `null`.
 * @param type        The entity kind: `"tx"`, `"account"`, or `"contract"`.
 * @param identifier  The transaction hash / account / contract address.
 * @returns           A fully-qualified explorer URL, or `null` when no safe
 *                    link can be produced.
 *
 * @example
 * getExplorerLink("testnet", "tx", hash)
 *   // → "https://stellar.expert/explorer/testnet/tx/<hash>"
 * getExplorerLink("mainnet", "account", "GABC…")
 *   // → "https://stellar.expert/explorer/public/account/GABC…"
 * getExplorerLink("standalone", "tx", hash) // → null
 * getExplorerLink("testnet", "tx", "")      // → null
 */
export function getExplorerLink(
  network: string,
  type: ExplorerEntityType,
  identifier: string,
): string | null {
  if (!isValidNetwork(network)) return null;

  const trimmed = typeof identifier === "string" ? identifier.trim() : "";
  if (trimmed === "") return null;

  const segment = EXPLORER_NETWORK_SEGMENT[network];
  return `${EXPLORER_BASE_URL}/${segment}/${type}/${encodeURIComponent(trimmed)}`;
}
