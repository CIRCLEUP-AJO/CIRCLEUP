/**
 * Unit tests for explicit transport and service URL policy (Issue #914 / Issue 78).
 *
 * Verifies:
 * - Approved HTTPS endpoints are accepted
 * - Localhost / 127.0.0.1 HTTP allowed in local dev and custom networks
 * - Production rejects insecure HTTP for remote hosts
 * - Relative URLs, unsupported schemes (ftp:, javascript:, ws:), and malformed strings rejected
 * - Embedded credentials strictly rejected and NEVER echoed in diagnostic output
 * - Query strings and fragments rejected and NEVER echoed in diagnostic output
 */

import { describe, it, expect } from "vitest";
import {
  validateServiceUrl,
  isLocalhost,
  sanitizeUrlForDiagnostic,
} from "../transportPolicy";
import { validateCircleUpConfig } from "../validators";
import { IndexerClient } from "../client";
import type { CircleUpConfig } from "../types";

const VALID_CONFIG: CircleUpConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {
    circleFactory: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    reputation: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    usdc: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA4",
  },
  indexerUrl: "http://localhost:3001",
};

describe("transportPolicy - isLocalhost", () => {
  it("recognizes standard local addresses", () => {
    expect(isLocalhost("localhost")).toBe(true);
    expect(isLocalhost("127.0.0.1")).toBe(true);
    expect(isLocalhost("::1")).toBe(true);
    expect(isLocalhost("[::1]")).toBe(true);
    expect(isLocalhost("0.0.0.0")).toBe(true);
    expect(isLocalhost("api.localhost")).toBe(true);
    expect(isLocalhost("node.internal")).toBe(true);
    expect(isLocalhost("service.local")).toBe(true);
    expect(isLocalhost("service.test")).toBe(true);
  });

  it("rejects public remote hostnames", () => {
    expect(isLocalhost("soroban-testnet.stellar.org")).toBe(false);
    expect(isLocalhost("indexer.circleup.xyz")).toBe(false);
    expect(isLocalhost("example.com")).toBe(false);
    expect(isLocalhost("8.8.8.8")).toBe(false);
  });
});

describe("transportPolicy - sanitizeUrlForDiagnostic", () => {
  it("strips credentials from diagnostic strings", () => {
    const raw = "https://admin:supersecret@soroban.example.com/rpc";
    const clean = sanitizeUrlForDiagnostic(raw);
    expect(clean).not.toContain("supersecret");
    expect(clean).not.toContain("admin");
    expect(clean).toBe("https://soroban.example.com/rpc");
  });

  it("strips query string and fragment from diagnostic strings", () => {
    const raw = "https://soroban.example.com/rpc?apiKey=SECRET_123#frag";
    const clean = sanitizeUrlForDiagnostic(raw);
    expect(clean).not.toContain("SECRET_123");
    expect(clean).toBe("https://soroban.example.com/rpc");
  });
});

describe("transportPolicy - validateServiceUrl", () => {
  it("accepts canonical production HTTPS URLs", () => {
    const res = validateServiceUrl(
      "https://soroban-testnet.stellar.org",
      "config.rpcUrl",
      { environment: "production" },
    );
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe("https://soroban-testnet.stellar.org");
  });

  it("accepts localhost HTTP in development", () => {
    const res = validateServiceUrl("http://localhost:3001", "config.indexerUrl", {
      environment: "development",
    });
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe("http://localhost:3001");
  });

  it("rejects remote HTTP endpoints in production", () => {
    const res = validateServiceUrl(
      "http://api.circleup.xyz/rpc",
      "config.rpcUrl",
      { environment: "production" },
    );
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/must use secure HTTPS in production/);
  });

  it("rejects remote HTTP endpoints when network is mainnet", () => {
    const res = validateServiceUrl(
      "http://insecure-soroban.example.com",
      "config.rpcUrl",
      { network: "mainnet" },
    );
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/must use secure HTTPS in production/);
  });

  it("allows custom network HTTP when allowHttp or custom network is specified", () => {
    const res = validateServiceUrl(
      "http://localhost:8000/soroban/rpc",
      "config.rpcUrl",
      { allowHttp: true },
    );
    expect(res.valid).toBe(true);
  });

  it("rejects relative URLs and scheme-less hosts", () => {
    const relative = validateServiceUrl("/api/indexer", "config.indexerUrl");
    expect(relative.valid).toBe(false);
    expect(relative.error).toMatch(/not an absolute URL/);

    const bare = validateServiceUrl("localhost:3001", "config.indexerUrl");
    expect(bare.valid).toBe(false);
    expect(bare.error).toMatch(/not an absolute URL/);
  });

  it("rejects unsupported protocols", () => {
    const ftp = validateServiceUrl("ftp://stellar.org/rpc", "config.rpcUrl");
    expect(ftp.valid).toBe(false);
    expect(ftp.error).toMatch(/unsupported scheme "ftp:"/);

    const js = validateServiceUrl("javascript:alert(1)", "config.rpcUrl");
    expect(js.valid).toBe(false);
    expect(js.error).toMatch(/unsupported scheme/);
  });

  it("rejects embedded credentials without leaking them in diagnostic output", () => {
    const credsUrl = "https://customuser:SuperSecretToken99@soroban-testnet.stellar.org";
    const res = validateServiceUrl(credsUrl, "config.rpcUrl");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("config.rpcUrl cannot contain embedded credentials (username/password).");
    expect(res.error).not.toContain("SuperSecretToken99");
    expect(res.error).not.toContain("customuser");
  });

  it("rejects query parameters without leaking query secrets", () => {
    const queryUrl = "https://soroban-testnet.stellar.org?apiKey=PrivateSecretKey";
    const res = validateServiceUrl(queryUrl, "config.rpcUrl");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("config.rpcUrl cannot contain query parameters.");
    expect(res.error).not.toContain("PrivateSecretKey");
  });

  it("rejects URL fragments", () => {
    const hashUrl = "https://soroban-testnet.stellar.org#section";
    const res = validateServiceUrl(hashUrl, "config.rpcUrl");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("config.rpcUrl cannot contain URL fragments.");
  });
});

describe("transportPolicy integration in CircleUpConfig and IndexerClient", () => {
  it("validateCircleUpConfig rejects embedded credentials without leaking them", () => {
    const cfg = {
      ...VALID_CONFIG,
      rpcUrl: "https://user:SecretApiKey123@soroban-testnet.stellar.org",
    };
    expect(() => validateCircleUpConfig(cfg)).toThrow(/embedded credentials/);
    expect(() => validateCircleUpConfig(cfg)).not.toThrow(/SecretApiKey123/);
  });

  it("IndexerClient rejects credentials and query parameters without leaking", () => {
    const cfgWithCreds = {
      ...VALID_CONFIG,
      indexerUrl: "http://bot:MyPassword@localhost:3001",
    };
    expect(() => new IndexerClient(cfgWithCreds)).toThrow(/embedded credentials/);
    expect(() => new IndexerClient(cfgWithCreds)).not.toThrow(/MyPassword/);

    const cfgWithQuery = {
      ...VALID_CONFIG,
      indexerUrl: "http://localhost:3001?secret=xyz",
    };
    expect(() => new IndexerClient(cfgWithQuery)).toThrow(/query parameters/);
    expect(() => new IndexerClient(cfgWithQuery)).not.toThrow(/xyz/);
  });
});
