/**
 * Redaction helpers for deployment and seed scripts.
 *
 * Stellar secret keys (S-prefixed, 56 uppercase base32 characters) must never
 * appear in deployment logs. This module provides a single redactSecrets()
 * function that masks any such pattern before text is emitted to the console.
 *
 * Scope: scripts package only. The indexer has its own redaction module at
 * indexer/src/redact.ts which handles address and tx-hash shortening for
 * structured event logs.
 */

/** Stellar secret key: S followed by exactly 55 uppercase base32 characters. */
const SECRET_KEY_RE = /S[A-Z2-7]{55}/g;

/**
 * Replace any Stellar secret key found in `text` with `[SECRET_REDACTED]`.
 * Returns the original string unchanged when no secret key pattern is found.
 *
 * This is intentionally conservative: it only masks the textbook pattern
 * (S + 55 base32 chars). Use this on all command output and error messages
 * before logging them.
 */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_KEY_RE, "[SECRET_REDACTED]");
}
