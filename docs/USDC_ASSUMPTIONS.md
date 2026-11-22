# Deployed USDC Contract Assumptions & Verification

This document records the protocol assumptions regarding the USDC token contract across all CircleUp deployment profiles, distinguishes on-chain verifiable properties from operator-supplied trust assertions, and specifies the executable preflight checks required prior to manifest publication (Issue #892 / Issue 56).

---

## 1. Token Identity & Profiles

CircleUp ROSCA contracts hold collateral deposits and round contributions denominated in USDC on Stellar. The contract addresses expected across deployment profiles are:

| Profile | Target Network | Canonical Address | Asset Code | Decimals | Verification Tier |
|---|---|---|---|---|---|
| **Production** | Stellar Mainnet | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | `USDC` | 7 | Strict Canonical Match |
| **Testnet** | SDF Testnet | Configured SAC / testnet token | `USDC` | 7 | Metadata Simulation |
| **Staging** | Staging / Private Net | Configured staging contract | `USDC` | 7 | Metadata Simulation |

### Mainnet Identity Details
- **Contract Type**: Stellar Asset Contract (SAC) wrapping the native Stellar classic asset.
- **Classic Asset Issuer**: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (Centre / Circle).
- **Classic Asset Code**: `USDC`.
- **SAC Contract ID**: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`.

---

## 2. On-Chain Verifiable vs. Trust Assertions

The executable preflight check distinguishes between properties that can be verified on-chain via read-only RPC calls and operational properties that require an operator trust assertion:

### A. On-Chain Verifiable Facts (Read-Only)
1. **Contract Address Format**: Valid 56-character Stellar StrKey contract identifier (`C...`).
2. **Contract Existence / Deployment**: The contract entry exists on the target ledger and responds to simulation.
3. **Decimal Precision**: Calling `decimals()` via SEP-41 returns exactly `7` (1 USDC = 10,000,000 stroops). Any other value constitutes a fatal financial mismatch.
4. **Token Symbol**: Calling `symbol()` returns `"USDC"`.
5. **Token Name**: Calling `name()` returns a non-empty string (e.g. `"USD Coin"`).
6. **Transfer Interface**: The contract exposes the standard SEP-41 `transfer(from, to, amount)` function.

### B. Operator-Supplied Trust Assertions (Unverifiable On-Chain)
1. **1:1 Reserve Backing**: On-chain bytecode cannot prove that fiat reserves in commercial bank accounts equal the minted token supply; this relies on Circle's third-party attestation reports.
2. **Issuer Key Authority**: The operator asserts that `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` is the authentic Circle issuer account.
3. **Clawback & Revocation Flags**: Whether the issuer retains authorization or clawback capabilities on classic accounts is an issuer-level policy, not a smart contract property.

---

## 3. Preflight Result Taxonomy

The executable check (`scripts/src/check-token-assumptions.ts`) classifies each verification into one of four deterministic outcomes:

- `pass`:
  - Mainnet: Address matches `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`, and live RPC confirms 7 decimals and SEP-41 metadata.
  - Testnet/Staging: Valid contract address format, live RPC confirms contract existence and 7 decimals.
- `mismatch`:
  - Mainnet: Configured address differs from canonical SAC address.
  - Any network: `decimals()` returns a number other than `7`, or `symbol()` returns a token other than `"USDC"`.
  - Manifest inconsistency: Deployed manifest records a different USDC address than the configuration profile.
- `unverifiable`:
  - Contract responds to simulation but does not expose standard SEP-41 metadata (`decimals`, `symbol`), or live ledger inspection cannot inspect source code.
  - Off-chain custody and reserve backing assertions are flagged as unverifiable on-chain.
- `unavailable`:
  - Live RPC endpoint is unreachable or timed out within the bounded limit (default: 5000ms), or the contract does not exist on the connected ledger.

---

## 4. Executable CLI & SDK Preflight

Run the verification before publishing a deployment manifest:
```bash
# Verify against testnet profile
npx ts-node scripts/src/check-token-assumptions.ts --profile testnet

# Verify against production profile
npx ts-node scripts/src/check-token-assumptions.ts --profile production --strict
```

---

## 5. Test doubles are not deployment evidence

The Rust contract suites use the real Stellar Asset Contract as a token test double and drive four named outcomes through the shared [`token_behavior_fixture.rs`](../contracts/circle/src/token_behavior_fixture.rs): success, insufficient funds, authorization rejection and explicit transfer failure. Those tests prove only that CircleUp handles standard SEP-41 success and failure results without leaving partial state.

They do **not** prove anything about the deployed USDC issuer identity, reserve backing, clawback flags, or the correctness of the configured mainnet contract address. Those properties are covered exclusively by the on-chain verification and operator assertions in sections 2–4 above, and by the trust boundary summary in [`CONTRACT_TRUST_BOUNDARIES.md`](./CONTRACT_TRUST_BOUNDARIES.md).

