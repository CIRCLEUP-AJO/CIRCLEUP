# CircleUp SDK HTTP reads

See the [versioned HTTP reference](../docs/api/README.md) and [OpenAPI v1.0.0](../docs/api/v1/openapi.json). The indexer serves the same JSON at /openapi/v1.json.

IndexerClient.getCircleHistory(address, {page, limit}, requestOptions) returns one bounded flat event page. getMemberContributions also retains its pagination metadata. getCircleAuditEvents accepts page/limit in its options; getReputation accepts page/limit/circle with read request options. Check pagination.hasMore and totalPages before treating a page as complete history. getRounds is a bounded grouped convenience view and returns HTTP 413 when too large; use getCircleHistory to retrieve every stored record. Records are not pruned.

Read options accept a random UUIDv4 requestId and onRequestId callback. Omit requestId to generate a fresh ID where Web Crypto is available, or have the server supply it. onRequestId receives a sanitized response ID even for an HTTP failure. IDs are diagnostic only and must never include a wallet identity.

Amounts are decimal stroop strings. DB ledger values may be decimal strings, while computed ledgers are numbers. Member reputation and join metadata can be null; detail rows may omit contribution totals.
