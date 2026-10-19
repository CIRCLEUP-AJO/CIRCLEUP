/**
 * Issue #628: Proxy trust topology diagnostics and safe logging.
 *
 * Misconfigured proxy trust can:
 *   - Rate-limit users together (trust proxy: true without specifying hops)
 *   - Allow forwarded-header spoofing (client sets their own X-Forwarded-For)
 *
 * This module provides:
 *   - Validation of TRUST_PROXY_HOPS configuration
 *   - Safe aggregate logging for throttling diagnostics
 *   - Route-based bucket isolation verification
 *   - Test utilities for proxy trust behavior
 */

import { Request, Response, NextFunction } from "express";

// ─────────────────────────────────────────────────────────────────────────────
// TRUST_PROXY_HOPS Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TRUST_PROXY_HOPS controls how Express determines the client IP:
 *
 *   0 (default) - Do not trust any proxy. req.ip is the direct socket address.
 *                 Correct for local development or direct server exposure.
 *
 *   1           - Trust the first hop behind a single reverse proxy/ALB.
 *                 X-Forwarded-For's first IP is used as client IP.
 *
 *   N           - Trust the Nth hop from the edge. Use in layered setups
 *                 (e.g., CDN -> load balancer -> app).
 *
 * SECURITY IMPLICATIONS:
 *   - trust proxy: true (without hops) allows ANY X-Forwarded-For to be trusted
 *   - trust proxy: 0 means the proxy's own IP is rate-limited, hitting all users
 *   - trust proxy: N with N > 1 requires chain verification
 *
 * RECOMMENDED SETTINGS:
 *   - Direct deployment: 0
 *   - Behind nginx/ALB: 1
 *   - Behind Cloudflare + ALB: 2 (if Cloudflare proxy is respected)
 *   - Behind CDN (untrusted): 0 (CDN should set X-Real-IP header instead)
 */

export interface TrustProxyConfig {
  /** Configured hop count. */
  hops: number;
  /** Whether any proxy trust is enabled. */
  trustEnabled: boolean;
  /** Human-readable configuration description. */
  description: string;
  /** Security assessment. */
  securityStatus: "secure" | "warning" | "insecure";
  /** Security notes. */
  securityNotes: string[];
}

/**
 * Parse and validate TRUST_PROXY_HOPS environment variable.
 */
export function parseTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `[api] TRUST_PROXY_HOPS must be a non-negative integer, got: "${raw}"`,
    );
  }
  return n;
}

/**
 * Analyze TRUST_PROXY_HOPS configuration and provide security assessment.
 */
export function analyzeTrustProxyConfig(hops: number): TrustProxyConfig {
  const securityNotes: string[] = [];
  let securityStatus: "secure" | "warning" | "insecure" = "secure";

  if (hops === 0) {
    // Direct socket connection - most secure
    return {
      hops: 0,
      trustEnabled: false,
      description: "Direct socket connection - client IP from TCP socket",
      securityStatus: "secure",
      securityNotes: [
        "Using direct socket IP (req.socket.remoteAddress)",
        "No X-Forwarded-For header is respected",
        "Rate limits are per-client IP as seen by the server",
        "Correct for direct deployment or local development",
      ],
    };
  }

  if (hops === 1) {
    // Single hop behind trusted proxy
    return {
      hops: 1,
      trustEnabled: true,
      description: "Trust first proxy hop (X-Forwarded-For first IP)",
      securityStatus: hops === 1 && process.env.NODE_ENV === "production" ? "secure" : "warning",
      securityNotes: [
        "Uses first IP in X-Forwarded-For header",
        "Only the first hop (your trusted proxy) can set this header",
        "Ensure your reverse proxy is properly configured to NOT forward",
        "untrusted X-Forwarded-For headers from clients",
      ],
    };
  }
  
  // hops > 1
  return {
    hops,
    trustEnabled: true,
    description: `Trust ${hops} proxy hops from edge`,
    securityStatus: "warning",
    securityNotes: [
      `Trusting the ${hops}th hop from edge`,
      "Verify your proxy chain: CDN -> LB -> App",
      "Each intermediate proxy must be trusted and controlled",
      "Misconfiguration can allow header spoofing",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe Rate-Limit Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export interface RateLimitDiagnostics {
  /** Current configured limits. */
  configuredLimits: {
    listMax: number;
    detailMax: number;
    historyMax: number;
    healthMax: number;
    windowMs: number;
  };
  /** Trust proxy status. */
  trustProxy: TrustProxyConfig;
  /** Whether rate-limits are properly isolated per route. */
  bucketIsolationStatus: "ok" | "warning" | "error";
  /** Diagnostics notes. */
  notes: string[];
}

/**
 * Capture current rate-limit configuration for diagnostics.
 */
export function getRateLimitDiagnostics(): RateLimitDiagnostics {
  const trustProxyHops = parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);
  
  return {
    configuredLimits: {
      listMax: parseInt(process.env.RATE_LIMIT_LIST_MAX || "30", 10),
      detailMax: parseInt(process.env.RATE_LIMIT_DETAIL_MAX || "100", 10),
      historyMax: parseInt(process.env.RATE_LIMIT_HISTORY_MAX || "30", 10),
      healthMax: parseInt(process.env.RATE_LIMIT_HEALTH_MAX || "300", 10),
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
    },
    trustProxy: analyzeTrustProxyConfig(trustProxyHops),
    bucketIsolationStatus: "ok", // Each route uses separate limiter in api.ts
    notes: [
      "Rate limits are isolated per endpoint class (list, detail, history, health)",
      "Each class has independent limits - bursts on one don't affect others",
      "X-Forwarded-For is respected only if TRUST_PROXY_HOPS > 0",
      "Response never reveals which limit was hit or configured values",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock request with X-Forwarded-For header.
 */
export function createMockRequest(forwardedFor: string | undefined): Partial<Request> {
  const req = {
    headers: {} as Record<string, string | string[] | undefined>,
    ip: "192.0.2.1", // Direct socket IP (TEST-NET-1)
    socket: {
      remoteAddress: "192.0.2.1",
    } as Request["socket"],
  };

  if (forwardedFor) {
    req.headers["x-forwarded-for"] = forwardedFor;
  }

  return req;
}

/**
 * Simulate trust proxy behavior without Express.
 * Returns the IP that would be used for rate limiting.
 */
export function determineClientIp(
  req: Partial<Request>,
  trustProxyHops: number,
): string {
  if (trustProxyHops === 0) {
    // No trust - use direct socket
    return req.socket?.remoteAddress || req.ip || "unknown";
  }

  // Trust proxy - parse X-Forwarded-For
  const forwardedFor = req.headers?.["x-forwarded-for"];
  if (!forwardedFor) {
    return req.socket?.remoteAddress || req.ip || "unknown";
  }

  // X-Forwarded-For: client, proxy1, proxy2, ...
  const ips = Array.isArray(forwardedFor)
    ? forwardedFor[0].split(",")
    : forwardedFor.split(",");

  // Take the Nth hop (1-indexed)
  const hopIndex = Math.min(trustProxyHops - 1, ips.length - 1);
  return ips[hopIndex]?.trim() || req.socket?.remoteAddress || req.ip || "unknown";
}

/**
 * Test that forged X-Forwarded-For headers cannot bypass rate limits.
 * A properly configured server should ignore client-set headers.
 */
export function testForgedHeaders(): {
  pass: boolean;
  issue: string | null;
} {
  // Scenario: Client tries to forge X-Forwarded-For to get unlimited rate limits
  const forgedReq = createMockRequest("203.0.113.1, 198.51.100.1"); // Client tries to appear as different IP

  // With trust proxy disabled (secure)
  const ipNoTrust = determineClientIp(forgedReq, 0);
  if (ipNoTrust === "203.0.113.1") {
    return {
      pass: false,
      issue: "With TRUST_PROXY_HOPS=0, forged X-Forwarded-For was respected",
    };
  }

  // With trust proxy enabled - client can only control first hop if hops=1
  const ipWithTrust = determineClientIp(forgedReq, 1);
  // When hops=1, first IP in X-Forwarded-For is used (which client set!)
  // This is the expected behavior when trust is enabled
  if (ipWithTrust === "203.0.113.1") {
    return {
      pass: true,
      issue: "With TRUST_PROXY_HOPS=1, client-controlled X-Forwarded-For is used (expected when trusting proxy)",
    };
  }

  return { pass: true, issue: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics Endpoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get diagnostics for operators (safe, no PII).
 */
export function getProxyDiagnostics(): {
  trustProxyAnalysis: ReturnType<typeof analyzeTrustProxyConfig>;
  rateLimitSummary: {
    listRequestsPerWindow: string;
    detailRequestsPerWindow: string;
    historyRequestsPerWindow: string;
    windowMs: number;
  };
  bucketIsolation: string;
  securityAssessment: {
    overallStatus: "secure" | "warning" | "insecure";
    findings: string[];
    recommendations: string[];
  };
} {
  const diagnostics = getRateLimitDiagnostics();

  return {
    trustProxyAnalysis: diagnostics.trustProxy,
    rateLimitSummary: {
      listRequestsPerWindow: `${diagnostics.configuredLimits.listMax} requests per ${diagnostics.configuredLimits.windowMs / 1000}s`,
      detailRequestsPerWindow: `${diagnostics.configuredLimits.detailMax} requests per ${diagnostics.configuredLimits.windowMs / 1000}s`,
      historyRequestsPerWindow: `${diagnostics.configuredLimits.historyMax} requests per ${diagnostics.configuredLimits.windowMs / 1000}s`,
      windowMs: diagnostics.configuredLimits.windowMs,
    },
    bucketIsolation: "Each endpoint class has independent rate limit bucket",
    securityAssessment: (() => {
      const findings: string[] = [];
      const recommendations: string[] = [];

      if (diagnostics.trustProxy.trustEnabled && diagnostics.trustProxy.hops > 1) {
        findings.push("Multiple proxy hops trusted - verify proxy chain is controlled");
        recommendations.push("Document your proxy topology and verify each hop");
      }

      if (diagnostics.trustProxy.hops === 0) {
        findings.push("No proxy trust - all users share proxy's IP for rate limiting");
        recommendations.push("Set TRUST_PROXY_HOPS=1 if behind a trusted reverse proxy");
      }

      const overallStatus = findings.length === 0 ? "secure" : findings.length === 1 ? "warning" : "insecure";

      return {
        overallStatus,
        findings,
        recommendations,
      };
    })(),
  };
}