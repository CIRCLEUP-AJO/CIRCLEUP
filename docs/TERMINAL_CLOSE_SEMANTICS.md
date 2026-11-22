# Terminal Close Semantics

Issue #875. This specifies how `close` releases collateral when a circle is
Completed or Cancelled, and how contract, events, SDK and app represent it.

## Close is global, not per-member

`close(closer)` is a **single, circle-wide settlement**:

- One successful call releases **every** member's remaining collateral, in
  member-list order. No member has to claim individually.
- There is no per-member "claimed" key. `Collateral(member)` is zeroed as
  it is paid, and the instance flag `Closed` is set before any transfer.
- After that, every `close` fails with `CloseError::AlreadyClosed`, whoever
  calls it, and pays nothing.
- `close` does **not** change `Status`. A closed circle still reports
  `Completed` or `Cancelled`; `is_closed()` reports the overlay. (The
  indexer projects a closed circle's status as `Closed` — see the
  `circle/closed` handler.)

The SDK (`CircleClient.close`) and the indexer (`circle/closed` → one audit
row with `triggered_by = closer`) describe the same global model.

## Authorization and check order

| Order | Check | Failure |
|---|---|---|
| 1 | `closer.require_auth()` | host auth error |
| 2 | not paused | `ContractError::CirclePaused` (7) |
| 3 | `Closed` absent | `CloseError::AlreadyClosed` (1) |
| 4 | status Completed or Cancelled | `CloseError::NotTerminalState` (2) |
| 5 | closer is the stored admin **or** any configured member (joined or not) | `CloseError::Unauthorized` (3) |
| 6 | Completed ⇒ `RoundsCompleted == member_count` | `CloseError::RoundsIncomplete` (4) |

Every rejection happens before any write, so a failed close changes nothing:
no balances, no stored collateral, no flags, no events. Because check 3
comes before check 5, a stranger calling an already-closed circle gets
`AlreadyClosed`, not `Unauthorized`.

## Release per member

| Member state at close | Released | Event |
|---|---|---|
| Full collateral (`round_amount × COLLATERAL_MULTIPLIER`) | full amount | `collateral_released(circle, member, amount)` |
| Partially penalised (Completed only; penalties need an Active round) | the stored remaining amount | `collateral_released` with that amount |
| Zero / never joined (Cancelled: did not join; Completed: unreachable via public API) | nothing | **no** event |

After the per-member events, one
`closed(circle, closer, total_released, total_expected_collateral, reason)`
event follows, where `reason` is `completed` or `cancelled`.

### Reading `total_expected_collateral`

`total_expected_collateral = round_amount × COLLATERAL_MULTIPLIER × member_count`
counts **every configured member**:

- **Completed:** `total_expected − total_released` is the collateral
  forfeited to penalties.
- **Cancelled:** that difference also includes deposits that members who
  never joined never made. It is **not** a forfeiture figure there.

### Where forfeited penalties go

Penalties only reduce the stored `Collateral(member)`. The tokens stay in the
circle contract. `close` releases stored balances only, so after close the
circle keeps holding the sum of all penalties. Nothing redistributes them to
other members, and the contract has no sweep entrypoint.

## Pause interaction

`close` is blocked while paused, in every status (see
[PAUSE_RECOVERY_SEMANTICS.md](./PAUSE_RECOVERY_SEMANTICS.md)). An admin who
pauses a terminal circle therefore holds every member's collateral until
`resume`.

## Tests

`contracts/circle/tests/terminal_close_tests.rs`:

| Test | Covers |
|---|---|
| `completed_circle_releases_full_and_penalised_collateral_exactly_once` | full and penalised members, balances, stored collateral, events, retained penalty, duplicate closes by members/admin/stranger |
| `cancelled_circle_releases_joined_members_and_skips_never_joined` | full and zero-collateral members, `total_expected` caveat |
| `close_call_order_stranger_member_duplicate_admin` | call-order matrix |
| `admin_may_close_and_non_terminal_close_is_rejected` | admin authority, Pending/Active rejection |
| `zero_collateral_member_in_completed_circle_is_skipped_and_others_unaffected` | zero balance (injected), member isolation |
| `reduced_collateral_in_cancelled_circle_releases_exactly_the_stored_amount` | stored amount, not configured deposit (injected) |
| `paused_terminal_circle_cannot_close_until_resumed` | pause overlay |

States that are unreachable through the public API are injected and marked
as such in the test source.
