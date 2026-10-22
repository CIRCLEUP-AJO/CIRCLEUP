# Versioned HTTP API

[OpenAPI 3.1 reference, v1.0.0](v1/openapi.json) is served at `GET /openapi/v1.json`. Ship docs/api/v1/openapi.json alongside the indexer build; the route resolves it relative to src/dist. Import the JSON into an OpenAPI viewer or client generator. Version labels the contract; existing endpoint paths are unchanged.

All routes are unauthenticated public reads. CORS follows ALLOWED_ORIGINS. Errors preserve legacy `{error: string, detail?, address?}` and structured `{error: {message, details}}` envelopes. Amounts are decimal integer stroop strings. Database BIGINT ledger fields can be strings; computed ledger/deadline values are numbers. Nullable fields and optional fields are distinct. Extra response fields are compatible additions.

## Histories and retention

Records are retained indefinitely in the database. Nothing is deleted or archived by this policy. History pages use `page` (1-based, default 1) and `limit` (default 20, maximum 100). Repeated, unsafe, non-integer or over-limit paging values return 400 before queries. Pagination reports page, limit, total, totalPages and hasMore. Empty scopes have totalPages=0; final/out-of-range pages have hasMore=false. Pages reflect live data; restart a page walk after replay changes earlier records.

- Member contributions: ledger, round_index, created_at, id descending; totalAmount covers all pages.
- Circle flat history: contribution/default/payout records ordered ledger, kind, id ascending. Maximum 100 entries per page; monetary and ledger strings preserve precision.
- Audit: created_at, id ascending, maximum 100 records.
- Reputation: page unit is a distinct circle address across both summary arrays, ascending. Both arrays cover the same page, so one may be empty while hasMore=true.
- Grouped rounds: complete only when each source kind has at most 100 rows. Reads 101 per kind to detect overflow and returns 413 above the bound, directing callers to flat history. Convenience fields repeat some references. CSV remains capped at 10,000 records and returns 413 above that limit.

Use flat history for predictable response sizes. Rosters and reconciliation have separate member bounds. Indexer failures is a bounded diagnostic sample, not a full history; count is the number returned.

## Correlation IDs

App reads generate random UUIDv4 IDs. SDK reads generate IDs where Web Crypto is available, otherwise the server generates them. SDK callers can supply requestId and receive a sanitized server ID through onRequestId, including HTTP errors. In a browser, inspect the exposed X-Request-ID response header and search structured api_request logs for the same value.

Only one UUIDv4 header is accepted. Missing, duplicate, malformed, wallet-shaped and comma-joined values are replaced. IDs are never authentication. Tracing records method, matched route template, status, duration and ID; no actual path addresses, queries, bodies or signing material. It applies only to GET/HEAD. Never use IDs as metric labels.

No in-process ID history is stored. Configure the external deployment log collector for at most seven days and a bounded storage quota (recommended 100 MiB per instance). The existing stdout transport cannot enforce an external collector retention policy. Avoid exporting IDs to analytics.

## Maintaining the reference

Update JSON, SDK wire schemas/types and fixtures together. CI lints OpenAPI, inventories Express GET routes, validates representative SDK bodies, and checks normalized source hashes to force review when implementations change. After reviewing edits, update x-source-sha256 using scripts/update-http-contract.cjs. Hashes require review but do not prove semantic equivalence. Breaking changes require a new version and migration notes.

This patch was prepared without executing commands. Payload measurements, EXPLAIN plans and provider quota measurements were not collected. Measure maximum pages and grouped overflow on staging before tuning deployment settings.
