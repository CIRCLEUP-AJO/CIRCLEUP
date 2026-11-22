# Contract Storage & Upgrade Compatibility Matrix

This doc inventories every persisted key, its storage scope, how it gets
initialized, and the upgrade path for the `circle`, `circle_factory` and
`reputation` contracts. It also covers the historical-state fixture tests
that back the compatibility claims (issue #867). It complements the policy in
[UPGRADE_COMPATIBILITY.md](./UPGRADE_COMPATIBILITY.md) and the SDK-side key
snapshot in `sdk/src/__tests__/contractStorageCompatibility.test.ts`.

## Scope of claims

Compatibility is claimed **only** for the layouts and state shapes listed under
"Fixture matrix", tested against the contract code at the commit under test.
Anything not listed is **untested**: other key combinations, partially
written states, or entries that have been archived after TTL expiry. Treat
untested state as incompatible until a fixture says otherwise.

## Upgrade paths

| Contract | In-place upgrade entrypoint | Effective upgrade path |
|---|---|---|
| `circle` | **None.** No `update_current_contract_wasm` call. | Existing instances keep their code. New circles get new code only when the factory deploys from a new `CircleWasmHash`. |
| `circle_factory` | **None.** `CircleWasmHash` is written once in `initialize` and has no setter. | Deploy a new factory, then point clients and the indexer at it. Old circles stay registered with the old factory. |
| `reputation` | **None.** | Deploy a new contract. Scores are **not** migrated automatically, so a migration plan has to replay or attest them. |

Today, then, no candidate code ever runs over another version's state on chain.
The fixture tests set the compatibility contract that must hold **before** an
upgrade entrypoint is added, or before any tool (SDK, indexer, scripts) reads
old instances through new client bindings.

## Storage inventory

Scopes: **I** = instance (one ledger entry per contract, shares the
contract's TTL), **P** = persistent (one ledger entry per key). No contract
uses temporary storage.

### circle (`contracts/circle/src/lib.rs` → `DataKey`)

| Key | Scope | Value type | Written by | Introduced | Absent means |
|---|---|---|---|---|---|
| `Config` | I | `CircleConfig` | `initialize` | L1 | not initialized → `ContractError::NotInitialized` from `get_config` |
| `Status` | I | `CircleStatus` | `initialize`, `join`, `payout`, `settle_round`, `cancel` | L1 | `get_status` panics (untyped) |
| `CurrentRound` | I | `RoundState` | `initialize`, `join`, `contribute`, `payout`, `settle_round` | L1 | panics for Active/Pending (storage inconsistency) |
| `RoundsCompleted` | I | `u32` | `initialize` (0), then `bump_rounds_completed` | L1 | `close` panics on Completed |
| `Collateral(Address)` | P | `i128` | `join`, `mark_default`, `settle_round`, `close` | L1 | reads as `0` |
| `Contributed(Address, u32)` | P | `bool` | `contribute` | L1 | reads as `false` |
| `Defaults(Address)` | P | `u32` | `mark_default`, `settle_round` | L1 | reads as `0` |
| `Defaulted(Address, u32)` | P | `bool` | `mark_default`, `settle_round` | 602ca71 (additive) | not flagged |
| `Initializing` | I | `bool` | set and removed inside `initialize` | bf8c3db | never present at rest |
| `Closed` | I | `bool` | `close` | L2 (#166) | not closed |
| `Admin` | I | `Address` | `initialize` | L3 (#334) | `get_admin` → `ContractError::NotInitialized`; `pause`/`resume` → `PauseError::NotInitialized`; **`close` panics** |
| `Paused` | I | `bool` | `pause` / removed by `resume` | L3 (#334) | not paused |
| `UsdcToken` | I | `Address` | `initialize` | L3 (#335) | `get_usdc_token` → `ContractError::NotInitialized` |

`CircleConfig`, `RoundState` and the `CircleStatus` variant order have not
changed since the initial commit (8c7a1df).

### circle_factory (`contracts/circle_factory/src/lib.rs` → `DataKey`)

| Key | Scope | Value type | Written by | Introduced | Absent means |
|---|---|---|---|---|---|
| `Admin` | I | `Address` | `initialize` | L1 | getters panic `"not initialized"` (untyped) |
| `CircleWasmHash` | I | `BytesN<32>` | `initialize` | L1 | same |
| `ReputationContract` | I | `Address` | `initialize` | L1 | same |
| `UsdcToken` | I | `Address` | `initialize` | L1 | same |
| `Circles` | I | `Vec<Address>` (creation order) | `initialize`, `create_circle` | L1 | empty registry |
| `CircleCount` | I | `u32` (== `Circles.len()`) | `initialize`, `create_circle` | L1 | `0` |
| `Initializing` | I | `bool` | inside `initialize` only | later (additive) | never present at rest |

Instance storage caps the registry: `Circles` is a single instance value, so
it grows with every circle created. See [scalability/](./scalability) and the
factory scalability tests.

### reputation (`contracts/reputation/src/lib.rs` → `DataKey`)

| Key | Scope | Value type | Written by | Introduced | Absent means |
|---|---|---|---|---|---|
| `Admin` | I | `Address` | `initialize` | L1 | `increment` → `ReputationError::NotInitialized` |
| `AuthorizedCallers` | I | `Vec<Address>` | `initialize`, `add_/remove_authorized_caller` | L1 | empty allowlist |
| `RevokedCallers` | I | `Vec<Address>` (append-only) | `initialize`, `remove_authorized_caller` | L2 (5d79904) | empty; revocation is applied lazily on first removal |
| `Score(Address)` | P | `u32` | `increment` (+ `extend_ttl(100_000, 200_000)`) | L1 | `0` |
| `Initializing` | I | `bool` | inside `initialize` only | later (additive) | never present at rest |

### TTL

Only reputation `Score` entries extend their TTL. Circle and factory
instance/persistent entries rely on network defaults, so long-lived circles
can be archived and need restoring before use. Restored entries keep their
original encoding, which means the fixtures here also cover them.

## Initialization conventions

All three contracts follow the same rules:

1. `initialize` refuses to run twice (`AlreadyInitialized`).
2. A reentrancy flag (`Initializing`) is written first and removed last.
3. All required keys are written in one invocation, so a successful
   `initialize` never leaves partial state.
4. Additive keys introduced later (`Paused`, `Closed`, `Defaulted`,
   `RevokedCallers`) have safe defaults when absent.
   `Admin`/`UsdcToken` on circle are the exception: absence produces a typed
   `NotInitialized` from views and an untyped panic from `close`.

## Fixture matrix

Manifests: `contracts/fixtures/storage/<contract>.layouts.json`. Tests:
`contracts/<contract>/tests/storage_compatibility_tests.rs`. A
`manifest_and_tests_cover_the_same_fixtures` test in each crate fails if the
manifest and the tests disagree.

| Fixture id | Layout | Expectation |
|---|---|---|
| `circle.L1.pending-no-joins` | L1 | Preserved; empty collections read as defaults |
| `circle.L1.active-mid-round` | L1 | Preserved values; `NotInitialized` (typed) for Admin/UsdcToken views and `pause` |
| `circle.L2.completed-unclosed` | L2 | **Deterministic untyped panic** in `close` (`Admin missing`) — known gap |
| `circle.L3.active-paused` | L3 | Preserved; `resume` succeeds |
| `circle.L3.completed-rounds-mismatch` | L3 | `CloseError::RoundsIncomplete` |
| `circle.L3.closed` | L3 | `CloseError::AlreadyClosed` |
| `factory.L1.empty-registry` | L1 | Preserved; `FactoryError::CursorOutOfRange` past end |
| `factory.L1.populated-registry` | L1 | Order, count and pagination preserved |
| `factory.L1.registry-keys-absent` | L1 | Empty-registry defaults |
| `factory.uninitialized` | — | `InvalidPageLimit` typed; getters panic (untyped) — known gap |
| `reputation.L1.pre-revocation` | L1 | Preserved; revocation works on the old layout |
| `reputation.L2.populated` | L2 | Preserved; `UnauthorizedCaller` / `CallerRevoked` typed |
| `reputation.L2.fresh-empty` | L2 | Zero scores; `UnauthorizedCaller` |
| `reputation.uninitialized` | — | `NotInitialized` typed |

### Known gaps (deterministic, not typed)

- `circle.close` on an instance without `Admin` (pre-#334) panics with
  `circle: Admin missing — storage inconsistency`. Any migration that
  lets candidate code operate such instances must write `Admin` first.
- Factory config getters panic with `not initialized` rather than returning a
  typed error.

Changing either to a typed error means appending an error variant, which
changes the Wasm hash. That's a release-tracked contract change, not a test
change.

## When a storage change needs a migration plan

A migration plan (see [UPGRADE_COMPATIBILITY.md](./UPGRADE_COMPATIBILITY.md#migration-and-rollback-constraints))
is **required** before merge when a change:

- removes or renames a `DataKey` variant, or changes its arguments;
- reorders `DataKey`, `CircleStatus` or any persisted enum;
- changes a field name, type or order in `CircleConfig`, `RoundState` or any
  stored struct;
- moves a key between scopes (instance ↔ persistent);
- changes the meaning of an absent key, for example making a defaulted key
  mandatory.

Adding a new key with a safe absent-default does **not** need a migration
plan. It still needs a new fixture showing the old layout reads correctly.

## Updating fixtures and release reporting

1. Add a new layout section (`L4`, …) to the manifest, naming the commit
   that introduced it.
2. Add fixtures for that layout **and** keep every older fixture. Old
   layouts are only dropped after a documented decision that no deployed
   instance uses them.
3. Implement each fixture id in the crate's `storage_compatibility_tests.rs`.
   Add it to `IMPLEMENTED`.
4. Update the tables above, and `UPGRADE_COMPATIBILITY.md` if policy changes.
5. The release smoke matrix (`storage_compat_fixtures` check) requires the
   manifests to exist. A mainnet RC fails without them. The fixture tests run
   in the CI Contracts job, and their result goes into the release sign-off
   ([RELEASE_SMOKE_TEST_MATRIX.md](./RELEASE_SMOKE_TEST_MATRIX.md)).
6. Release notes have to name any layout change, the fixtures that cover it,
   and any new known gaps.
