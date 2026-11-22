# Issue 121 (#957): Make homepage labels and counts reflect the actual circle query

## Problem

The homepage heading says **"Active Circles (N)"**, but the list behind it doesn't match that label in two ways:

1. **Status.** `getCircles()` in `app/src/app/page.tsx` calls `GET ${INDEXER_URL}/circles` with no query parameters. That returns circles in every lifecycle status (`Pending`, `Active`, `Completed`, `Cancelled`), so completed and cancelled circles appear under an "Active" heading.
2. **Count.** `N` is `circles.length`, the length of *one page* (at most 20, the default limit). It is not the number of matching circles. A registry of 500 circles shows "(20)".

The issue text also mentions a "Browse open circles" CTA. `main` doesn't have one. The only CTAs are "Create a Circle" (hero) and "+ New circle" (list header). Whatever CTA copy we add has to follow the same rule as the heading.

## Current indexer behaviour (`indexer/src/api.ts`)

| Parameter | Default | Accepted values |
|---|---|---|
| `status` | *none*: no `WHERE` clause, so all statuses | `Pending`, `Active`, `Completed`, `Cancelled` (one value only, case-sensitive) |
| `sort` | `created_ledger` | `created_ledger`, `updated_at`, `round_amount`, `member_count`, `status` |
| `order` | `desc` | `asc`, `desc` |
| `page` | `1` | positive integer |
| `limit` | `20` | 1–100 |

Response: `{ circles, pagination: { page, limit, total, totalPages } }`.

`GET /circles/summary` returns `{ total, byStatus: { Pending, Active, Completed, Cancelled } }`. This is the registry-wide count and ignores filters.

> **Blocker:** `pagination.total` is undeclared in the handler. See [README](README.md#blocker-shared-by-121-and-122).

## Decision: homepage population

| Option | Query | Heading | Notes |
|---|---|---|---|
| **A. Open circles (recommended)** | `status=Pending&sort=created_ledger&order=desc` | "Open circles" | Matches the discovery use case. The detail page only offers **Lock Collateral & Join** when `status === "Pending"`, so these are the only circles a visitor can act on. |
| B. Active circles | `status=Active` | "Active circles" | Running circles that nobody can join. Useful for social proof, but nothing to do with them. |
| C. All circles | no `status` | "All circles" | Honest, but the label must not imply activity, and each card needs a visible status badge. |

The API accepts only one `status`, so "Pending + Active" needs either two requests or an API change to support `status=Pending,Active`. Leave that out of scope unless product wants it.

**Recommendation: Option A.** Product and protocol owners must confirm this before the PR merges. Whichever option wins, it lives in one constant, so switching later is a one-line change:

```ts
// app/src/lib/discovery.ts
export const HOMEPAGE_QUERY = {
  status: "Pending",
  sort: "created_ledger",
  order: "desc",
  limit: 12,
} as const;
```

## Design

### 1. One fetch, explicit parameters

- Replace `getCircles()` with `fetchCircleList(query)` in `app/src/lib/discovery.ts`. It builds the URL with `URLSearchParams` from an explicit query object and never relies on indexer defaults.
- Return a typed result:
  ```ts
  type CircleListResult =
    | { ok: true; circles: Circle[]; pagination: Pagination; query: CircleListQuery }
    | { ok: false; error: "network" | "parse" | "server" | "misconfigured" };
  ```
- Validate `pagination` (all four fields are non-negative integers). A response without it is a `parse` error. The page must not fall back to `circles.length`.
- `HomePage` currently calls `getCircles()` twice (once for the heading, once inside `<CirclesList>`). Fetch once and pass the result down, or wrap the helper in React `cache()`, so the heading and list always come from the **same** response.

### 2. Labels derived from the query

Keep one label table keyed by status so the heading, CTA and empty state cannot drift apart:

| Status filter | Heading | CTA | Empty state |
|---|---|---|---|
| `Pending` | Open circles | Browse open circles → | "No circles are open to join right now." + "Create one" link |
| `Active` | Active circles | Browse active circles → | "No circles are running right now." |
| *(none)* | All circles | Browse all circles → | "No circles have been created yet." + "Create the first one" link |

The current "No circles yet." message is only correct with no filter. With a filter it is false whenever circles exist in other statuses.

### 3. Filtered count vs. registry total

- The heading count is the **filtered** `pagination.total`. For example: "Open circles · 7".
- If the registry total is shown, it comes from `/circles/summary.total` and gets its own label, for example "7 open of 132 circles". It must never be presented as the count of the list.
- If `/circles/summary` fails, drop the registry total and keep the filtered count. A failed summary request doesn't make the list unavailable.
- If the list fetch fails, show no count at all rather than a stale or partial one.

### 4. Cards outside the filter

With Option C, `CircleCard` must show a status badge so a `Completed` card is never mistaken for an active one. With A or B every card has the same status by construction, but keep the badge: it's cheap and stays correct if the query changes.

## Test plan

Mock `fetch` in server-component tests. See the README note about adding a test runner.

| Case | Indexer response | Expect |
|---|---|---|
| Explicit params | any | Request URL contains `status=Pending`, `sort=created_ledger`, `order=desc`, `limit=12` |
| Mixed statuses | rows with all four statuses (simulating a regressed filter) | No card for a non-matching status is rendered, or each card shows its own status. The heading never says "Active" for Option A or C |
| Count uses total | 12 rows, `total: 40` | Heading shows 40, not 12 |
| Empty filtered list | `circles: []`, `total: 0`, summary `total: 9` | Filter-specific empty copy. No "No circles yet" |
| Summary fails | list ok, summary 500 | Filtered count shown, registry total hidden, no error banner |
| Indexer failure | network error / 500 / malformed JSON / missing `pagination` | Existing `IndexerErrorBanner` and no count in the heading |
| Single fetch | any | `/circles` requested once per render |

## Acceptance criteria mapping

- *Heading, CTA and count describe the same server-side result set.* Labels come from `HOMEPAGE_QUERY`, the count comes from that request's `pagination.total`, and one fetch feeds both.
- *A circle in a different lifecycle status is excluded or shown under a non-implying label.* The explicit `status` filter excludes it, or the "All circles" label plus a per-card badge covers it.
