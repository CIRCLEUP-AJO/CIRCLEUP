# Contract Upgrade Compatibility

This policy applies to upgrades of the factory, circle, and reputation
contracts. Soroban code upgrades replace executable WASM; they do not rewrite
existing contract storage. Existing instances keep their stored keys and
serialized values and execute them using the new code.

## Compatibility snapshot

The machine-checked inventory is
[`sdk/src/__tests__/contractStorageCompatibility.test.ts`](../sdk/src/__tests__/contractStorageCompatibility.test.ts).
It pins ordered storage-key variants, persisted struct fields and types,
circle status variants, and all declared numeric error discriminants. SDK wire
fixtures additionally pin public method arguments and return shapes; see
[`CONTRACT_FIXTURES.md`](./CONTRACT_FIXTURES.md).

Persisted state currently includes:

| Contract | Keys and values | Compatibility concern |
|---|---|---|
| Circle | `Config: CircleConfig`, `Status: CircleStatus`, `CurrentRound: RoundState`, `RoundsCompleted: u32`, `UsdcToken: Address`, `Admin: Address`, `Paused: bool`, `Closed: bool`; persistent member collateral, contribution, default-count, and per-round default records | Key names/arguments and the serialized fields/types must remain readable by upgraded code. |
| Factory | Admin, circle WASM hash, reputation and token addresses, circle address vector/count, initialization flag | Circle ordering and count invariant must survive upgrades; do not reset or reorder the registry. |
| Reputation | Per-member score, admin, authorized caller vector, revoked caller vector, initialization flag | Scores and revocations are durable history; revocation must not be cleared by an upgrade. |

Error values are API state too. `InitError` codes `1–13`, `PauseError` codes
`1–4`, `CloseError` codes `1–4`, `ContractError` codes `1–3`, and
`ReputationError` codes `1–5` predate the current issue work and must not be
renumbered or reused. New values are append-only within their error enum.
Factory validation uses the separate `FactoryError` range `100–107`.

## Required review for a change

Before merging a contract change, reviewers must:

1. Run the SDK contract fixture suite and the Soroban contract tests against
   the checked-in compatibility snapshot.
2. Compare any changed key name/argument, enum variant, persisted field/type,
   error code, public method signature, or return type against deployed state
   and clients.
3. Update the snapshot and this inventory in the same change. A snapshot update
   records an intentional decision; it does not by itself make a change safe.
4. Describe the migration or deployment limitation in the PR and release
   notes. Removed keys, reordered variants, changed field types, and reused or
   renumbered error codes require explicit approval and a tested migration plan.

Never remove a key or variant, reorder an existing variant, change a stored
value's type/field shape, or reuse an error number as incidental cleanup.
Prefer adding new keys and variants while retaining old representations until
all deployed state and supported clients have moved forward.

## Migration and rollback constraints

An in-place migration is possible only when an upgraded contract can still
read the old representation and can atomically write the new representation.
Use an explicit version marker or a bounded, idempotent migration entrypoint;
test it with serialized pre-upgrade values, not only fresh contract instances.
If the old value cannot be decoded by the new code, or if the full state cannot
be enumerated and transformed safely, deploy a replacement contract and
provide an explicit state/event migration path. Do not assume that a WASM code
rollback restores data written in the new format.

Rollback is straightforward only while the upgraded code has not committed
state that the previous WASM cannot decode or safely ignore. Before upgrading,
record the old WASM hash and take a verified off-chain state/event archive.
After any migration write, test both the new code and the documented recovery
path against a copy of the migrated state. If old WASM is incompatible with the
new representation, recovery must be a forward fix or a separately tested
reverse migration, not a blind code rollback.

## Deployment gate

Use the staged upgrade and health checks in
[`DEPLOYMENT_LIFECYCLE.md`](./DEPLOYMENT_LIFECYCLE.md). Do not upgrade a
deployed instance until the new WASM hash, compatibility test results,
migration/rollback decision, backup/archive verification, and operator approval
are recorded. This policy does not imply that currently deployed contracts are
upgradeable; the instance's admin and network deployment setup must support
the Soroban upgrade operation.