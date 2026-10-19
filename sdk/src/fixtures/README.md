# Soroban RPC Response Fixtures & Parsing Contracts

This directory contains versioned, sanitized response fixtures representing Soroban RPC payloads observed across supported Stellar network protocols (Protocol 21 and Protocol 22+).

## RPC Method Inventory

The following RPC methods and field contracts are relied upon by the SDK, Indexer, and frontend applications:

| Method | Component | Key Fields Inspected | Handling / Tolerances |
|---|---|---|---|
| `getEvents` | Indexer, SDK | `events`, `latestLedger`, `events[].id`, `events[].ledger`, `events[].contractId`, `events[].topic`, `events[].value`, `events[].pagingToken` | Required: `events`, `latestLedger`, core event attributes.<br>Optional: `pagingToken`, `inSuccessfulContractCall`, `txHash`.<br>Additive: Unrecognized fields ignored. |
| `simulateTransaction` | SDK | `latestLedger`, `minResourceFee`, `cost` (`cpuInsns`, `memBytes`), `results`, `result`, `transactionData`, `events`, `error`, `restorePreamble` | Required: `latestLedger` and either `minResourceFee` (success) or `error` (rejection).<br>Optional: `cost`, `results`, `restorePreamble`. |
| `sendTransaction` | SDK | `status` (`PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER`, `ERROR`), `hash`, `latestLedger`, `latestLedgerCloseTime`, `errorResult` | Required: `status`, `hash`.<br>Optional: `errorResult`, `diagnosticEvents`. |
| `getTransaction` | SDK | `status` (`SUCCESS`, `NOT_FOUND`, `FAILED`), `latestLedger`, `ledger`, `resultXdr`, `resultMetaXdr`, `diagnosticEventsXdr` | Required: `status`, `latestLedger`. `ledger` required on `SUCCESS`.<br>Optional: `resultXdr`, `diagnosticEventsXdr` (absent on `NOT_FOUND`). |
| `getLatestLedger` | Indexer, SDK | `sequence`, `id`, `protocolVersion`, `ledgerCloseTime` | Required: `sequence`, `id`.<br>Optional: `protocolVersion`, `ledgerCloseTime`. |

## Sanitization Guarantees

Every fixture in `versionedRpcFixtures.ts` conforms to strict sanitization rules:
1. **Zero Secrets**: No private keys, seed phrases, or sensitive hashes.
2. **Deterministic StrKeys**: Public addresses use deterministic test strkeys derived from constant byte sequences (e.g. `CAAA...` and `GAAA...`).
3. **Fixed Transaction Identifiers**: Transaction hashes use constant hex patterns (`0000...0001`).

## Version Association

- **Protocol 21 (`V21_RPC_FIXTURES`)**:
  - Baseline Soroban RPC release on Mainnet and Testnet.
  - Standard simulation structure with single and multi-result return values.
- **Protocol 22+ (`V22_RPC_FIXTURES`)**:
  - Enhanced diagnostic payloads, `diagnosticEventsXdr`, `unrestoredPagingToken`, and extended transaction metadata.

## Fixture Update Procedure

When upgrading to a new Stellar Core or Soroban RPC version:
1. Inspect new or modified response fields in the official Stellar Soroban RPC specification.
2. Capture a sanitized response payload from the Testnet/Futurenet RPC endpoint.
3. Replace all addresses, hashes, and account keys with deterministic test constants.
4. Add the fixture entry under the corresponding protocol version in `versionedRpcFixtures.ts`.
5. Run the schema test suite:
   ```bash
   npm test --workspace=sdk -- src/__tests__/versionedRpcFixtures.test.ts
   ```
6. Ensure new optional fields pass without breaking existing consumers (safe additive changes).
