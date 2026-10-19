# Contract Error Codes

Soroban contract errors are numeric and stable only in context: consumers must
use the target contract and method along with the discriminant. Several
entrypoints intentionally use separate error enums whose numbers overlap.
Never branch on a numeric code without that context, and never renumber or
reuse an existing discriminant.

The SDK exposes decoded simulation failures as `TxFailure.contractError` with
`contract`, `method`, `code`, `category`, and a stable `message`. The original
simulation detail remains in `TxFailure.errorMessage`; unknown numeric codes
have category `unknown` and retain the generic `Contract error code N` text.
The structured field is additive; `errorCode` remains `simulation_failed` for
backward compatibility.

## Supported typed categories

| Contract and method | Codes | Categories |
|---|---:|---|
| Circle `initialize` | 1–14 (`InitError`) | Initialization and deterministic configuration validation |
| Factory `create_circle` | 100–107 (`FactoryError`) | Member count/uniqueness, amount/overflow, deadline bounds |
| Factory `initialize` | 108–109 (`FactoryError`) | Already initialized / initialization in progress |
| Circle `join`, `cancel`, `contribute`, `payout`, `mark_default`, `settle_round` | 4–14 (`ContractError`) | Membership, action/state guards, strict deadline, settlement eligibility |
| Circle `pause`, `resume` | 1–4 (`PauseError`) | Authorization, initialized state, pause state |
| Circle `close` | 1–4 (`CloseError`) | Terminal state, authorization, settlement completion |
| Reputation `increment`, `add_authorized_caller`, `remove_authorized_caller` | 1–6 (`ReputationError`) | Authorization, caller state, initialization, score overflow |
| Reputation `initialize` | 7–8 (`ReputationError`) | Already initialized / initialization in progress |

The existing circle read-view errors (`ContractError` 1–3) and pre-existing
error ranges remain unchanged. See
[`UPGRADE_COMPATIBILITY.md`](./UPGRADE_COMPATIBILITY.md) and the machine-checked
[`contractStorageCompatibility.test.ts`](../sdk/src/__tests__/contractStorageCompatibility.test.ts)
snapshot for exact names and discriminants.

## Explicitly untyped failures

Authorization failures raised by Soroban `require_auth`, RPC/network failures,
storage corruption or missing state, token-contract errors, and host traps are
not represented as these application validation codes. The SDK preserves the
host diagnostic and uses `contractError.category = "unknown"` when a numeric
contract error is not recognized. Integrators must not reinterpret an unknown
host error as a successful validation or retry it blindly.