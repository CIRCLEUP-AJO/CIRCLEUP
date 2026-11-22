# CircleUp SDK HTTP reads

See the [versioned HTTP reference](../docs/api/README.md) and [OpenAPI v1.0.0](../docs/api/v1/openapi.json). The indexer serves the same JSON at /openapi/v1.json.

IndexerClient.getCircleHistory(address, {page, limit}, requestOptions) returns one bounded flat event page. getMemberContributions also retains its pagination metadata. getCircleAuditEvents accepts page/limit in its options; getReputation accepts page/limit/circle with read request options. Check pagination.hasMore and totalPages before treating a page as complete history. getRounds is a bounded grouped convenience view and returns HTTP 413 when too large; use getCircleHistory to retrieve every stored record. Records are not pruned.

Read options accept a random UUIDv4 requestId and onRequestId callback. Omit requestId to generate a fresh ID where Web Crypto is available, or have the server supply it. onRequestId receives a sanitized response ID even for an HTTP failure. IDs are diagnostic only and must never include a wallet identity.

Amounts are decimal stroop strings. Persisted ledger columns are decimal strings, and computed ledgers and counters are safe JSON integers. Each field has exactly one form, listed in [INDEXER_NUMERIC_WIRE_FORMAT.md](../docs/INDEXER_NUMERIC_WIRE_FORMAT.md). Member reputation and join metadata can be null; detail rows may omit contribution totals.

## Cursor pagination

For deep histories, use getMemberContributionsByCursor(member, {circle, cursor, limit}) and getCircleActivityByCursor(address, {cursor, limit}), or their iterate…ByCursor walkers. Omit cursor to start, then pass the previous page's pagination.nextCursor; null marks the final page. Cursor pages never shift when rows are indexed between requests. They carry {limit, hasMore, nextCursor} and no total. An indexer HTTP 400 means the cursor is invalid or was issued for another query; restart without one. The page-based methods are unchanged.

## Read timeouts and cancellation

Every RPC-backed read (getConfig, getStatus, getCurrentRound, getCollateral, getDefaults, hasContributed, getFullState, getScore, the factory reads and lookupTransaction) accepts ReadOptions {timeoutMs, signal}. One deadline covers every retry. The default is DEFAULT_RPC_READ_TIMEOUT_MS (20 s); change it per client with setReadTimeout(ms). A read stopped by its deadline or by the caller throws RpcReadCancelledError, whose reason is "timeout" or "aborted". The …Result variants and lookupTransaction return {ok: false, cancelled} instead, so a local stop is never confused with a remote error. The Soroban RPC transport cannot abort a request in flight: the SDK stops waiting and ignores the late response. Stopping a lookupTransaction never means the transaction was cancelled, so look it up again. Writes are unaffected: confirmation polling is bounded by PollConfig. IndexerClient reads already take timeoutMs and signal through their request options.

## Wallet adapters

WalletAdapter is an optional, server-safe interface over a wallet provider, covering capabilities, getAddress, getNetwork, signTransaction and watchChanges. signWithWalletAdapter(adapter, xdr, {networkPassphrase, accountToSign}) checks the signing capability, the active account and the network before any prompt. It returns an explicit WalletFailure (not_available, unsupported_capability, account_mismatch, network_mismatch, user_rejected, provider_error) instead of throwing. It never submits; simulate, send and poll stay with the caller. The app's Freighter implementation is app/src/lib/walletAdapter.ts.

## Network identity

A client is bound to one network when it is constructed. The network is decided by the passphrase, which is what a signature commits to. The RPC URL only says where requests go and is never used to work out the network. CircleUpConfig takes an optional `network` ("testnet", "mainnet" or "custom"):

| `network` | `networkPassphrase` | Result |
|-----------|---------------------|--------|
| omitted | a preset passphrase | Network resolved from the passphrase |
| `"testnet"` / `"mainnet"` | must be that preset's passphrase | Mismatch rejected |
| `"custom"` | non-empty, non-preset passphrase, with `rpcUrl` | Custom network, no explorer links |

A public preset RPC URL paired with another network's passphrase is rejected. Use resolveNetworkIdentity(config) to check a configuration on its own. client.getNetworkIdentity() and client.getResolvedConfig() return frozen copies, and client.explorerLink(type, id) returns null on custom networks. Every write checks the configuration again before it is built. If the config object was mutated to another network, the write fails with errorCode "network_mismatch" and nothing is signed. Structured log events carry `network` (the name only).

## Retry policy

RETRY_POLICY lists the retry rule for each stage:

| Stage | Automatic retry |
|-------|-----------------|
| account, simulation, lookup, read | Transient and throttled errors (classifyRpcFailure), bounded attempts, exponential backoff with jitter |
| wallet | Never. A rejection is the user's decision |
| submission | Resends only the identical signed envelope after a transient error. Never rebuilds or re-signs. An ambiguous send is resolved by looking up the hash |
| polling | Runs within PollConfig. A local timeout returns "timeout" or "outcome_unknown" with the hash, not a failure |

The SDK never submits a second transaction on its own. Rebuild a write only when isRetryable(failure) is true, meaning the SDK has evidence the original was never applied.

## Transaction lifecycle

txLifecycleFromResult(result) and txLifecycleFromLookup(lookup, {validUntil}) map a write or a lookup to one of these states:

- `not_applied`: never applied, safe to rebuild.
- `submitted`: accepted by the RPC, confirmation not yet observed.
- `pending`: not yet included, or the local polling budget ran out.
- `confirmed`: included and succeeded.
- `failed`: included and failed.
- `unavailable`: the RPC is unreachable or stale.

`confirmed` and `failed` reflect what the configured RPC's getTransaction reported (`source: "rpc"`). The SDK promises nothing beyond that. A missing record (NOT_FOUND) stays `pending` until the envelope's time bound has passed, and it is never reported as a cancellation. To resume after a timeout, call client.waitForTransaction(hash, {validUntil, accepted}). It polls by hash and never resubmits. See examples/public-api.ts (`settle`).

## Error taxonomy

classifySdkError(err, stage?) maps a TxFailure, WalletFailure, IndexerError, RpcReadCancelledError or any thrown provider error to `{stage, code, retry, retryable, txHash?, message}`:

- Branch on `code` (for example "wallet_rejected", "network_mismatch", "simulation_failed", "contract_error", "send_ambiguous", "poll_timeout", "indexer_response") instead of parsing message text.
- `retry` is "safe", "after_lookup" or "never".
- `message` is written by the SDK and never contains provider text.
- An unrecognised error is classified as "unknown" and is not retryable.
- SdkError.from(err) wraps any failure for throwing. The raw value stays on a non-enumerable `cause`, so it is left out of JSON.

## Compatibility and Semantic Versioning Policy

For versioning guarantees, deprecation timelines, release checklists, and migration paths, see [docs/SDK_COMPATIBILITY.md](../docs/SDK_COMPATIBILITY.md).

- **Supported Surface**: Only symbols exported from `@circleup/sdk` root (`sdk/src/index.ts`). Deep imports are unsupported.
- **Pre-1.0 SemVer**: `0.x.Y` patch releases are backward-compatible. `0.X.0` minor releases introduce major features or breaking/ABI updates.
- **Deprecations**: Kept for a minimum of 1 minor release with `@deprecated` replacements.
- **Privacy & State Isolation**: Zero telemetry without opt-in `TxLogger`. Multi-client instances run completely isolated in the same process.

