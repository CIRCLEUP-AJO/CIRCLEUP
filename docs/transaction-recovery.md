# Transaction recovery and deployment evidence

The app's Recent transactions link is available from every route. A receipt contains only the public transaction hash, exact network passphrase, and a boolean recording whether submission was accepted. At most 20 receipts are stored in localStorage. Clear saved receipts explicitly removes them. No account, arguments, amount, envelope, XDR, private key, or raw provider response is persisted. A hash is saved before the one broadcast attempt, so a lost submission response can be investigated. Storage failure does not prevent submission.

The app does not depend on the CircleUp SDK package. Its read-only status adapter mirrors the SDK lookupTransaction result categories. SUCCESS and FAILED are chain results. NOT_FOUND means absent from this RPC's retained history, not canceled or failed. For a receipt known to have been accepted, NOT_FOUND is shown as pending confirmation observation; this is local submission evidence, not a separate RPC pending result. A manual unknown hash has no acceptance evidence and is shown as not found. Exceptions, malformed responses and read deadlines are temporarily unavailable. No lookup calls a write API.

Each reopened observation makes at most ten calls, separated by two seconds, each with an eight-second local deadline (at most 98 seconds plus scheduling delay). A transient error stops observation and offers Retry status check. Navigation aborts local observation and timers. Underlying RPC promises may finish later but their results are ignored. A timeout never implies on-chain cancellation. Network identity is the passphrase, including for custom networks; a receipt from another configured network cannot be queried against the current one.

Wallet provider accountChanged and networkChanged events synchronously increment an identity revision, revoke deployment verification and abort local action observation. Detail pages clear the address, member-derived eligibility, pending default confirmation, retry closures and member receipt UI before re-resolving the wallet. Shared circle data remains visible. A generation guard discards old wallet resolutions. A write checks the revision across simulation, checks the authoritative wallet address before signing and after signing, and compares the signed envelope source and body hash with the prepared transaction. An open wallet prompt cannot be canceled, but its result cannot be broadcast after invalidation. Already-broadcast receipts remain independently readable.

## Deployment checks

Verification is explicit via Verify deployment. SDK/client construction remains offline. The app compares getNetwork passphrase with configuration, factory get_usdc_token and get_reputation_contract with configured addresses, reputation get_admin with the address shape, and token decimals with seven. A matching check is verified; a well-formed conflicting value is mismatch; unavailable, missing code, or malformed getter results are unverifiable. Writes require all app checks and a verification age below five minutes. Read-only browsing and hash lookups remain available regardless of verification.

These checks establish wiring and interface compatibility only. They do not establish issuer authenticity, cryptographic code provenance, or an independently trusted release. The existing SDK verifyDeployment accepts expectedCircleWasmHash from a trusted deployment manifest for an additional factory hash comparison. Without it, the SDK reports only hash presence, as documented. Existing SDK verifyDeployment fixtures cover correct deployment, wrong network, missing contracts, unexpected getter values and RPC failures. The manifest must be supplied by an operator; the app does not treat configuration as proof of provenance.

## Support summaries

SDK transactionSupport maps every public TxErrorCode to canonical guidance and copies only an allowlisted operation, network category, failure category and a validated public hash. Wallet rejection is mapped by the app's typed contract error mapper. The app DiagnosticsPanel regenerates canonical copy from known codes; it never trusts a supplied message. Stages and categories are runtime allowlisted. Endpoint credentials, paths and query strings are excluded; raw provider text, stack traces, XDR and arbitrary error bodies are never copied. Copy/download is local and user initiated.

## Verification checklist (not executed in this change)

- Submit, navigate away, open Recent transactions, then reload: the same network/hash can be selected without a wallet prompt.
- Switch accounts during wallet loading, simulation, default confirmation, signing and confirmation polling: old resolutions and confirmations disappear; no old prepared write is broadcast. Submitted receipts remain.
- Switch configured networks: other-network receipts remain listed but disabled. Restore the original network to check them.
- Check an unknown hash: not found, never failed/canceled. Accepted but unobserved receipts show pending.
- Use an RPC outage or a hung lookup: observation is bounded, shows unavailable and offers a read-only retry. Exhaust the ten-call budget: show an observation-limit advisory.
- Verify correct wiring, wrong network, missing code, malformed getter return and outage: show per-dependency evidence; only passed, fresh verification permits writes. Browsing remains accessible.
- Reject a wallet prompt; cause input, simulation, contract and timeout failures; inject seed/private-key/XDR strings into messages and extra properties: user copy remains canonical and support output includes only allowed fields.

Tests were added as source files only. No test runner, build, package manager, or shell command was executed.
