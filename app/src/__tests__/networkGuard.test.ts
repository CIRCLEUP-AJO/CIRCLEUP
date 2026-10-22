/**
 * Tests for app/src/lib/networkGuard.ts
 *
 * Covers:
 *   1. validateNetworkParam — allowlist enforcement and normalisation
 *   2. assertNetworkMatch — deployment-mismatch detection
 *   3. resolveNetworkForUrl — full pipeline (absent → default, present → validate+match)
 *   4. NetworkValidationError — reason codes and rawValue
 *   5. SUPPORTED_NETWORKS — exhaustive allowlist shape
 *   6. Edge cases — whitespace, mixed case, fragment injection, empty string
 */

import { describe, it, expect } from "vitest";
import {
  validateNetworkParam,
  assertNetworkMatch,
  resolveNetworkForUrl,
  NetworkValidationError,
  SUPPORTED_NETWORKS,
} from "../lib/networkGuard";

// ─── 1. validateNetworkParam ──────────────────────────────────────────────────

describe("validateNetworkParam", () => {
  it("returns 'testnet' for the exact string 'testnet'", () => {
    expect(validateNetworkParam("testnet")).toBe("testnet");
  });

  it("returns 'mainnet' for the exact string 'mainnet'", () => {
    expect(validateNetworkParam("mainnet")).toBe("mainnet");
  });

  it("normalises uppercase 'TESTNET' to 'testnet'", () => {
    expect(validateNetworkParam("TESTNET")).toBe("testnet");
  });

  it("normalises mixed case 'MainNet' to 'mainnet'", () => {
    expect(validateNetworkParam("MainNet")).toBe("mainnet");
  });

  it("trims leading/trailing whitespace before checking", () => {
    expect(validateNetworkParam("  testnet  ")).toBe("testnet");
  });

  it("returns null for null (absent parameter)", () => {
    expect(validateNetworkParam(null)).toBeNull();
  });

  it("returns null for undefined (absent parameter)", () => {
    expect(validateNetworkParam(undefined)).toBeNull();
  });

  it("throws NetworkValidationError with reason 'empty' for a blank string", () => {
    expect(() => validateNetworkParam("")).toThrow(NetworkValidationError);
    try {
      validateNetworkParam("");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkValidationError);
      expect((err as NetworkValidationError).reason).toBe("empty");
    }
  });

  it("throws NetworkValidationError with reason 'empty' for whitespace-only string", () => {
    expect(() => validateNetworkParam("   ")).toThrow(NetworkValidationError);
    try {
      validateNetworkParam("   ");
    } catch (err) {
      expect((err as NetworkValidationError).reason).toBe("empty");
    }
  });

  it("throws NetworkValidationError with reason 'unsupported_value' for unknown network", () => {
    expect(() => validateNetworkParam("stagenet")).toThrow(NetworkValidationError);
    try {
      validateNetworkParam("stagenet");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkValidationError);
      expect((err as NetworkValidationError).reason).toBe("unsupported_value");
      expect((err as NetworkValidationError).rawValue).toBe("stagenet");
    }
  });

  it("rejects 'preview' as unsupported", () => {
    expect(() => validateNetworkParam("preview")).toThrow(NetworkValidationError);
  });

  it("rejects 'custom' as unsupported (not a valid param value)", () => {
    expect(() => validateNetworkParam("custom")).toThrow(NetworkValidationError);
  });

  it("rejects a Stellar address used as a network (path-injection attempt)", () => {
    const addr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    expect(() => validateNetworkParam(addr)).toThrow(NetworkValidationError);
  });

  it("rejects a value with a path-traversal pattern", () => {
    expect(() => validateNetworkParam("../../etc/passwd")).toThrow(NetworkValidationError);
  });

  it("rejects a value with embedded query string", () => {
    expect(() => validateNetworkParam("testnet?foo=bar")).toThrow(NetworkValidationError);
  });

  it("rejects javascript: scheme injection attempt", () => {
    expect(() => validateNetworkParam("javascript:alert(1)")).toThrow(NetworkValidationError);
  });

  it("preserves rawValue on the error for logging", () => {
    try {
      validateNetworkParam("badnet");
    } catch (err) {
      expect((err as NetworkValidationError).rawValue).toBe("badnet");
    }
  });

  it("error message mentions the supported networks", () => {
    try {
      validateNetworkParam("badnet");
    } catch (err) {
      const msg = (err as NetworkValidationError).message;
      expect(msg).toMatch(/testnet/);
      expect(msg).toMatch(/mainnet/);
    }
  });
});

// ─── 2. assertNetworkMatch ────────────────────────────────────────────────────

describe("assertNetworkMatch", () => {
  it("does not throw when requested matches deployment", () => {
    expect(() => assertNetworkMatch("testnet", "testnet")).not.toThrow();
    expect(() => assertNetworkMatch("mainnet", "mainnet")).not.toThrow();
  });

  it("throws NetworkValidationError with reason 'deployment_mismatch' on mismatch", () => {
    expect(() => assertNetworkMatch("mainnet", "testnet")).toThrow(NetworkValidationError);
    try {
      assertNetworkMatch("mainnet", "testnet");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkValidationError);
      expect((err as NetworkValidationError).reason).toBe("deployment_mismatch");
      expect((err as NetworkValidationError).rawValue).toBe("mainnet");
    }
  });

  it("throws when requesting testnet but deployment is mainnet", () => {
    expect(() => assertNetworkMatch("testnet", "mainnet")).toThrow(NetworkValidationError);
  });

  it("does NOT throw for 'custom' deployment network (private chain — skip check)", () => {
    // A private/standalone chain should not block a valid network param
    expect(() => assertNetworkMatch("testnet", "custom")).not.toThrow();
    expect(() => assertNetworkMatch("mainnet", "custom")).not.toThrow();
  });

  it("error message names both networks for operator clarity", () => {
    try {
      assertNetworkMatch("mainnet", "testnet");
    } catch (err) {
      const msg = (err as NetworkValidationError).message;
      expect(msg).toMatch(/mainnet/);
      expect(msg).toMatch(/testnet/);
    }
  });

  it("error message includes guidance about deployment origins", () => {
    try {
      assertNetworkMatch("mainnet", "testnet");
    } catch (err) {
      const msg = (err as NetworkValidationError).message;
      // Must explain that the user should open the correct deployment
      expect(msg).toMatch(/deployment/i);
    }
  });
});

// ─── 3. resolveNetworkForUrl ─────────────────────────────────────────────────

describe("resolveNetworkForUrl", () => {
  // Absent parameter — use deployment default
  it("returns deployment network when rawParam is null", () => {
    expect(resolveNetworkForUrl(null, "testnet")).toBe("testnet");
    expect(resolveNetworkForUrl(null, "mainnet")).toBe("mainnet");
  });

  it("returns deployment network when rawParam is undefined", () => {
    expect(resolveNetworkForUrl(undefined, "testnet")).toBe("testnet");
  });

  // Matching parameter
  it("returns the validated network when rawParam matches deployment", () => {
    expect(resolveNetworkForUrl("testnet", "testnet")).toBe("testnet");
    expect(resolveNetworkForUrl("mainnet", "mainnet")).toBe("mainnet");
  });

  it("normalises 'TESTNET' to 'testnet' when it matches the deployment", () => {
    expect(resolveNetworkForUrl("TESTNET", "testnet")).toBe("testnet");
  });

  // Mismatched parameter — must throw
  it("throws NetworkValidationError when rawParam mismatches deployment", () => {
    expect(() => resolveNetworkForUrl("mainnet", "testnet")).toThrow(
      NetworkValidationError,
    );
  });

  it("throws with reason 'deployment_mismatch' on mismatch", () => {
    try {
      resolveNetworkForUrl("mainnet", "testnet");
    } catch (err) {
      expect((err as NetworkValidationError).reason).toBe("deployment_mismatch");
    }
  });

  // Unsupported value
  it("throws with reason 'unsupported_value' for an unknown network param", () => {
    try {
      resolveNetworkForUrl("preview", "testnet");
    } catch (err) {
      expect((err as NetworkValidationError).reason).toBe("unsupported_value");
    }
  });

  // Blank parameter
  it("throws with reason 'empty' for a blank param", () => {
    try {
      resolveNetworkForUrl("", "testnet");
    } catch (err) {
      expect((err as NetworkValidationError).reason).toBe("empty");
    }
  });

  // Custom deployment network
  it("returns 'testnet' as safe default when deployment is 'custom' and param absent", () => {
    const result = resolveNetworkForUrl(null, "custom");
    // testnet is the safe fallback for custom/private chains
    expect(result).toBe("testnet");
  });

  it("allows any supported network param when deployment is 'custom'", () => {
    // Custom chains skip the mismatch check
    expect(resolveNetworkForUrl("testnet", "custom")).toBe("testnet");
    expect(resolveNetworkForUrl("mainnet", "custom")).toBe("mainnet");
  });

  // Injection / abuse
  it("rejects a path-traversal attempt as unsupported_value", () => {
    try {
      resolveNetworkForUrl("../../secret", "testnet");
    } catch (err) {
      expect((err as NetworkValidationError).reason).toBe("unsupported_value");
    }
  });

  it("never silently selects a different network from an address", () => {
    // A Soroban contract ID used as a network param must throw, not succeed
    const addr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    expect(() => resolveNetworkForUrl(addr, "testnet")).toThrow(NetworkValidationError);
  });
});

// ─── 4. NetworkValidationError ────────────────────────────────────────────────

describe("NetworkValidationError", () => {
  it("is an instance of Error", () => {
    const err = new NetworkValidationError("empty", "", "test");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name 'NetworkValidationError'", () => {
    const err = new NetworkValidationError("unsupported_value", "bad", "test");
    expect(err.name).toBe("NetworkValidationError");
  });

  it("exposes the reason code", () => {
    const e1 = new NetworkValidationError("empty", "", "test");
    const e2 = new NetworkValidationError("unsupported_value", "x", "test");
    const e3 = new NetworkValidationError("deployment_mismatch", "mainnet", "test");
    expect(e1.reason).toBe("empty");
    expect(e2.reason).toBe("unsupported_value");
    expect(e3.reason).toBe("deployment_mismatch");
  });

  it("exposes rawValue", () => {
    const err = new NetworkValidationError("unsupported_value", "badnet", "test");
    expect(err.rawValue).toBe("badnet");
  });

  it("accepts undefined rawValue", () => {
    const err = new NetworkValidationError("empty", undefined, "test");
    expect(err.rawValue).toBeUndefined();
  });

  it("instanceof check works with caught errors", () => {
    try {
      validateNetworkParam("badnet");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err instanceof NetworkValidationError).toBe(true);
    }
  });
});

// ─── 5. SUPPORTED_NETWORKS ───────────────────────────────────────────────────

describe("SUPPORTED_NETWORKS", () => {
  it("contains 'testnet'", () => {
    expect(SUPPORTED_NETWORKS.has("testnet")).toBe(true);
  });

  it("contains 'mainnet'", () => {
    expect(SUPPORTED_NETWORKS.has("mainnet")).toBe(true);
  });

  it("does not contain 'custom' (custom is not a shareable network identifier)", () => {
    // 'custom' is an internal sentinel for private chains, not a valid URL param
    expect(SUPPORTED_NETWORKS.has("custom" as never)).toBe(false);
  });

  it("has exactly the expected size (prevents accidental additions)", () => {
    // If a new network is added the developer must explicitly update this test,
    // confirming they also updated deployment profiles and explorer URL mappings.
    expect(SUPPORTED_NETWORKS.size).toBe(2);
  });
});

// ─── 6. End-to-end invariant: address alone never selects a network ──────────

describe("invariant: address alone never selects a network", () => {
  const CIRCLE_ADDRESSES = [
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK7CE",
    "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ];

  for (const addr of CIRCLE_ADDRESSES) {
    it(`rejects circle address ${addr.slice(0, 8)}… used as network param`, () => {
      expect(() => validateNetworkParam(addr)).toThrow(NetworkValidationError);
    });
  }

  it("resolveNetworkForUrl with absent param always returns deployment network, not address", () => {
    // No matter what the circle address is, an absent network param returns
    // the deployment default — the address itself plays no role.
    const deploymentNetwork = "testnet";
    expect(resolveNetworkForUrl(null, deploymentNetwork)).toBe(deploymentNetwork);
  });
});
