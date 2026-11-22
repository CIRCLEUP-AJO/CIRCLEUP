/**
 * Explicit transport and URL policy for SDK service endpoints (Issue #914 / Issue 78).
 *
 * Validates RPC and Indexer service URLs against explicit transport policies:
 * - Scheme must be "http:" or "https:" (rejects relative URLs, ftp:, javascript:, etc.)
 * - Embedded credentials (username/password) are strictly forbidden
 * - Query strings and fragments are forbidden on service base URLs
 * - Production environments reject insecure plain HTTP for remote hosts
 * - Local development and custom networks allow HTTP on localhost / 127.0.0.1
 * - Diagnostic errors NEVER echo embedded credentials or query parameters
 */

export interface TransportPolicyOptions {
  /**
   * Runtime environment mode.
   * In "production", remote HTTP endpoints are rejected.
   * Defaults to process.env.NODE_ENV if set, otherwise "development".
   */
  environment?: "production" | "development" | "test";

  /**
   * Target Stellar network name ("mainnet", "testnet", "custom").
   * Targeting "mainnet" enforces production HTTPS rules.
   */
  network?: string;

  /**
   * Explicitly permit HTTP even in production (e.g. for private container networks).
   */
  allowHttp?: boolean;
}

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  normalizedUrl?: string;
}

/** Check whether a hostname is a loopback or local development address. */
export function isLocalhost(hostname: string): boolean {
  if (!hostname) return false;
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    clean === "localhost" ||
    clean === "127.0.0.1" ||
    clean === "::1" ||
    clean === "0.0.0.0" ||
    clean.endsWith(".localhost") ||
    clean.endsWith(".local") ||
    clean.endsWith(".internal") ||
    clean.endsWith(".test")
  );
}

/**
 * Remove any embedded credentials or query string from a URL string for safe
 * diagnostic printing that never leaks secrets.
 */
export function sanitizeUrlForDiagnostic(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  try {
    const parsed = new URL(raw.trim());
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    // If not parseable as URL, strip credentials pattern if any
    return raw
      .replace(/^(https?:\/\/)([^:/@\s]+):([^@\s]+)@/i, "$1[redacted]@")
      .replace(/\?.*$/, "");
  }
}

/**
 * Validate a service URL (RPC or Indexer) against transport policy.
 *
 * @param url       The raw URL input to validate
 * @param fieldName Human-readable name of the config field (e.g. "config.rpcUrl")
 * @param options   Environment and network policy options
 */
export function validateServiceUrl(
  url: unknown,
  fieldName: string = "URL",
  options: TransportPolicyOptions = {},
): UrlValidationResult {
  if (typeof url !== "string" || url.trim() === "") {
    return {
      valid: false,
      error: `${fieldName} is required and must be a non-empty string URL.`,
    };
  }

  const trimmed = url.trim();

  // Check for scheme presence
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return {
      valid: false,
      error: `${fieldName} "${sanitizeUrlForDiagnostic(trimmed)}" is not an absolute URL (missing http:// or https:// scheme).`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: `${fieldName} "${sanitizeUrlForDiagnostic(trimmed)}" is not an absolute URL (missing http:// or https:// scheme).`,
    };
  }

  // If missing "://" and protocol is not a known standard scheme, it's a bare host:port like "localhost:3001"
  if (!trimmed.includes("://") && parsed.protocol !== "javascript:" && parsed.protocol !== "data:" && parsed.protocol !== "file:") {
    return {
      valid: false,
      error: `${fieldName} "${sanitizeUrlForDiagnostic(trimmed)}" is not an absolute URL (missing http:// or https:// scheme).`,
    };
  }

  // Scheme policy: must be http: or https:
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      error: `${fieldName} uses unsupported scheme "${parsed.protocol}". Only "https:" (and "http:" for local development) are allowed.`,
    };
  }

  // Credentials policy: NEVER allow user:pass in service URLs
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: `${fieldName} cannot contain embedded credentials (username/password).`,
    };
  }

  // Query and fragment policy on service base URLs
  if (parsed.search) {
    return {
      valid: false,
      error: `${fieldName} cannot contain query parameters.`,
    };
  }

  if (parsed.hash) {
    return {
      valid: false,
      error: `${fieldName} cannot contain URL fragments.`,
    };
  }

  // Environment transport policy
  const env =
    options.environment ??
    (typeof process !== "undefined" && process.env?.NODE_ENV === "production"
      ? "production"
      : "development");

  const isMainnet = options.network === "mainnet";
  const isProductionMode = env === "production" || isMainnet;
  const isLocal = isLocalhost(parsed.hostname);

  if (isProductionMode && parsed.protocol === "http:" && !options.allowHttp) {
    if (!isLocal) {
      return {
        valid: false,
        error: `${fieldName} must use secure HTTPS in production ("${parsed.origin}" is insecure HTTP).`,
      };
    }
  }

  const normalizedUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  return { valid: true, normalizedUrl };
}
