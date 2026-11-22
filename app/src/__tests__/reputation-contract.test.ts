import { describe, it, expect } from "vitest";
import { parseReputationResponse } from "@/lib/circleTypes";
import { getLevel } from "@/components/ReputationBadge";
import {
  REPUTATION_SOURCE_LABELS,
  getReputationFreshness,
  getReputationScoreState,
  getReputationHistoryState,
} from "@/lib/reputationProvenance";

describe("Reputation Data Contract & Parser Tests", () => {
  describe("parseReputationResponse", () => {
    it("parses valid reputation response with score and events", () => {
      const payload = {
        member: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        found: true,
        score: 15,
        contributions: [
          { circle_address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", contributions: 3, total_rounds: 5 },
        ],
        defaults: [],
        events: [{ type: "tip_received", delta: 5 }],
        updatedAt: "2026-09-29T20:00:00Z",
      };

      const result = parseReputationResponse(payload);
      expect(result).not.toBeNull();
      expect(result?.member).toBe(payload.member);
      expect(result?.found).toBe(true);
      expect(result?.score).toBe(15);
      expect(result?.contributions).toHaveLength(1);
      expect(result?.defaults).toHaveLength(0);
      expect(result?.events).toHaveLength(1);
      expect(result?.updatedAt).toBe("2026-09-29T20:00:00Z");
    });

    it("parses empty/no-record reputation response cleanly", () => {
      const payload = {
        member: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        found: false,
        score: null,
        detail: "Member has no reputation record in the indexer yet.",
        contributions: [],
        defaults: [],
        updatedAt: null,
      };

      const result = parseReputationResponse(payload);
      expect(result).not.toBeNull();
      expect(result?.found).toBe(false);
      expect(result?.score).toBeNull();
      expect(result?.detail).toBe(payload.detail);
      expect(result?.contributions).toEqual([]);
      expect(result?.defaults).toEqual([]);
      expect(result?.updatedAt).toBeNull();
    });

    it("parses explicit zero score reputation response", () => {
      const payload = {
        member: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        found: true,
        score: 0,
        contributions: [],
        defaults: [],
        updatedAt: "2026-09-29T21:00:00Z",
      };

      const result = parseReputationResponse(payload);
      expect(result).not.toBeNull();
      expect(result?.found).toBe(true);
      expect(result?.score).toBe(0);
    });

    it("returns null for malformed payloads", () => {
      // Missing member
      expect(parseReputationResponse({ found: true, score: 5 })).toBeNull();

      // Non-boolean found
      expect(parseReputationResponse({ member: "G123", found: "yes", score: 5 })).toBeNull();

      // Invalid score type (string instead of number or null)
      expect(parseReputationResponse({ member: "G123", found: true, score: "five" })).toBeNull();

      // Non-object payload
      expect(parseReputationResponse("not an object")).toBeNull();
      expect(parseReputationResponse(null)).toBeNull();
    });
  });

  describe("Reputation provenance and freshness states", () => {
    const member = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    it("distinguishes a new member's verified zero score from a failed read", () => {
      const payload = {
        member,
        found: true,
        score: 0,
        contributions: [],
        defaults: [],
        updatedAt: "2026-09-29T21:00:00Z",
      };

      const result = parseReputationResponse(payload);
      expect(result).not.toBeNull();

      const scoreState = getReputationScoreState(result!);
      expect(scoreState.kind).toBe("verified-zero");
      expect(scoreState.label).toBe(REPUTATION_SOURCE_LABELS.onChain);
      expect(scoreState.value).toBe(0);

      const historyState = getReputationHistoryState(result!);
      expect(historyState.kind).toBe("empty");
      expect(historyState.label).toBe(REPUTATION_SOURCE_LABELS.indexer);
    });

    it("renders score and history provenance with current freshness for a member with history", () => {
      const payload = {
        member,
        found: true,
        score: 15,
        contributions: [
          { circle_address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", contributions: 3, total_rounds: 5 },
        ],
        defaults: [],
        events: [{ type: "tip_received", delta: 5 }],
        updatedAt: "2026-09-29T20:00:00Z",
      };

      const result = parseReputationResponse(payload);
      expect(result).not.toBeNull();

      const scoreState = getReputationScoreState(result!);
      expect(scoreState.kind).toBe("verified");
      expect(scoreState.label).toBe(REPUTATION_SOURCE_LABELS.onChain);
      expect(scoreState.value).toBe(15);

      const historyState = getReputationHistoryState(result!);
      expect(historyState.kind).toBe("present");
      expect(historyState.label).toBe(REPUTATION_SOURCE_LABELS.indexer);

      const freshness = getReputationFreshness(result!, new Date("2026-09-29T20:05:00Z"));
      expect(freshness.status).toBe("current");
      expect(freshness.updatedAt).toBe("2026-09-29T20:00:00Z");
      expect(freshness.label).toBe(REPUTATION_SOURCE_LABELS.indexer);
    });

    it("marks delayed indexing as stale and notes history may lag chain", () => {
      const payload = {
        member,
        found: true,
        score: 15,
        contributions: [],
        defaults: [],
        events: [],
        updatedAt: "2026-09-29T18:00:00Z",
      };

      const result = parseReputationResponse(payload);
      expect(result).not.toBeNull();

      const freshness = getReputationFreshness(result!, new Date("2026-09-29T20:00:00Z"));
      expect(freshness.status).toBe("stale");
      expect(freshness.mayLagChain).toBe(true);
      expect(freshness.label).toBe(REPUTATION_SOURCE_LABELS.indexer);

      // Score remains an on-chain read even when the indexer is stale.
      expect(getReputationScoreState(result!).label).toBe(REPUTATION_SOURCE_LABELS.onChain);
    });

    it("represents an unavailable history separately from an empty one", () => {
      const payload = {
        member,
        found: false,
        score: null,
        detail: "Member has no reputation record in the indexer yet.",
        contributions: [],
        defaults: [],
        updatedAt: null,
      };

      const result = parseReputationResponse(payload);
      expect(result).not.toBeNull();

      const historyState = getReputationHistoryState(result!);
      expect(historyState.kind).toBe("unavailable");
      expect(historyState.kind).not.toBe("empty");

      const freshness = getReputationFreshness(result!, new Date("2026-09-29T20:00:00Z"));
      expect(freshness.status).toBe("unavailable");
      expect(freshness.updatedAt).toBeNull();
    });

    it("represents an RPC failure distinctly from a verified zero score", () => {
      const failed = getReputationScoreState(null);

      expect(failed.kind).toBe("unavailable");
      expect(failed.label).toBe(REPUTATION_SOURCE_LABELS.onChain);
      expect(failed.value).toBeNull();
      expect(failed.kind).not.toBe("verified-zero");

      const zero = getReputationScoreState({
        member,
        found: true,
        score: 0,
        contributions: [],
        defaults: [],
        updatedAt: "2026-09-29T21:00:00Z",
      });
      expect(zero.kind).toBe("verified-zero");
      expect(zero.kind).not.toBe(failed.kind);
    });
  });

  describe("Reputation Badge Level mapping", () => {
    it("maps null or undefined score to Unknown level", () => {
      const nullLevel = getLevel(null);
      expect(nullLevel.label).toBe("Unknown");

      const undefinedLevel = getLevel(undefined);
      expect(undefinedLevel.label).toBe("Unknown");
    });

    it("maps 0 score to New level", () => {
      const zeroLevel = getLevel(0);
      expect(zeroLevel.label).toBe("New");
    });

    it("maps positive scores to appropriate tiers", () => {
      expect(getLevel(1).label).toBe("Starter");
      expect(getLevel(4).label).toBe("Reliable");
      expect(getLevel(7).label).toBe("Trusted");
      expect(getLevel(12).label).toBe("Legend");
    });
  });
});
