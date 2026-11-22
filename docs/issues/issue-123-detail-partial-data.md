# Issue 123 (#959): Explicit partial-data policy for circle detail sections

## Problem

`app/src/app/circles/[address]/page.tsx` combines two indexer calls, `GET /circles/:address` (circle, members, latestLedger) and `GET /circles/:address/rounds` (rounds, pendingDefaults), and covers gaps with defaults that look like real data:

| Failure | What happens today | Why it misleads |
|---|---|---|
| `/rounds` returns non-2xx or bad JSON | Replaced by `{ rounds: [], pendingDefaults: [] }` | "No payouts yet" looks the same as "history failed to load" |
| `members` missing or not an array | Replaced by `[]`, plus an info notice | `isMember` becomes `false` for every wallet. A real member of a `Pending` circle is shown **"Lock Collateral & Join"**, and an `Active` member loses **Contribute** |
| `latestLedger` not a number | `null`, deadline estimate hidden | No sign that freshness is unknown |
| `circle` fields | Cast with `as`, no field validation | A missing `current_round` or `round_amount` renders as `NaN` or `"0.00"` |
| Post-action refresh (`CircleDetailClient`) | Refetches only `/circles/:address` and merges it into state | Rounds go stale after a payout with no indication |

Some sections already work well. The header with the address always renders, and `not_found` versus transport errors are kept apart. Keep that behaviour.

## Field → section → gate map

| Source | Field(s) | Section | Write gates that read it |
|---|---|---|---|
| `/circles/:address` | `circle.status` | Header, action panel | Join (`Pending`), Contribute/Payout (`Active`), Release Collateral (`Completed`/`Cancelled`) |
| | `circle.current_round`, `total_rounds` | Header, rotation, contribute label | Contribute (`myContributedThisRound`) |
| | `circle.round_amount`, `member_count` | Header (pot), join guidance | Join (collateral amount shown to the user) |
| | `circle.deadline_ledger`, `round_deadline_ledgers` | Deadline countdown | none (informational) |
| | `members[]` | Rotation order, member list, reputation badges | Join, Contribute (`isMember`, `total_contributions`) |
| | `latestLedger` | Countdown, freshness | none directly (see stale rule) |
| `/circles/:address/rounds` | `rounds[]`, `pendingDefaults[]` | Round history, defaults | none |
| Wallet | `walletAddress` | Action panel | all writes |
| Config | RPC URL, passphrase | n/a | all writes (see [Issue 120](issue-120-capability-config.md)) |

## Classification

| Class | Fields | Rule when missing or invalid |
|---|---|---|
| **Required** (page identity) | `circle.address`, `status`, `current_round`, `total_rounds`, `round_amount`, `member_count` | Header shows "—" placeholders and the address, the body shows the existing error. No other section renders, because they all need status and round |
| **Optional, independent** | `members[]` | Members section shows "Member list unavailable" with **Retry**. Join and Contribute are **blocked**, not guessed |
| **Optional, independent** | `rounds[]`, `pendingDefaults[]` | History section shows "Round history unavailable" with **Retry**. No writes depend on it |
| **Stale-tolerant** | `latestLedger`, `deadline_ledger` | Hide the countdown and show "Deadline estimate unavailable" |

**Freshness rule.** Let `lag = rpcLatestLedger - indexer latestLedger`. When `lag > STALE_LEDGER_THRESHOLD` (start at 60 ledgers, about 5 minutes), show a banner: "Circle data may be up to N minutes behind the network." Stale data still renders, because it's public and useful, but **write actions require a fresh read**. Either run a contract read (`getCircleStatus`/`getCurrentRound` in `stellar.ts`) before enabling the button, or let simulation (which already runs in `invokeContract`) be the final gate, and show its error as a specific message. If RPC is unconfigured or unreachable, freshness is "unknown": show the banner and don't claim the data is current.

## Design

### Typed section results

Replace the single `CircleDetailData` with per-section results:

```ts
type Section<T> =
  | { state: "ok"; value: T }
  | { state: "unavailable"; reason: "network" | "server" | "parse" | "missing" };

interface CircleDetailModel {
  circle: CircleState;                       // required: page fails without it
  members: Section<CircleMember[]>;
  history: Section<{ rounds: CircleRound[]; pendingDefaults: CirclePendingDefault[] }>;
  freshness: Section<{ indexerLedger: number; lag: number | null }>;
}
```

- `parseCircleState(raw)` checks each required field (strings are non-empty, numeric fields are finite, `status` is in the four-value enum) and returns `parse` on any failure. No `as` casts.
- An **empty** `members: []` is `ok` (for example a brand-new circle). A **missing or non-array** value is `unavailable`. `[]` and "unknown" must never be merged. Likewise, if `members.length !== circle.member_count`, treat the members section as `unavailable: "parse"`, since inconsistent data shouldn't drive gates.
- Members are fetched from the `/circles/:address` response today. Keep that, but parse them into their own `Section`.

### Section-level UI

- `SectionUnavailable({ title, reason, onRetry })` is a shared component with `role="status"`, specific copy, and a **Retry** button that refetches only that section's endpoint from the client (`/circles/:address/members` for members, `/circles/:address/rounds` for history).
- The page shell (header, address, back navigation, invite link) always renders.
- A section failure never hides another section's data.

### Write gating

Each action gets a gate function that returns either `{ enabled: true }` or `{ enabled: false, reason: string }`. Show the reason next to the disabled button.

| Action | Needs | Blocked reason when missing |
|---|---|---|
| Join | wallet, `status=Pending`, members `ok` (to confirm not already a member), write config | "We can't confirm your membership because the member list didn't load. Retry above." |
| Contribute | wallet, `status=Active`, members `ok`, `current_round`, write config | "Contribution status unknown: member data unavailable." |
| Trigger Payout | wallet, `status=Active`, write config | (only wallet/config reasons) |
| Release Collateral | wallet, `status ∈ {Completed, Cancelled}`, write config | (only wallet/config reasons) |

When stale per the freshness rule, add "Data is behind the network; refresh before acting" as a gate, or confirm it through a contract read.

### Refresh after a write

After a successful transaction, refetch **all** sections, not only `/circles/:address`. Replace each section's state independently, and leave a failed refetch as `unavailable`, so an older `ok` value isn't kept as if it were current.

## Test plan

| Case | Setup | Expect |
|---|---|---|
| Missing members | `/circles/:address` without `members` | Header and history render. Members section shows unavailable + Retry. Join and Contribute disabled with the member-data reason. No "Lock Collateral & Join" for a wallet that is actually a member |
| Empty members (new circle) | `members: []`, `member_count: 0` | "No members yet", and Join enabled for a connected wallet |
| Member count mismatch | `members` length 2, `member_count` 4 | Members unavailable (parse) and gates blocked |
| Rounds fail | `/rounds` 500 | History unavailable + Retry. Header, members and actions unaffected |
| Required field missing | `circle.current_round` absent | Page-level parse error, header placeholders, no actions |
| Stale ledger | indexer ledger 200 behind RPC | Stale banner, data shown, write gate active |
| Freshness unknown | `latestLedger` missing | Countdown hidden with notice, no "up to date" claim |
| Retry recovers | members fail, then retry succeeds | Section fills in and gates re-evaluate to enabled |
| Refresh after write | payout succeeds, `/rounds` refetch fails | History marked unavailable, not left showing the old list |
| Not found | `/circles/:address` 404 | Existing not-found body unchanged |

## Acceptance criteria mapping

- *Never fills missing required values with plausible defaults.* `parseCircleState` rejects them, and the `[]` fallbacks are removed.
- *A failure in one optional section does not erase unrelated validated data.* Sections have independent results and retries.
- *Any missing field required for a write blocks that action with a specific explanation.* Gate functions return a reason, covered by the "Missing members" and "Stale ledger" cases.
