/**
 * Canonical Stellar / Soroban address validators.
 *
 * Stellar has two address namespaces used throughout this project:
 *
 *  • Stellar public key  ("G…")  — 56-character base32 encoded ed25519 key.
 *    Used for: wallet addresses, member addresses, fee-account addresses.
 *    Pattern: starts with "G", followed by 55 uppercase base32 chars [A-Z2-7].
 *
 *  • Soroban contract ID ("C…")  — 56-character base32 encoded 32-byte hash.
 *    Used for: circle addresses, factory address, reputation address, USDC address.
 *    Pattern: starts with "C", followed by 55 uppercase base32 chars [A-Z2-7].
 *
 * A "canonical address" is either of the above — useful when the caller accepts
 * both wallets and contracts (e.g. member lists that may include contract-based
 * multisigs, or generic input validation in route handlers).
 *
 * All functions are pure / synchronous and impose zero runtime dependencies
 * beyond a RegExp test; they are safe to call in server components, Edge
 * middleware, and the Soroban RPC layer alike.
 */

// ─── Regex constants ──────────────────────────────────────────────────────────

/**
 * Matches a Stellar ed25519 public key.
 * Format: "G" followed by exactly 55 base32 characters (uppercase A–Z, digits 2–7).
 * Total length: 56 characters.
 */
const STELLAR_PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;

/**
 * Matches a Soroban contract ID.
 * Format: "C" followed by exactly 55 base32 characters (uppercase A–Z, digits 2–7).
 * Total length: 56 characters.
 */
const SOROBAN_CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

// ─── Validators ───────────────────────────────────────────────────────────────

/**
 * Returns `true` when `address` is a valid Stellar ed25519 public key.
 *
 * A valid public key starts with "G" and is 56 characters of base32
 * (uppercase letters A–Z and digits 2–7).  This matches what Freighter,
 * Stellar Laboratory, and the Stellar SDK produce for wallet addresses.
 *
 * @example
 * isStellarPublicKey("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN") // true
 * isStellarPublicKey("CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN") // false (C prefix)
 * isStellarPublicKey("GAAZI4") // false (too short)
 */
export function isStellarPublicKey(address: string): boolean {
  return STELLAR_PUBLIC_KEY_RE.test(address);
}

/**
 * Returns `true` when `address` is a valid Soroban contract ID.
 *
 * A valid contract ID starts with "C" and is 56 characters of base32
 * (uppercase letters A–Z and digits 2–7).  This matches what `stellar contract
 * deploy` and the Soroban SDK produce when deriving a contract address.
 *
 * @example
 * isSorobanContractId("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM") // true
 * isSorobanContractId("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN") // false (G prefix)
 */
export function isSorobanContractId(address: string): boolean {
  return SOROBAN_CONTRACT_ID_RE.test(address);
}

/**
 * Returns `true` when `address` is either a valid Stellar public key or a
 * valid Soroban contract ID.
 *
 * Use this for inputs that may legitimately be either type — for example,
 * route parameters in the API (`:address`, `:member`) and wallet fields that
 * could contain multisig contracts.
 *
 * @example
 * isCanonicalStellarAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN") // true (G-key)
 * isCanonicalStellarAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM") // true (C-contract)
 * isCanonicalStellarAddress("not-an-address") // false
 */
export function isCanonicalStellarAddress(address: string): boolean {
  return isStellarPublicKey(address) || isSorobanContractId(address);
}

// ─── Assertion helpers ────────────────────────────────────────────────────────

/**
 * Throws a `TypeError` with a descriptive message when `address` is not a
 * valid Stellar public key.
 *
 * Intended for use in internal API boundaries where an invalid address is a
 * programming error (e.g. calling `invokeContract` with a bad `walletAddress`).
 * For user-facing input validation, prefer the boolean form
 * {@link isStellarPublicKey} so the caller controls the error surface.
 */
export function assertStellarPublicKey(address: string, label = "address"): void {
  if (!isStellarPublicKey(address)) {
    throw new TypeError(
      `[address] Invalid Stellar public key for ${label}: "${address}". ` +
        `Expected a G-prefixed 56-character base32 string.`,
    );
  }
}

/**
 * Throws a `TypeError` with a descriptive message when `address` is not a
 * valid Soroban contract ID.
 *
 * Intended for use in internal API boundaries (e.g. calling `readContract`
 * with a bad `contractId`).  For user-facing validation prefer
 * {@link isSorobanContractId}.
 */
export function assertSorobanContractId(address: string, label = "address"): void {
  if (!isSorobanContractId(address)) {
    throw new TypeError(
      `[address] Invalid Soroban contract ID for ${label}: "${address}". ` +
        `Expected a C-prefixed 56-character base32 string.`,
    );
  }
}

/**
 * Throws a `TypeError` with a descriptive message when `address` is neither a
 * valid Stellar public key nor a valid Soroban contract ID.
 *
 * Use at API / route-handler boundaries that accept both address types.
 */
export function assertCanonicalStellarAddress(address: string, label = "address"): void {
  if (!isCanonicalStellarAddress(address)) {
    throw new TypeError(
      `[address] Invalid Stellar address for ${label}: "${address}". ` +
        `Expected a G-prefixed public key or C-prefixed contract ID (56 base32 chars each).`,
    );
  }
}
