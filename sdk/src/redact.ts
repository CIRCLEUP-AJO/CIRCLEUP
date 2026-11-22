/**
 * Privacy-safe diagnostics and log redaction for @circleup/sdk (Issue #912).
 *
 * Excludes private keys (S-keys), seed phrases, signed transaction envelopes (XDR),
 * URL credentials, and unbounded raw provider payloads from public error strings and diagnostics.
 */

const S_KEY_REGEX = /\bS[A-Za-z0-9]{55}\b/g;
const G_OR_C_ADDR_REGEX = /\b[GC][A-Za-z0-9]{55}\b/g;
const SEED_PHRASE_REGEX = /\b([a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/gi;
const URL_CREDENTIALS_REGEX = /(https?:\/\/)([^:/@\s]+):([^@\s]+)@/gi;
const BASE64_XDR_REGEX = /\b(?:AAAA[A-Za-z0-9+/=]{60,}|[A-Za-z0-9+/=]{120,})\b/g;

/** Maximum length for error detail messages from external providers. */
export const MAX_SAFE_DIAGNOSTIC_LENGTH = 200;

/**
 * Allowlisted diagnostic fields permitted in public serialized error summaries.
 */
export const ALLOWLISTED_DIAGNOSTIC_FIELDS = Object.freeze([
  "stage",
  "code",
  "retry",
  "retryable",
  "txHash",
  "message",
  "operation",
  "network",
  "contractError",
] as const);

export type AllowlistedDiagnosticField = (typeof ALLOWLISTED_DIAGNOSTIC_FIELDS)[number];

/** Check if a string is a valid 64-hex transaction hash. */
export function isSafeTxHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^[0-9a-fA-F]{64}$/.test(hash);
}

/** Remove user/password credentials from an endpoint URL. */
export function sanitizeEndpointUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return rawUrl.replace(URL_CREDENTIALS_REGEX, "$1");
  }
}

/**
 * Redact sensitive patterns from a text string.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== "string") return "";

  let cleaned = text.replace(URL_CREDENTIALS_REGEX, "$1[redacted:auth]@");
  cleaned = cleaned.replace(S_KEY_REGEX, "[redacted:secret-key]");
  cleaned = cleaned.replace(SEED_PHRASE_REGEX, "[redacted:seed]");
  cleaned = cleaned.replace(BASE64_XDR_REGEX, "[redacted:xdr]");

  if (cleaned.length > MAX_SAFE_DIAGNOSTIC_LENGTH) {
    cleaned = cleaned.slice(0, MAX_SAFE_DIAGNOSTIC_LENGTH - 3) + "...";
  }

  return cleaned;
}

/**
 * Scrub addresses from text when privacy policy requires complete address hiding.
 */
export function redactAddresses(text: string): string {
  if (!text || typeof text !== "string") return "";
  return text.replace(G_OR_C_ADDR_REGEX, "[redacted:address]");
}

/**
 * Filter an object down to strictly allowlisted diagnostic fields and redact string values.
 */
export function sanitizeDiagnosticsRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const key of ALLOWLISTED_DIAGNOSTIC_FIELDS) {
    if (!(key in record) || record[key] === undefined) continue;

    const val = record[key];
    if (key === "txHash") {
      if (isSafeTxHash(val)) {
        sanitized.txHash = (val as string).toLowerCase();
      }
    } else if (typeof val === "string") {
      sanitized[key] = redactSecrets(val);
    } else if (typeof val === "object" && val !== null) {
      sanitized[key] = JSON.parse(JSON.stringify(val));
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}
