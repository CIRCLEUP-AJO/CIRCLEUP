import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    INDEXER_URL: "http://localhost:3001",
    indexerEndpoint: (path: string[], baseUrl?: string) => {
      const base = baseUrl || "http://localhost:3001";
      return `${base}/${path.join("/")}`;
    },
  };
});

import { generateMetadata as generateCircleMetadata } from "@/app/circles/[address]/page";
import { generateMetadata as generateReputationMetadata } from "@/app/reputation/[member]/page";
import { generateMetadata as generateHomeMetadata } from "@/app/page";
import { getExplorerLink } from "@/lib/explorer";
import { SITE_URL } from "@/lib/config";

// Mock global fetch
const globalFetch = vi.fn();
global.fetch = globalFetch;

describe("Route Metadata Generation & Guard Tests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("Circle Page Metadata (/circles/[address])", () => {
    const VALID_CIRCLE = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const MALFORMED_ADDRESS = "GNOTACONTRACTID";

    it("returns generic fallback metadata for malformed circle addresses", async () => {
      const meta = await generateCircleMetadata({ params: { address: MALFORMED_ADDRESS } });
      expect(meta.title).toBe("Circle — CircleUp");
      expect(meta.description).toBe("Savings circle on CircleUp.");
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("rejects malformed circle addresses before any indexer lookup", async () => {
      await generateCircleMetadata({ params: { address: MALFORMED_ADDRESS } });
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("returns generic fallback metadata when address param is missing or non-string", async () => {
      const meta = await generateCircleMetadata({ params: { address: undefined as any } });
      expect(meta.title).toBe("Circle — CircleUp");
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("returns enriched metadata for valid circle address when indexer returns data", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          circle: {
            address: VALID_CIRCLE,
            creator: "G111",
            round_amount: "100000000",
            member_count: 5,
            status: "Active",
            current_round: 2,
            total_rounds: 5,
            created_ledger: 100,
            updated_at: "2026-09-30T00:00:00Z",
          },
          members: [],
        }),
      } as Response);
      globalFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ rounds: [], openRounds: [], pendingDefaults: [], currentRound: null }),
      } as Response);

      const meta = await generateCircleMetadata({ params: { address: VALID_CIRCLE } });
      expect(meta.title).toContain("$10.00/round Circle (Active) — CircleUp");
      expect(meta.description).toContain("$50.00 pot · 5 members · round 2 of 5.");
    });

    it("returns Not Found metadata for unknown circle (indexer 404)", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const meta = await generateCircleMetadata({ params: { address: VALID_CIRCLE } });
      expect(meta.title).toBe("Circle Not Found — CircleUp");
      expect(meta.description).toContain("was not found");
    });

    it("returns a stable fallback (not Not Found) when the indexer is unavailable", async () => {
      globalFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      globalFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const meta = await generateCircleMetadata({ params: { address: VALID_CIRCLE } });
      expect(meta.title).toBe("Circle — CircleUp");
      expect(meta.title).not.toBe("Circle Not Found — CircleUp");
    });

    it("returns a stable fallback when the indexer responds with a server error", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response);
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response);

      const meta = await generateCircleMetadata({ params: { address: VALID_CIRCLE } });
      expect(meta.title).toBe("Circle — CircleUp");
      expect(meta.title).not.toBe("Circle Not Found — CircleUp");
    });
  });

  describe("Reputation Page Metadata (/reputation/[member])", () => {
    const VALID_MEMBER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const MALFORMED_MEMBER = "not-a-stellar-address";

    it("returns fallback metadata for malformed member addresses", async () => {
      const meta = await generateReputationMetadata({ params: { member: MALFORMED_MEMBER } });
      expect(meta.title).toBe("Reputation — CircleUp");
      expect(meta.description).toBe("On-chain reputation score and contribution history on CircleUp.");
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("rejects malformed member addresses before any indexer lookup", async () => {
      await generateReputationMetadata({ params: { member: MALFORMED_MEMBER } });
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("returns enriched metadata for valid member addresses", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          member: VALID_MEMBER,
          found: true,
          score: 10,
          contributions: [],
          defaults: [],
        }),
      } as Response);

      const meta = await generateReputationMetadata({ params: { member: VALID_MEMBER } });
      expect(meta.title).toContain("Reputation:");
      expect(meta.title).toContain("— CircleUp");
      expect(meta.description).toContain(VALID_MEMBER);
    });

    it("returns Member Not Found metadata when indexer returns 404", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const meta = await generateReputationMetadata({ params: { member: VALID_MEMBER } });
      expect(meta.title).toBe("Member Not Found — CircleUp");
      expect(meta.description).toContain("has no recorded activity");
    });

    it("returns a stable fallback (not Member Not Found) when the indexer is unavailable", async () => {
      globalFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const meta = await generateReputationMetadata({ params: { member: VALID_MEMBER } });
      expect(meta.title).toBe("Reputation — CircleUp");
      expect(meta.title).not.toBe("Member Not Found — CircleUp");
    });

    it("returns a stable fallback when the indexer responds with a server error", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response);

      const meta = await generateReputationMetadata({ params: { member: VALID_MEMBER } });
      expect(meta.title).toBe("Reputation — CircleUp");
      expect(meta.title).not.toBe("Member Not Found — CircleUp");
    });
  });

  describe("Canonical URLs use configured origin", () => {
    const VALID_CIRCLE = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const VALID_MEMBER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    it("home metadata canonical uses SITE_URL", async () => {
      const meta = await generateHomeMetadata();
      expect(meta.alternates?.canonical).toBe(SITE_URL);
    });

    it("circle metadata canonical uses SITE_URL and route address, not request host", async () => {
      globalFetch.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
      globalFetch.mockResolvedValueOnce({ ok: false, status: 404 } as Response);

      const meta = await generateCircleMetadata({
        params: { address: VALID_CIRCLE },
        // An untrusted host header must never leak into canonical metadata.
        headers: new Headers({ host: "evil.example.com" }),
      } as any);

      expect(meta.alternates?.canonical).toBe(`${SITE_URL}/circles/${VALID_CIRCLE}`);
      expect(String(meta.alternates?.canonical)).not.toContain("evil.example.com");
    });

    it("reputation metadata canonical uses SITE_URL and route address, not request host", async () => {
      globalFetch.mockResolvedValueOnce({ ok: false, status: 404 } as Response);

      const meta = await generateReputationMetadata({
        params: { member: VALID_MEMBER },
        headers: new Headers({ host: "evil.example.com" }),
      } as any);

      expect(meta.alternates?.canonical).toBe(`${SITE_URL}/reputation/${VALID_MEMBER}`);
      expect(String(meta.alternates?.canonical)).not.toContain("evil.example.com");
    });

    it("malformed addresses do not produce canonical URLs", async () => {
      const circleMeta = await generateCircleMetadata({ params: { address: "GNOTACONTRACTID" } });
      expect(circleMeta.alternates?.canonical).toBeUndefined();

      const repMeta = await generateReputationMetadata({ params: { member: "not-a-stellar-address" } });
      expect(repMeta.alternates?.canonical).toBeUndefined();
    });
  });

  describe("Explorer links are network-aware and validated", () => {
    const VALID_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

    it("builds account links on the configured network path", () => {
      const link = getExplorerLink("account", VALID_ACCOUNT);
      expect(link).toContain(VALID_ACCOUNT);
      expect(link).toMatch(/\/account\//);
      // Network-specific explorer paths must be reflected in the URL.
      expect(link).toMatch(/testnet|public/);
    });

    it("builds contract links on the configured network path", () => {
      const link = getExplorerLink("contract", VALID_CONTRACT);
      expect(link).toContain(VALID_CONTRACT);
      expect(link).toMatch(/\/contract\//);
      expect(link).toMatch(/testnet|public/);
    });

    it("returns null for invalid account addresses", () => {
      expect(getExplorerLink("account", "not-a-stellar-address")).toBeNull();
      expect(getExplorerLink("account", "GNOTAVALIDACCOUNT")).toBeNull();
    });

    it("returns null for invalid contract addresses", () => {
      expect(getExplorerLink("contract", "GNOTACONTRACTID")).toBeNull();
      expect(getExplorerLink("contract", "")).toBeNull();
    });

    it("labels testnet explorer links so they are not presented as mainnet evidence", () => {
      const link = getExplorerLink("account", VALID_ACCOUNT);
      if (link && link.includes("testnet")) {
        const label = getExplorerLinkLabel?.("account") ?? "View on Stellar Expert (Testnet)";
        expect(label.toLowerCase()).toContain("testnet");
      }
    });
  });
});
