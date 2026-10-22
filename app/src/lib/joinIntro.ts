/**
 * Join introduction content model.
 *
 * Produces the advisory content shown to a prospective member on the circle
 * detail page before they open their wallet. Content is lifecycle-aware and
 * purely informational — it never implies that the displayed state is a final
 * contract guarantee, and it defers to the existing gating layer for actual
 * eligibility decisions.
 *
 * Design constraints:
 *   - Pure: no I/O, no React, no DOM. Safe to call from tests or the server.
 *   - Advisory only: every entry has a `guaranteeNote` reminding callers to
 *     treat the content as indexed state, not on-chain proof.
 *   - No second join path: the component that renders this must reuse the
 *     existing `doAction("join", ...)` flow from CircleDetailClient.
 */

import type { CircleApiStatus } from "./circleTypes";

// ─── Wallet prerequisite model ────────────────────────────────────────────────

export interface WalletPrerequisite {
  /** Short label for display. */
  readonly label: string;
  /** Whether the prerequisite is currently satisfied. */
  readonly met: boolean;
  /** User-facing explanation of what's needed. */
  readonly guidance: string;
  /** Link to external setup guidance, or null. */
  readonly setupUrl: string | null;
}

// ─── Join intro content ───────────────────────────────────────────────────────

export type JoinIntroVariant =
  | "pending_open"       // circle is Pending, member hasn't joined
  | "pending_joined"     // circle is Pending, member has already joined
  | "pending_full"       // circle is Pending but all slots taken
  | "active"             // circle is Active — joining is closed
  | "completed"          // circle finished — no joining
  | "cancelled"          // circle cancelled — no joining
  | "closed"             // circle closed — no joining
  | "unknown";           // status not recognised

export interface JoinIntroContent {
  /** Variant that produced this content — used by the UI for visual styling. */
  readonly variant: JoinIntroVariant;
  /** One-line heading. */
  readonly heading: string;
  /** Supporting paragraph(s). */
  readonly body: string;
  /**
   * Fixed advisory note reminding users that the displayed eligibility state
   * is derived from indexed data, not a final contract check.
   */
  readonly guaranteeNote: string;
  /** Whether the "Join" action should be presented as available. */
  readonly joinAvailable: boolean;
  /** Wallet prerequisites the user must satisfy before joining. */
  readonly prerequisites: WalletPrerequisite[];
}

// ─── Advisory note (single source of truth) ──────────────────────────────────

const ADVISORY_NOTE =
  "This status is derived from indexed data and may lag the chain by one or " +
  "more ledgers. The contract is the authoritative source — your wallet will " +
  "simulate the transaction before you sign, and the final eligibility check " +
  "happens on-chain.";

// ─── Content factory ──────────────────────────────────────────────────────────

export interface JoinIntroInput {
  /** Current circle lifecycle status from the indexer. */
  readonly status: CircleApiStatus | string;
  /** How many members have already joined (i.e., locked collateral). */
  readonly joinedCount: number;
  /** Total member slots in this circle. */
  readonly memberCount: number;
  /** Per-member round contribution in stroops (string-serialised). */
  readonly roundAmountStroops: string;
  /** Whether the connected wallet address is already a member. */
  readonly isMember: boolean;
  /** Wallet connection state. */
  readonly walletState: "loading" | "not_installed" | "disconnected" | "connected";
  /** Active Stellar network name, e.g. "testnet" or "mainnet". */
  readonly networkName: string;
  /** Whether a network mismatch has been detected. */
  readonly networkMismatch: boolean;
}

/**
 * Build the join introduction content for the given circle and wallet state.
 *
 * Returns an advisory-only result — never promise that a join will succeed.
 */
export function buildJoinIntroContent(input: JoinIntroInput): JoinIntroContent {
  const {
    status,
    joinedCount,
    memberCount,
    roundAmountStroops,
    isMember,
    walletState,
    networkName,
    networkMismatch,
  } = input;

  const prerequisites = buildPrerequisites(walletState, networkName, networkMismatch);

  switch (status) {
    case "Pending": {
      const slotsRemaining = Math.max(0, memberCount - joinedCount);
      const isFull = slotsRemaining === 0;

      if (isFull && !isMember) {
        return {
          variant: "pending_full",
          heading: "This circle is full",
          body:
            `All ${memberCount} member slots are taken. You cannot join this ` +
            "circle. Browse other circles to find one with open slots.",
          guaranteeNote: ADVISORY_NOTE,
          joinAvailable: false,
          prerequisites,
        };
      }

      if (isMember) {
        return {
          variant: "pending_joined",
          heading: "You have joined — waiting for the circle to start",
          body:
            "Your collateral is locked on-chain. The circle activates " +
            "automatically once all " +
            memberCount +
            " members have locked their collateral. " +
            "No further action is needed until the circle goes Active.",
          guaranteeNote: ADVISORY_NOTE,
          joinAvailable: false,
          prerequisites: [],
        };
      }

      const collateralUsdc = formatStroops(roundAmountStroops);
      return {
        variant: "pending_open",
        heading: "This circle is accepting members",
        body:
          `${joinedCount} of ${memberCount} members have joined. ` +
          `Joining locks ${collateralUsdc} USDC as collateral from your wallet. ` +
          "The collateral secures your spot in the rotation and covers any penalty " +
          "if you miss a round. It is returned after the circle completes or is closed.",
        guaranteeNote: ADVISORY_NOTE,
        joinAvailable: true,
        prerequisites,
      };
    }

    case "Active":
      return {
        variant: "active",
        heading: "This circle is active — joining is closed",
        body:
          "All members have joined and contribution rounds are in progress. " +
          "New members cannot join an active circle. You can observe the rotation " +
          "and trigger a payout once all contributions for the current round are in.",
        guaranteeNote: ADVISORY_NOTE,
        joinAvailable: false,
        prerequisites: [],
      };

    case "Completed":
      return {
        variant: "completed",
        heading: "This circle has completed",
        body:
          "All rounds paid out successfully. Members can release their collateral " +
          "using the Close action. No further joining or contributions are accepted.",
        guaranteeNote: ADVISORY_NOTE,
        joinAvailable: false,
        prerequisites: [],
      };

    case "Cancelled":
      return {
        variant: "cancelled",
        heading: "This circle was cancelled",
        body:
          "The circle was dissolved before it became active. Members who locked " +
          "collateral can release it using the Close action. No new members can join.",
        guaranteeNote: ADVISORY_NOTE,
        joinAvailable: false,
        prerequisites: [],
      };

    case "Closed":
      return {
        variant: "closed",
        heading: "This circle is closed",
        body:
          "Collateral has been released. The circle is fully settled and no " +
          "further actions are possible.",
        guaranteeNote: ADVISORY_NOTE,
        joinAvailable: false,
        prerequisites: [],
      };

    default:
      return {
        variant: "unknown",
        heading: "Circle status unavailable",
        body:
          "The current status of this circle is not recognised. Refresh the page " +
          "or return to the home page and try again.",
        guaranteeNote: ADVISORY_NOTE,
        joinAvailable: false,
        prerequisites: [],
      };
  }
}

// ─── Prerequisites builder ────────────────────────────────────────────────────

function buildPrerequisites(
  walletState: JoinIntroInput["walletState"],
  networkName: string,
  networkMismatch: boolean,
): WalletPrerequisite[] {
  const prereqs: WalletPrerequisite[] = [];

  // 1. Wallet installed
  prereqs.push({
    label: "Freighter wallet installed",
    met: walletState !== "not_installed",
    guidance:
      walletState === "not_installed"
        ? "Install the Freighter browser extension to sign transactions."
        : "Freighter is installed.",
    setupUrl:
      walletState === "not_installed" ? "https://freighter.app" : null,
  });

  // 2. Wallet connected
  prereqs.push({
    label: "Wallet connected",
    met: walletState === "connected",
    guidance:
      walletState === "connected"
        ? "Your wallet is connected."
        : walletState === "loading"
        ? "Checking wallet connection…"
        : "Connect your wallet using the button in the top-right corner.",
    setupUrl: null,
  });

  // 3. Correct network
  prereqs.push({
    label: `Connected to ${networkName}`,
    met: !networkMismatch,
    guidance: networkMismatch
      ? `Your wallet is on a different network. Switch to ${networkName} in Freighter settings.`
      : `Your wallet is on ${networkName}.`,
    setupUrl: networkMismatch
      ? "https://developers.stellar.org/docs/tools/freighter"
      : null,
  });

  return prereqs;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format stroops as a USDC amount string (no $ symbol). */
function formatStroops(stroops: string): string {
  try {
    const n = BigInt(stroops.trim() || "0");
    if (n < 0n) return "0.00";
    const units = n / 10_000_000n;
    const frac = n % 10_000_000n;
    const fracStr = frac.toString().padStart(7, "0").slice(0, 2);
    return `${units}.${fracStr}`;
  } catch {
    return "0.00";
  }
}
