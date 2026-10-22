# Indexer transport notes (issues #797 / #798)

## SSE vs bounded polling

| | SSE (`NEXT_PUBLIC_INDEXER_EVENTS_URL`) | Bounded polling (default) |
|---|---|---|
| Freshness | push, ~instant | `intervalMs` (default 5s, max 12 polls) |
| Server cost | one idle conn/client | N short GETs/client, self-terminating |
| Proxy requirements | buffering OFF (`X-Accel-Buffering: no`), idle timeout > 60s, sticky LB | none beyond normal GET caching |
| Failure mode | reconnect with backoff (max 5), then polling, then manual refresh | stops silently, manual refresh remains |

Recommendation: ship polling by default; enable SSE only where the proxy
checklist above is satisfied. Measure `GET /circles` RPM and concurrent
detail-page viewers before enabling streams fleet-wide.

## Payload (minimal, no wallet data)

`{ "circleAddress": "C…", "latestLedger": 12345 }` — projection only.
Clients MUST NOT treat it as on-chain confirmation.

## Discovery query params (issue #798)

`GET /circles?status=&sort=&order=&page=&limit=` — server filters/sorts/
paginates (never fetch-all-then-filter). Invalid values fall back:
status→All, sort→created_ledger, order→desc, page→1.
