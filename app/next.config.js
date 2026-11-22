/** @type {import('next').NextConfig} */

// ─── Origin inventory ─────────────────────────────────────────────────────────
//
// All external origins the browser must be allowed to reach are derived from
// environment variables so the same config file works for testnet, staging,
// and mainnet without editing.
//
//  connect-src origins (XHR / fetch / WebSocket):
//    NEXT_PUBLIC_STELLAR_RPC_URL   – Soroban RPC (testnet or mainnet horizon)
//    NEXT_PUBLIC_INDEXER_URL       – CircleUp indexer REST API
//
// Freighter wallet does NOT require a connect-src entry — it communicates via
// the injected window.freighter global (content-script message passing), not
// via a network fetch from the page origin.
//
// No CDN, analytics, or external font services are in use.  The 'self' source
// is therefore sufficient for scripts, styles, fonts, and images.
//
// ─── CSP rollout model ────────────────────────────────────────────────────────
//
// Phase 1 (default): Content-Security-Policy-Report-Only
//   Violations are reported to NEXT_PUBLIC_CSP_REPORT_URI without blocking.
//   This surfaces unexpected third-party requests before enforcement.
//   Reports are collected, redacted, and grouped by directive + source
//   (see app/lib/csp-report.ts and app/api/csp-report/route.ts).
//
// Phase 2: Enforce
//   Set NEXT_PUBLIC_CSP_ENFORCE=true in your environment.  The header name
//   switches from Content-Security-Policy-Report-Only to Content-Security-Policy
//   and the report-uri directive is retained so violations continue to surface.
//   Enforcement MUST NOT be enabled until the report-only inventory has been
//   reviewed and every remaining violation is either fixed or allowlisted
//   below with a documented reason.
//
// Review the violation report before flipping Phase 2 in production:
//   1. Check for Freighter extension injections (expected — the extension
//      injects inline scripts; add 'unsafe-inline' to script-src only if
//      your CSP blocks wallet interaction after enforcement).
//   2. Check for unexpected third-party connect-src calls.
//   3. Add justified exceptions to EXTRA_CONNECT_SRC below with a comment.
//      Do NOT add broad wildcard sources (e.g. "https:", "*") to suppress
//      reports — fix the underlying request or document a narrow origin.
//
// Rollback: unset NEXT_PUBLIC_CSP_ENFORCE (or set it to "false") and redeploy.
// The header reverts to Content-Security-Policy-Report-Only, restoring the
// previous non-blocking behaviour without a code change.  Roll back if a
// critical flow (Freighter connect/sign prompts, explorer navigation, or
// required app assets) breaks after enforcement.
=======

const rpcUrl    = process.env.NEXT_PUBLIC_STELLAR_RPC_URL  || "https://soroban-testnet.stellar.org";
const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL     || "http://localhost:3001";

// Derive only the scheme+host part so the CSP directive is not bound to a
// specific path (paths are ignored in CSP connect-src anyway, but being
// explicit avoids confusion).
function originOf(url) {
  try {
    const { origin } = new URL(url);
    return origin;
  } catch {
    // Fallback: return as-is if the URL cannot be parsed (e.g. during SSG
    // with a placeholder value).
    return url;
  }
}

const rpcOrigin     = originOf(rpcUrl);
const indexerOrigin = originOf(indexerUrl);

// Any additional connect-src origins that need an explicit exception.
// Add entries here with a comment explaining why they are required.
// Example: "https://o123456.ingest.sentry.io"  // Sentry error reporting
const EXTRA_CONNECT_SRC = [
  // none currently
];

const connectSrc = [
  "'self'",
  rpcOrigin,
  indexerOrigin,
  ...EXTRA_CONNECT_SRC,
].join(" ");

// ─── CSP directives ───────────────────────────────────────────────────────────
//
// script-src: 'self' only.  Next.js inlines a small __NEXT_DATA__ script tag
// and uses nonces in production builds; 'self' covers same-origin chunks.
// If Freighter's content-script injections cause violations after enforcement,
// add 'unsafe-inline' to script-src and document the decision here.
//
// frame-ancestors: 'none' — the app should never be embedded in a frame.
// This is the CSP-level equivalent of X-Frame-Options: DENY and takes
// precedence in modern browsers.

// Report endpoint.  Defaults to the same-origin redacting collector so that
// report-only findings are captured without sending wallet addresses or
// transaction payloads to a third party.  Override with an explicit URI only
// if you operate a trusted collector.
const reportUri = process.env.NEXT_PUBLIC_CSP_REPORT_URI || "/api/csp-report";

const cspDirectives = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-eval' 'unsafe-inline'`,   // unsafe-eval needed by Next.js dev mode; review for prod
  "style-src 'self' 'unsafe-inline'",                  // Tailwind inline styles
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src ${connectSrc}`,
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...(reportUri ? [`report-uri ${reportUri}`] : []),
].join("; ");

// Enforcement is gated behind an explicit rollout stage.  Anything other than
// the literal string "true" keeps the policy in report-only mode.
const CSP_ENFORCE = process.env.NEXT_PUBLIC_CSP_ENFORCE === "true";

const CSP_HEADER_NAME = CSP_ENFORCE
  ? "Content-Security-Policy"
  : "Content-Security-Policy-Report-Only";

// ─── Security headers ─────────────────────────────────────────────────────────

/** @type {import('next').NextConfig['headers']} */
async function securityHeaders() {
  return [
    {
      // Apply to all app routes (not _next/static assets which are immutable
      // and never framed directly).
      source: "/(.*)",
      headers: [
        // ── Framing protection ───────────────────────────────────────────
        // X-Frame-Options: DENY — legacy framing guard for browsers that
        // predate CSP frame-ancestors support (IE11, older Safari).
        // frame-ancestors 'none' in the CSP above covers modern browsers.
        {
          key: "X-Frame-Options",
          value: "DENY",
        },

        // ── MIME sniffing ────────────────────────────────────────────────
        // Prevents the browser from guessing a content type different from
        // what the server declared (e.g. a text/plain response being
        // executed as script).
        {
          key: "X-Content-Type-Options",
          value: "nosniff",
        },

        // ── Referrer policy ──────────────────────────────────────────────
        // strict-origin-when-cross-origin: sends the full URL as the
        // Referer header for same-origin requests (useful for analytics)
        // but sends only the origin for cross-origin requests, and nothing
        // at all when downgrading from HTTPS to HTTP.
        // This prevents wallet addresses, circle names, or member IDs
        // embedded in the URL path from leaking to third-party origins.
        {
          key: "Referrer-Policy",
          value: "strict-origin-when-cross-origin",
        },

        // ── Permissions policy ───────────────────────────────────────────
        // Disable browser features the app never uses.  An explicit
        // allowlist prevents accidental use and reduces the attack surface
        // if a third-party script is ever injected.
        {
          key: "Permissions-Policy",
          value: [
            "camera=()",
            "microphone=()",
            "geolocation=()",
            "interest-cohort=()",   // FLoC / Privacy Sandbox opt-out
            "payment=()",
            "usb=()",
          ].join(", "),
        },

        // ── Content Security Policy ──────────────────────────────────────
        // Report-Only by default; set NEXT_PUBLIC_CSP_ENFORCE=true to
        // switch to enforcement mode.  See rollout model at the top of
        // this file.
        {
          key: CSP_HEADER_NAME,
          value: cspDirectives,
        },

        // ── CSP rollout stage (informational) ────────────────────────────
        // Exposes the current rollout stage so integration tests and
        // operators can assert whether enforcement is active.
        {
          key: "X-CSP-Rollout-Stage",
          value: CSP_ENFORCE ? "enforce" : "report-only",
        },
      ],
    },
  ];
}

const nextConfig = {
  reactStrictMode: true,

  headers: securityHeaders,

  webpack: (config, { isServer }) => {
    // sodium-native is a Node-only native module used by stellar-base for signing.
    // On the browser it is never needed (Freighter handles signing).
    // Alias it to an empty module so webpack doesn't choke on it.
    config.resolve.alias = {
      ...config.resolve.alias,
      "sodium-native": false,
    };

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        path: false,
        os: false,
        stream: false,
        buffer: false,
      };
    }

    return config;
  },
};

module.exports = nextConfig;
