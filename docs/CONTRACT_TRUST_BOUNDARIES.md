# Contract Trust Boundaries & Operator Responsibilities

**Status**: Documented for Issue #896
**Audience**: Circle members, circle operators, deployment/admin key holders, SDK and indexer integrators

Contract-controlled accounting removes the organizer's ability to divert contributions. It does **not** remove every operational risk. This guide separates what the Soroban contracts enforce from what tooling checks and from what remains a user, operator or network assumption. Every high-impact claim below links to an evidence source; anything that cannot be verified is explicitly labelled as an assumption.

---

## 1. Three categories of guarantee

| Category | Meaning | Example |
|---|---|---|
| **Enforced by code** | A transaction that violates the rule fails and rolls back on the ledger. | Only the configured recipient receives a completed round's pot. |
| **Checked by tooling** | A script, test or manifest check detects drift before or after deployment, but the chain does not enforce it. | Deployed WASM hash matches the pinned artifact hash. |
| **Assumed by operators/users** | Trust is placed in an external key, issuer, network, client or process. | The admin multisig is honestly controlled; the USDC issuer is Circle. |

A statement may move from "assumed" to "checked" only when an executable verification exists, and to "enforced" only when a contract entry-point rejects the violating transaction.

---

## 2. Enforced by contract code

These rules are implemented in [`contracts/circle/src/lib.rs`](../contracts/circle/src/lib.rs), [`contracts/circle_factory/src/lib.rs`](../contracts/circle_factory/src/lib.rs) and [`contracts/reputation/src/lib.rs`](../contracts/reputation/src/lib.rs).

| Guarantee | Contract method / code | Verification |
|---|---|---|
| Member count is between `MIN_MEMBERS` (2) and `MAX_MEMBERS` (256), with unique members | `circle::initialize`, `circle_factory::create_circle` | [`member_boundary_tests.rs`](../contracts/circle/src/member_boundary_tests.rs), [`member_boundary_tests.rs`](../contracts/circle_factory/tests/member_boundary_tests.rs) |
| Collateral is recorded before transfer and is exactly `round_amount × COLLATERAL_MULTIPLIER` | `circle::join`, `safe_transfer` | [`transfer_failure_tests.rs`](../contracts/circle/src/transfer_failure_tests.rs), [`token_behavior_fixture.rs`](../contracts/circle/src/token_behavior_fixture.rs) |
| A failed token transfer cannot leave partial circle state; the call can be retried | `safe_transfer` panics; Soroban rollback | [`token_behavior_fixture.rs`](../contracts/circle/src/token_behavior_fixture.rs) |
| Payout recipient is always `members[round_index]`, never a caller-supplied address | `circle::payout` | [`payout_integration_tests.rs`](../contracts/circle/src/payout_integration_tests.rs), [`adversarial_tests.rs`](../contracts/circle/src/adversarial_tests.rs) |
| Payout requires all contributions **and** a matching persisted tally | `circle::payout` | [`lifecycle_invariant_tests.rs`](../contracts/circle/src/lifecycle_invariant_tests.rs) |
| Deadline is inclusive for contributions and exclusive for default/settlement (`sequence > deadline_ledger`) | `circle::deadline_passed`, `contribute`, `mark_default`, `settle_round` | [`deadline_boundary_tests.rs`](../contracts/circle/src/deadline_boundary_tests.rs), [`DEADLINE_LEDGER_BOUNDARY.md`](./DEADLINE_LEDGER_BOUNDARY.md) |
| A member is penalised at most once per round, by 20% of the current collateral | `circle::mark_default`, `settle_round` | [`error_path_tests.rs`](../contracts/circle/src/error_path_tests.rs), [`mutation_guards.rs`](../contracts/circle/src/mutation_guards.rs) |
| Only the circle admin can pause/resume, and the stored admin address is immutable (no rotation entry-point) | `circle::pause`, `circle::resume`, `DataKey::Admin` | [`PRIVILEGED_CONTROLS_AND_CUSTODY.md`](./PRIVILEGED_CONTROLS_AND_CUSTODY.md) |
| Reputation points require an allowlisted, non-revoked circle caller | `reputation::increment` | [`AUTHORIZATION_MATRIX.md`](./AUTHORIZATION_MATRIX.md) |
| Collateral is released only from `Completed` or `Cancelled` circles and only once | `circle::close`, `DataKey::Closed` | [`cancellation_invariants_tests.rs`](../contracts/circle/src/cancellation_invariants_tests.rs) |
| `payout`, `mark_default` and `settle_round` are permissionless; settlement cannot substitute a recipient | `circle` entry-points have no caller `require_auth()` | [`AUTHORIZATION_MATRIX.md`](./AUTHORIZATION_MATRIX.md) |

Run the enforced-evidence suite with:

```bash
cd contracts && cargo test
```

---

## 3. Checked by tooling, not by the chain

These checks reduce deployment risk but are not on-chain invariants. A skipped or failed check does not automatically block a transaction.

| Check | Command / source | What it proves |
|---|---|---|
| Manifest/network validation | `npm run validate-manifest` | Configured addresses, network passphrase and profile fields are internally consistent. |
| Artifact hashes and provenance | `npm run verify-artifacts`, [`provenance.json`](../contracts/provenance.json) | Deployed WASM matches the reviewed build; see [`DEPLOYMENT_LIFECYCLE.md`](./DEPLOYMENT_LIFECYCLE.md). |
| Token metadata and interface preflight | `npx ts-node scripts/src/check-token-assumptions.ts --profile production --strict` | The configured token responds with expected symbol, decimals and SEP-41 interface; see [`USDC_ASSUMPTIONS.md`](./USDC_ASSUMPTIONS.md). |
| Factory address derivation | [`DEPLOYMENT_LIFECYCLE.md`](./DEPLOYMENT_LIFECYCLE.md) | Deterministic address derivation and collision handling match the deployment plan. |
| Storage/wire compatibility on WASM replacement | [`UPGRADE_COMPATIBILITY.md`](./UPGRADE_COMPATIBILITY.md), `npm run test --workspace=sdk` | Persisted keys, enum variants and error codes remain readable by the new code. |
| Protocol parameter parity across Rust/SDK/docs | `node --experimental-strip-types --test tests/protocol-parameters-parity.test.ts` | Documented bounds have not silently diverged from contract constants. |

Tooling output is evidence for a specific commit, manifest and network. Re-run it for each deployment; a past passing run is not a permanent guarantee.

---

## 4. Remaining assumptions and risks

| Assumption | Why the contract cannot verify it | Operator/user responsibility |
|---|---|---|
| Admin key custody and honesty | The contract checks a signature, not who controls the key or their intent. | Use a multisig or automation for the immutable admin address. A lost or compromised key cannot be rotated on-chain; deploy a correctly configured replacement instead. |
| USDC identity, reserve backing and issuer policy | On-chain metadata proves an interface and address, not Circle's reserves or clawback policy. | Pin the canonical address, run the token preflight, and read [`USDC_ASSUMPTIONS.md`](./USDC_ASSUMPTIONS.md) before trusting value. |
| Network selection | The same contract deployed to a different network/passphrase is a different trust domain. | Verify network passphrase and factory address from the deployment manifest before signing. |
| WASM upgrade discipline | Soroban code replacement does not rewrite storage; the chain does not judge compatibility. | Follow [`UPGRADE_COMPATIBILITY.md`](./UPGRADE_COMPATIBILITY.md) and publish the reviewed hash before any upgrade. |
| Reputation administration | The circle cannot force the reputation admin to authorize or keep a caller authorized. | Monitor allowlist/revocation state; revocation is permanent for the affected caller and makes payout/settlement fail. |
| Indexer freshness | Indexers observe events after consensus and may approximate per-round deadlines. | Treat indexed deadlines as estimates; use the contract's ledger rule via [`DEADLINE_LEDGER_BOUNDARY.md`](./DEADLINE_LEDGER_BOUNDARY.md). |
| Wallet and signing security | Contract auth proves a signature, not that the wallet UI was honest or the device uncompromised. | Verify contract IDs and transaction details in the wallet before signing. |
| RPC availability | Read-only clients depend on an external endpoint. | Use bounded reads and retries; a failed read is not a failed or successful contract action. |

---

## 5. Responsibility matrix

| Actor | Owns | Must not claim |
|---|---|---|
| Deployment operator | Correct network, manifest, WASM hash, token address, reputation admin wiring | "The contract verified our deployment identity." |
| Admin key holder | Pause/resume decisions and key custody | "We can rotate the admin key on an existing circle." |
| Reputation admin | Allowlist and revocation decisions | "A revoked circle can still earn points." |
| Indexer operator | Fresh checkpoints, exact event decoding, honest `estimate` labels | "Indexed deadline equals the on-chain deadline." |
| SDK/app integrator | Strict `>` gating, stable error codes, fail-closed punitive actions | "Wall-clock countdown decides default eligibility." |
| Circle member | Wallet security, signing review, contribution before the deadline ledger | "The organizer can run off with the pot." |

---

## 6. Language guardrails

Do not describe CircleUp as eliminating all trust. Accurate statements:

- "The organizer cannot redirect a completed round's pot; the recipient is fixed by the member list."
- "Collateral penalties and rotation are contract-enforced and independently testable."
- "Deployment identity, token value, admin key custody, upgrades and network choice remain operator or user responsibilities."

Inaccurate statements that must be corrected in product copy:

- "Zero trust required" without qualifying which trust is removed.
- "Default is allowed at the deadline" — it is allowed only **after** the deadline ledger.
- "Anyone can initialize or rotate the admin" — initialization requires the admin signature and the admin address is immutable.

---

## 7. Detailed references

- [`SECURITY.md`](../SECURITY.md) — vulnerability reporting and risk surface.
- [`PROTOCOL_INVARIANTS.md`](./PROTOCOL_INVARIANTS.md) and [`API_INVARIANTS.md`](./API_INVARIANTS.md) — invariant catalogue.
- [`AUTHORIZATION_MATRIX.md`](./AUTHORIZATION_MATRIX.md) — caller auth for every entry-point.
- [`CONTRACT_ERRORS.md`](./CONTRACT_ERRORS.md) — stable error codes and client mapping.
- [`RUNBOOK.md`](./RUNBOOK.md) — operational procedures.
- [`CONTRACT_SECURITY_CHECKLIST.md`](./CONTRACT_SECURITY_CHECKLIST.md) — review checklist for changes.
