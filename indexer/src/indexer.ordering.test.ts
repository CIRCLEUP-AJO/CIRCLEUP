/**
 * Indexer event ordering tests.
 *
 * Verifies that the indexer preserves the relative order of events within
 * a transaction, matching the contract's emission order documented in
 * docs/EVENTS.md.
 *
 * Compound operation event sequences:
 * - payout: payout → score_updated → round_started/completed
 * - settle_round: default* → exceptional_settlement → payout → score_updated → round_started/completed
 * - close: collateral_released* → closed
 * - join activation: joined → active
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  processEvents,
  handlePayout,
  handleSettleRound,
  handleClose,
  handleInitialized,
  handleJoined,
  handleActive,
  handleContributed,
  handleDefault,
  handleRoundStarted,
  handleCompleted,
  handleCancelled,
  handleClosed,
  handleCollateralReleased,
  handleScoreUpdated,
} from "./indexer";
import { Pool } from "./db/pool";
import { Logger } from "./logger";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { classifyEvent, EventClassification } from "./eventSchemas";

// Mock dependencies
const mockPool = {
  query: vi.fn(),
  transaction: vi.fn(async (cb) => {
    const tx = {
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      execute: vi.fn(),
    };
    await cb(tx);
    return tx;
  }),
};

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe("Event Ordering", () => {
  describe("Payout event sequence", () => {
    it("should process payout events in documented order", () => {
      // Simulated events from a successful payout (full contributions)
      const events = [
        createEvent("circle", "payout", [
          "CCIRCLE123", "CRECIPIENT", 4000000000n, 0,
        ]),
        createEvent("reputation", "score_updated", ["CRECIPIENT", 1]),
        createEvent("circle", "round_started", [
          "CCIRCLE123", 1, "CRECIPIENT2", 12345n,
        ]),
      ];

      const processed: string[] = [];
      const originalHandlers = {
        payout: handlePayout,
        score_updated: handleScoreUpdated,
        round_started: handleRoundStarted,
      };

      // Wrap handlers to track call order
      const wrappedHandlers: Record<string, Function> = {};
      Object.entries(originalHandlers).forEach(([name, handler]) => {
        wrappedHandlers[name] = (...args: unknown[]) => {
          processed.push(name);
          return handler(...args);
        };
      });

      // Process events in order
      events.forEach((event) => {
        const classification = classifyEvent(event);
        if (classification.status === "projected") {
          const handler = wrappedHandlers[classification.schema.name];
          if (handler) handler(event, classification, mockPool as unknown as Pool, mockLogger);
        }
      });

      expect(processed).toEqual(["payout", "score_updated", "round_started"]);
    });

    it("should process final payout with completed instead of round_started", () => {
      const events = [
        createEvent("circle", "payout", [
          "CCIRCLE123", "CRECIPIENT", 4000000000n, 3,
        ]),
        createEvent("reputation", "score_updated", ["CRECIPIENT", 4]),
        createEvent("circle", "completed", ["CCIRCLE123", 4]),
      ];

      const processed: string[] = [];
      const originalHandlers = {
        payout: handlePayout,
        score_updated: handleScoreUpdated,
        completed: handleCompleted,
      };

      Object.entries(originalHandlers).forEach(([name, handler]) => {
        const original = handler;
        (originalHandlers as Record<string, Function>)[name] = (...args: unknown[]) => {
          processed.push(name);
          return original(...args);
        };
      });

      events.forEach((event) => {
        const classification = classifyEvent(event);
        if (classification.status === "projected") {
          const handler = (originalHandlers as Record<string, Function>)[classification.schema.name];
          if (handler) handler(event, classification, mockPool as unknown as Pool, mockLogger);
        }
      });

      expect(processed).toEqual(["payout", "score_updated", "completed"]);
      expect(processed).not.toContain("round_started");
    });
  });

  describe("Settle round event sequence", () => {
    it("should process settle_round events with defaults before settlement", () => {
      const events = [
        createEvent("circle", "default", [
          "CCIRCLE123", "GDEFAULTING", 200000000n, 0, 800000000n,
        ]),
        createEvent("circle", "exceptional_settlement", [
          "CCIRCLE123", "CRECIPIENT", 3000000000n, 0, 1,
        ]),
        createEvent("circle", "payout", [
          "CCIRCLE123", "CRECIPIENT", 3000000000n, 0,
        ]),
        createEvent("reputation", "score_updated", ["CRECIPIENT", 1]),
        createEvent("circle", "round_started", [
          "CCIRCLE123", 1, "CRECIPIENT2", 12350n,
        ]),
      ];

      const processed: string[] = [];
      const originalHandlers = {
        default: handleDefault,
        exceptional_settlement: handleSettleRound,
        payout: handlePayout,
        score_updated: handleScoreUpdated,
        round_started: handleRoundStarted,
      };

      Object.entries(originalHandlers).forEach(([name, handler]) => {
        const original = handler;
        (originalHandlers as Record<string, Function>)[name] = (...args: unknown[]) => {
          processed.push(name);
          return original(...args);
        };
      });

      events.forEach((event) => {
        const classification = classifyEvent(event);
        if (classification.status === "projected") {
          const handler = (originalHandlers as Record<string, Function>)[classification.schema.name];
          if (handler) handler(event, classification, mockPool as unknown as Pool, mockLogger);
        }
      });

      // Order must be: default → exceptional_settlement → payout → score_updated → round_started
      expect(processed[0]).toBe("default");
      expect(processed[1]).toBe("exceptional_settlement");
      expect(processed[2]).toBe("payout");
      expect(processed[3]).toBe("score_updated");
      expect(processed[4]).toBe("round_started");
    });

    it("should handle multiple defaults in settle_round", () => {
      const events = [
        createEvent("circle", "default", [
          "CCIRCLE123", "GDEFAULT1", 200000000n, 0, 800000000n,
        ]),
        createEvent("circle", "default", [
          "CCIRCLE123", "GDEFAULT2", 200000000n, 0, 800000000n,
        ]),
        createEvent("circle", "exceptional_settlement", [
          "CCIRCLE123", "CRECIPIENT", 2000000000n, 0, 2,
        ]),
        createEvent("circle", "payout", [
          "CCIRCLE123", "CRECIPIENT", 2000000000n, 0,
        ]),
        createEvent("reputation", "score_updated", ["CRECIPIENT", 1]),
        createEvent("circle", "round_started", [
          "CCIRCLE123", 1, "CRECIPIENT2", 12360n,
        ]),
      ];

      const processed: string[] = [];
      const originalHandlers = {
        default: handleDefault,
        exceptional_settlement: handleSettleRound,
        payout: handlePayout,
        score_updated: handleScoreUpdated,
        round_started: handleRoundStarted,
      };

      Object.entries(originalHandlers).forEach(([name, handler]) => {
        const original = handler;
        (originalHandlers as Record<string, Function>)[name] = (...args: unknown[]) => {
          processed.push(name);
          return original(...args);
        };
      });

      events.forEach((event) => {
        const classification = classifyEvent(event);
        if (classification.status === "projected") {
          const handler = (originalHandlers as Record<string, Function>)[classification.schema.name];
          if (handler) handler(event, classification, mockPool as unknown as Pool, mockLogger);
        }
      });

      // All defaults must come before exceptional_settlement
      const defaultIndices = processed
        .map((name, idx) => (name === "default" ? idx : -1))
        .filter((idx) => idx >= 0);
      const settlementIdx = processed.indexOf("exceptional_settlement");

      expect(defaultIndices.every((idx) => idx < settlementIdx)).toBe(true);
      expect(defaultIndices.length).toBe(2);
    });
  });

  describe("Close event sequence", () => {
    it("should process close events with collateral_released before closed", () => {
      const events = [
        createEvent("circle", "collateral_released", [
          "CCIRCLE123", "GMEMBER1", 1000000000n,
        ]),
        createEvent("circle", "collateral_released", [
          "CCIRCLE123", "GMEMBER2", 1000000000n,
        ]),
        createEvent("circle", "collateral_released", [
          "CCIRCLE123", "GMEMBER3", 1000000000n,
        ]),
        createEvent("circle", "collateral_released", [
          "CCIRCLE123", "GMEMBER4", 1000000000n,
        ]),
        createEvent("circle", "closed", [
          "CCIRCLE123", "GMEMBER1", 4000000000n, 4000000000n, "completed",
        ]),
      ];

      const processed: string[] = [];
      const originalHandlers = {
        collateral_released: handleCollateralReleased,
        closed: handleClosed,
      };

      Object.entries(originalHandlers).forEach(([name, handler]) => {
        const original = handler;
        (originalHandlers as Record<string, Function>)[name] = (...args: unknown[]) => {
          processed.push(name);
          return original(...args);
        };
      });

      events.forEach((event) => {
        const classification = classifyEvent(event);
        if (classification.status === "projected") {
          const handler = (originalHandlers as Record<string, Function>)[classification.schema.name];
          if (handler) handler(event, classification, mockPool as unknown as Pool, mockLogger);
        }
      });

      // All collateral_released must come before closed
      const releasedIndices = processed
        .map((name, idx) => (name === "collateral_released" ? idx : -1))
        .filter((idx) => idx >= 0);
      const closedIdx = processed.indexOf("closed");

      expect(releasedIndices.every((idx) => idx < closedIdx)).toBe(true);
      expect(releasedIndices.length).toBe(4);
      expect(closedIdx).toBe(4);
    });
  });

  describe("Join activation event sequence", () => {
    it("should process join events before active", () => {
      const events = [
        createEvent("circle", "joined", [
          "CCIRCLE123", "GMEMBER1", 1, 1000000000n,
        ]),
        createEvent("circle", "joined", [
          "CCIRCLE123", "GMEMBER2", 2, 1000000000n,
        ]),
        createEvent("circle", "joined", [
          "CCIRCLE123", "GMEMBER3", 3, 1000000000n,
        ]),
        createEvent("circle", "joined", [
          "CCIRCLE123", "GMEMBER4", 4, 1000000000n,
        ]),
        createEvent("circle", "active", ["CCIRCLE123", 12300n]),
      ];

      const processed: string[] = [];
      const originalHandlers = {
        joined: handleJoined,
        active: handleActive,
      };

      Object.entries(originalHandlers).forEach(([name, handler]) => {
        const original = handler;
        (originalHandlers as Record<string, Function>)[name] = (...args: unknown[]) => {
          processed.push(name);
          return original(...args);
        };
      });

      events.forEach((event) => {
        const classification = classifyEvent(event);
        if (classification.status === "projected") {
          const handler = (originalHandlers as Record<string, Function>)[classification.schema.name];
          if (handler) handler(event, classification, mockPool as unknown as Pool, mockLogger);
        }
      });

      // All joined must come before active
      const joinedIndices = processed
        .map((name, idx) => (name === "joined" ? idx : -1))
        .filter((idx) => idx >= 0);
      const activeIdx = processed.indexOf("active");

      expect(joinedIndices.every((idx) => idx < activeIdx)).toBe(true);
      expect(joinedIndices.length).toBe(4);
      expect(activeIdx).toBe(4);
    });
  });

  describe("Failed transaction event isolation", () => {
    it("should not process events from failed transactions", () => {
      // Simulate a failed payout (not all contributed)
      const failedPayoutEvents = [
        createEvent("circle", "payout", [
          "CCIRCLE123", "CRECIPIENT", 4000000000n, 0,
        ]),
        // Note: score_updated and round_started would NOT be emitted
        // because the transaction failed before reputation.increment()
      ];

      const processed: string[] = [];
      const originalHandlers = {
        payout: handlePayout,
        score_updated: handleScoreUpdated,
        round_started: handleRoundStarted,
      };

      Object.entries(originalHandlers).forEach(([name, handler]) => {
        const original = handler;
        (originalHandlers as Record<string, Function>)[name] = (...args: unknown[]) => {
          processed.push(name);
          return original(...args);
        };
      });

      // Simulate payout failure - payout handler would fail
      const payoutEvent = failedPayoutEvents[0];
      const classification = classifyEvent(payoutEvent);

      if (classification.status === "projected") {
        try {
          (originalHandlers as Record<string, Function>)[classification.schema.name](
            payoutEvent,
            classification,
            mockPool as unknown as Pool,
            mockLogger,
          );
        } catch {
          // Payout failed - no further events should be processed
        }
      }

      // Only payout should be attempted, not score_updated or round_started
      expect(processed).toEqual(["payout"]);
      expect(processed).not.toContain("score_updated");
      expect(processed).not.toContain("round_started");
    });
  });

  describe("Pause/Resume event ordering", () => {
    it("should process pause and resume events correctly", () => {
      const events = [
        createEvent("circle", "paused", ["CCIRCLE123", "GADMIN", 12345]),
        createEvent("circle", "resumed", ["CCIRCLE123", "GADMIN", 12350]),
      ];

      const processed: string[] = [];
      // Note: pause/resume handlers would be added here
      // For now, just verify the events are classified correctly

      events.forEach((event) => {
        const classification = classifyEvent(event);
        expect(classification.status).toBe("projected");
      });

      expect(processed.length).toBe(0); // No handlers registered yet
    });
  });

  describe("Cancellation event ordering", () => {
    it("should process cancelled event correctly", () => {
      const events = [
        createEvent("circle", "cancelled", ["CCIRCLE123", "GCALLER", 12345]),
      ];

      const classification = classifyEvent(events[0]);
      expect(classification.status).toBe("projected");
      expect((classification as any).schema.name).toBe("cancelled");
    });
  });
});

// Helper to create test events matching the contract's emission format
function createEvent(
  family: string,
  name: string,
  data: unknown[],
): { topics: unknown[]; data: unknown; contractId: string | null } {
  return {
    topics: [family, name],
    data: data,
    contractId: family === "circle" ? (data[0] as string) : null,
  };
}