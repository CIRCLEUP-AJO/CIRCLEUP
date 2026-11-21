# Issue design notes: app discovery and resilience (Issues 120–123)

These notes cover four related app issues. Each one records how the code behaves today (checked against `main` at `705e921`), the decisions the issue asks for, a proposed design, and a test plan tied to the acceptance criteria.

| Issue | GitHub | Topic | Doc |
|---|---|---|---|
| 120 | #956 | Separate read-only browsing from write-configuration failures | [issue-120-capability-config.md](issue-120-capability-config.md) |
| 121 | #957 | Make homepage labels and counts reflect the actual circle query | [issue-121-homepage-labels-counts.md](issue-121-homepage-labels-counts.md) |
| 122 | #958 | Accessible next/previous controls for paginated discovery | [issue-122-paginated-discovery.md](issue-122-paginated-discovery.md) |
| 123 | #959 | Explicit partial-data policy for circle detail sections | [issue-123-detail-partial-data.md](issue-123-detail-partial-data.md) |

## Blocker shared by 121 and 122

`indexer/src/api.ts` does not compile on `main`. `npx tsc --noEmit` in `indexer/` reports:

- `GET /circles` returns `pagination.total` and `totalPages`, but nothing in the handler declares `total`. At runtime this throws a `ReferenceError`, the handler's `catch` turns it into a `500`, and the homepage would always show "Circles list unavailable".
- `sendError`, `getErrorMessage`, `buildCorsOptions` and `apiRateLimiter` are referenced but not defined or imported. This was probably lost while merging #139 and #140.

Fix these first, in a separate PR. The `total` fix should run a `SELECT COUNT(*) FROM circles c ${whereClause}` with the same filter as the page query. Issues 121 and 122 both depend on `pagination.total` being correct.

## Suggested order

1. Indexer compile fix (blocker above).
2. **120**: capability-typed configuration. Later work reads its `read`/`write` states.
3. **121**: an explicit homepage query and labels. This also brings in the shared list-fetch helper.
4. **122**: pagination on top of the helper from 121.
5. **123**: the detail page partial-data policy. It uses the write gates from 120.

## Test infrastructure note

`app/package.json` has no test runner. The indexer and SDK already use tests (`*.test.ts`). Before the server-component tests these issues ask for, add a runner to `app/` that matches the indexer's (plus `@testing-library/react` for component output). Make it a small, separate commit inside whichever issue lands first.
