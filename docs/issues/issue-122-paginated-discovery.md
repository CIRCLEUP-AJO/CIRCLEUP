# Issue 122 (#958): Accessible next and previous controls for paginated circle discovery

## Problem

`GET /circles` supports `page` and `limit`, but the app only ever requests page 1 with the default limit of 20. Anything past the first page can't be reached, there's no URL state, and nothing tells the user how many results exist.

Depends on [Issue 121](issue-121-homepage-labels-counts.md) for the shared `fetchCircleList()` helper and on the indexer `total` fix ([README](README.md#blocker-shared-by-121-and-122)).

## API semantics (verified in `indexer/src/api.ts`)

| Field | Meaning |
|---|---|
| `page` | 1-based. `< 1`, non-integers, `""` and repeated params (`?page=1&page=2`, which parse to `NaN`) return `400` |
| `limit` | 1–`MAX_LIMIT` (100). Anything else returns `400` |
| `offset` | `(page - 1) * limit` |
| `total` | count of rows matching the `status` filter (once fixed) |
| `totalPages` | `Math.ceil(total / limit)`, which is **0** when `total` is 0 |
| Out of range | `page > totalPages` is **not** an error. It returns `200` with `circles: []` and the real `total`/`totalPages` |

`total` and the page rows come from separate queries, so a circle created or changing status between them can make `total` differ from what pages actually contain. Treat the metadata as the source of truth for *controls* and the rows as the source of truth for *content*.

## Design

### Route and URL state

- Discovery lives at `/circles` (a new `app/src/app/circles/page.tsx`, a server component). The homepage shows a fixed first page (Issue 121) and links to `/circles?status=Pending` through its CTA.
- All state is in the URL: `?status=&sort=&order=&page=&limit=`. Refresh, back/forward and shared links therefore restore the same view with no client state.
- Controls are Next `<Link>`s to new URLs, not `onClick` state changes. That's how browser history works without extra code.

### Parsing `searchParams`

Add `parseDiscoveryParams(searchParams)` in `app/src/lib/discovery.ts`. It mirrors the indexer validators so the app never sends a request the API would reject:

| Input | Outcome |
|---|---|
| Missing param | Default (`page=1`, `limit=20`, `sort=created_ledger`, `order=desc`, `status` per Issue 121) |
| Invalid `page` (`0`, `-1`, `abc`, `1.5`, repeated) | `redirect()` to the same URL with `page=1` |
| `limit > 100` or invalid | `redirect()` with `limit` clamped to 100, or reset to the default if non-numeric |
| Unknown `sort` / `order` / `status` | `redirect()` with that param removed (falls back to default) |
| All valid | Render, no redirect |

Normalising with a redirect gives every invalid URL one predictable, testable outcome and stops a bad bookmark from becoming a silent `400` error banner.

### Out-of-range and shrinking result sets

| Situation | Behaviour |
|---|---|
| `total === 0` | Filter-specific empty state (Issue 121 table). No pagination controls |
| `page > totalPages > 0` (the list shrank, or the URL was edited) | Show "Page 7 doesn't exist. There are 4 pages of results." with a link to page `totalPages`. No auto-redirect, so the user sees why |
| `circles.length === 0` but `page <= totalPages` (a race between queries) | Same message, linking to page 1 |
| Fewer rows than `limit` on a non-final page | Render the rows. Controls still follow `totalPages` |

### Changing filters

Any link that changes `status`, `sort`, `order` or `limit` **drops `page`** (resets to 1). Only the prev/next links change `page`, and they keep every other param. Put this in one `buildDiscoveryHref(current, changes)` helper.

### Controls and accessibility

```tsx
<nav aria-label="Circle list pages">
  <p aria-live="polite">Showing 21–40 of 87 open circles · Page 2 of 5</p>
  <Link href={prevHref} rel="prev">Previous page</Link>
  <Link href={nextHref} rel="next">Next page</Link>
</nav>
```

- Prev is available only when `page > 1 && page <= totalPages`. Next is available only when `page < totalPages`.
- An unavailable control is **not a link**. Render it as `<span aria-disabled="true">` with muted styling, so keyboard and screen-reader users can't land on a dead action and nothing points past what the API allows.
- Use visible text labels, not only arrow icons. Focus outlines must stay visible.
- The range text ("21–40 of 87") is computed as `(page-1)*limit+1` to `(page-1)*limit + circles.length`, so it shows what was actually rendered.
- The list is bounded: the app only ever renders the `limit` rows it received. There's no client-side accumulation or "load all".

## Test plan

| Case | Setup | Expect |
|---|---|---|
| First page | `page=1`, `totalPages=5` | Prev disabled (not a link), Next links to `page=2` |
| Middle page | `page=3`, `totalPages=5` | Both links, and both keep `status/sort/order/limit` |
| Final page | `page=5`, `totalPages=5` | Next disabled |
| Single page | `totalPages=1` | Both disabled, or the nav is hidden |
| Empty | `total=0`, `totalPages=0` | Empty state, no nav |
| Out of range | `page=9`, `totalPages=4` | Message and link to `page=4`, no Next/Prev |
| Shrinking race | `circles=[]`, `page=2`, `totalPages=3` | Message and link to page 1 |
| Invalid page | `page=0`, `abc`, `1.5`, `-2`, repeated | Redirect to `page=1` with other params kept |
| Limit cap | `limit=500` | Redirect to `limit=100`, and the outgoing request never has `limit>100` |
| Filter change resets page | on `page=3`, click the `status=Active` link | Href has no `page` (or `page=1`) |
| Request matches URL | any valid params | The indexer URL has exactly those params |
| Indexer error | 500 / network | Error banner, no pagination controls |

## Acceptance criteria mapping

- *Renders only the requested bounded page.* One request per render, `limit ≤ 100`, no accumulation.
- *State survives refresh and browser navigation.* All state is in the URL and controls are `<Link>`s.
- *Never offers an unavailable action.* Controls are computed from `page`/`totalPages`, and a disabled control isn't a link.
- *Invalid params have a clear, tested outcome.* `parseDiscoveryParams` redirects to a normalised URL, covered by the "Invalid page" and "Limit cap" cases.
