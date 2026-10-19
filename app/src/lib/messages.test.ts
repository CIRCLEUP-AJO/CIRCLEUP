/**
 * Tests for lib/messages.ts
 *
 * Coverage:
 *   1. Required keys exist  — all action keys have loading and success messages
 *   2. Placeholder functions — parameterized messages produce non-empty output
 *      when called with valid args; TypeScript enforces required params
 *   3. Diagnostics separation — DIAGNOSTICS values are not in MSG namespaces
 *   4. Refresh error keys     — all RefreshError kinds are covered
 *   5. Reputation error keys  — all FetchResult.reason values are covered
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  WALLET_MSGS,
  TX_LOADING,
  TX_SUCCESS,
  txDefaultSuccess,
  invalidCircleAddress,
  DATA_STATE_MSGS,
  REPUTATION_MSGS,
  DIAGNOSTICS,
  type ActionKey,
} from "./messages";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACTION_KEYS: ActionKey[] = ["join", "contribute", "payout", "default", "close"];

const REFRESH_ERROR_KEYS = ["not_found", "network", "server", "misconfigured"] as const;

const REPUTATION_ERROR_KEYS = [
  "network",
  "unknown",
  "indexer_outage",
  "misconfigured",
  "malformed",
] as const;

// ═════════════════════════════════════════════════════════════════════════════
// 1. Required keys exist
// ═════════════════════════════════════════════════════════════════════════════

describe("TX_LOADING — all action keys have non-empty loading messages", () => {
  for (const key of ACTION_KEYS) {
    test(`TX_LOADING.${key} is non-empty`, () => {
      assert.ok(
        typeof TX_LOADING[key] === "string" && TX_LOADING[key].length > 0,
        `Missing or empty TX_LOADING.${key}`,
      );
    });
  }
});

describe("TX_SUCCESS — all action keys have non-empty success messages", () => {
  for (const key of ACTION_KEYS) {
    test(`TX_SUCCESS.${key} is non-empty`, () => {
      assert.ok(
        typeof TX_SUCCESS[key] === "string" && TX_SUCCESS[key].length > 0,
        `Missing or empty TX_SUCCESS.${key}`,
      );
    });
  }
});

describe("WALLET_MSGS — all required wallet message keys are non-empty strings", () => {
  const requiredKeys: Array<keyof typeof WALLET_MSGS> = [
    "connectPrompt",
    "notConnectedError",
    "notInstalled",
    "rejected",
    "permissionDenied",
  ];

  for (const key of requiredKeys) {
    test(`WALLET_MSGS.${key} is non-empty`, () => {
      assert.ok(
        typeof WALLET_MSGS[key] === "string" && WALLET_MSGS[key].length > 0,
        `Missing or empty WALLET_MSGS.${key}`,
      );
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Placeholder functions — required params cannot be omitted
// ═════════════════════════════════════════════════════════════════════════════

describe("txDefaultSuccess — parameterized message", () => {
  test("returns non-empty string when called with valid args", () => {
    const result = txDefaultSuccess("GABC…XYZ", 3);
    assert.ok(result.length > 0);
  });

  test("includes the short address in the output", () => {
    const addr = "GABC…XYZ";
    const result = txDefaultSuccess(addr, 3);
    assert.ok(result.includes(addr), "address must appear in the message");
  });

  test("includes the round number in the output", () => {
    const result = txDefaultSuccess("GABC…XYZ", 7);
    assert.ok(result.includes("7"), "round number must appear in the message");
  });

  test("different rounds produce different messages", () => {
    const a = txDefaultSuccess("GABC…XYZ", 1);
    const b = txDefaultSuccess("GABC…XYZ", 2);
    assert.notEqual(a, b);
  });

  test("different addresses produce different messages", () => {
    const a = txDefaultSuccess("GABC…XYZ", 1);
    const b = txDefaultSuccess("GDEF…UVW", 1);
    assert.notEqual(a, b);
  });
});

describe("invalidCircleAddress — parameterized message", () => {
  test("returns non-empty string when called with a short address", () => {
    const result = invalidCircleAddress("CABC…XYZ");
    assert.ok(result.length > 0);
  });

  test("includes the short address in the output", () => {
    const addr = "CABC…XYZ";
    const result = invalidCircleAddress(addr);
    assert.ok(result.includes(addr), "short address must appear in the message");
  });

  test("mentions C-prefixed Soroban contract ID format", () => {
    const result = invalidCircleAddress("CABC…XYZ");
    assert.ok(
      result.toLowerCase().includes("soroban") || result.includes("C-prefixed"),
      "message should mention expected format",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Diagnostics separation
// ═════════════════════════════════════════════════════════════════════════════

describe("DIAGNOSTICS — separate from user-facing namespaces", () => {
  test("DIAGNOSTICS.missingCheckpoint does not appear in WALLET_MSGS", () => {
    const walletValues = Object.values(WALLET_MSGS) as string[];
    assert.ok(
      !walletValues.includes(DIAGNOSTICS.missingCheckpoint),
      "diagnostic strings must not appear in user-facing wallet messages",
    );
  });

  test("DIAGNOSTICS.telemetryLogPrefix starts with a bracket (internal format)", () => {
    assert.ok(
      DIAGNOSTICS.telemetryLogPrefix.startsWith("["),
      "telemetry log prefix should be formatted for internal logging only",
    );
  });

  test("DIAGNOSTICS keys are non-empty strings", () => {
    for (const [key, val] of Object.entries(DIAGNOSTICS)) {
      assert.ok(
        typeof val === "string" && val.length > 0,
        `DIAGNOSTICS.${key} must be a non-empty string`,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Refresh error keys
// ═════════════════════════════════════════════════════════════════════════════

describe("DATA_STATE_MSGS.refreshErrors — all RefreshError kinds are covered", () => {
  for (const key of REFRESH_ERROR_KEYS) {
    test(`refreshErrors["${key}"] is non-empty`, () => {
      const msg = DATA_STATE_MSGS.refreshErrors[key];
      assert.ok(
        typeof msg === "string" && msg.length > 0,
        `Missing or empty refreshErrors["${key}"]`,
      );
    });
  }
});

describe("DATA_STATE_MSGS — guard messages are non-empty", () => {
  const guardKeys: Array<keyof typeof DATA_STATE_MSGS> = [
    "staleGuard",
    "partialGuard",
    "staleDefaultGuard",
    "partialDefaultGuard",
  ];

  for (const key of guardKeys) {
    test(`DATA_STATE_MSGS.${key} is non-empty`, () => {
      const val = DATA_STATE_MSGS[key];
      assert.ok(
        typeof val === "string" && (val as string).length > 0,
        `Missing or empty DATA_STATE_MSGS.${key}`,
      );
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Reputation error keys
// ═════════════════════════════════════════════════════════════════════════════

describe("REPUTATION_MSGS.fetchErrors — all fetch error reasons are covered", () => {
  for (const key of REPUTATION_ERROR_KEYS) {
    test(`fetchErrors["${key}"] is non-empty`, () => {
      const msg = REPUTATION_MSGS.fetchErrors[key];
      assert.ok(
        typeof msg === "string" && msg.length > 0,
        `Missing or empty fetchErrors["${key}"]`,
      );
    });
  }
});

describe("REPUTATION_MSGS — UI string keys are non-empty", () => {
  const uiKeys: Array<keyof typeof REPUTATION_MSGS> = [
    "loading",
    "noRecord",
    "noRecordDetail",
    "refreshing",
    "retryLabel",
    "refreshLabel",
    "scoreDescription",
    "scoreByEvents",
    "scoreByContract",
    "eventsHeading",
    "noEvents",
  ];

  for (const key of uiKeys) {
    test(`REPUTATION_MSGS.${key} is non-empty`, () => {
      const val = REPUTATION_MSGS[key];
      assert.ok(
        typeof val === "string" && (val as string).length > 0,
        `Missing or empty REPUTATION_MSGS.${key}`,
      );
    });
  }
});
