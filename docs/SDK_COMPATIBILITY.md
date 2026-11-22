# CircleUp SDK Compatibility & Semantic Versioning Policy

This document establishes the semantic versioning guarantees, public API boundaries, deprecation lifecycles, and release checklists for `@circleup/sdk`.

---

## 1. Scope & Canonical Entry Point

The only supported, stable entry point for consumers is the root package export:

```typescript
import { CircleUpClient } from "@circleup/sdk";
```

- **Supported Public Surface**: Every symbol explicitly re-exported by [`sdk/src/index.ts`](../sdk/src/index.ts).
- **Unsupported / Private Surface**: Any deep import path (e.g. `@circleup/sdk/dist/...` or `@circleup/sdk/src/...`) is strictly private, unversioned, and forbidden. Package consumers relying on deep imports will experience breakage across patch and minor releases without notice.
- **Enforcement**: Public surface integrity is guarded by automated CI checks (`npm run check:api` and `scripts/check-public-api.cjs`), which fail builds if any internal helper leaks or any non-root path is exposed.

---

## 2. Pre-1.0 Semantic Versioning Guarantees (`0.x.y`)

In accordance with Semantic Versioning 2.0.0 for initial development (`0.y.z`):

| Release Increment | Classification | Permitted Changes | Downstream Consumer Action |
|---|---|---|---|
| **Patch (`0.x.Y`)** | Backwards-Compatible | • Bug fixes & internal refactorings<br>• Additive exports (new helpers, new opt-in types)<br>• Non-breaking type refinements<br>• Performance optimizations & cache improvements | Safe drop-in upgrade. No code changes required. |
| **Minor (`0.X.0`)** | Breaking or Major Feature | • Breaking TypeScript type modifications<br>• Removal of deprecated methods/types after sunset<br>• Incompatible Soroban contract ABI changes<br>• Alterations to runtime error classifications or default invariants | Review migration guide in `CHANGELOG.md` before upgrading. |
| **Major (`1.0.0+`)** | Full SemVer Contract | • Major milestone signifying long-term protocol stability<br>• Breaking changes increment `MAJOR`<br>• Backwards-compatible additions increment `MINOR`<br>• Backwards-compatible fixes increment `PATCH` | Standard enterprise SemVer guarantees. |

---

## 3. Deprecation Lifecycle & Notice Periods

No public export or behavior is removed silently. Deprecations proceed through structured stages:

```
Active  ──▶  Deprecated (Annotated + Notice)  ──▶  Sunset  ──▶  Removed
```

1. **Active**: Fully supported, stable API surface.
2. **Deprecated**: The interface remains fully functional throughout the notice window.
   - Annotated with JSDoc `@deprecated since 0.X.0 — use <Replacement> instead. Will be removed in 0.Y.0.`
   - Moved to the dedicated `// ── Deprecated` export section in `sdk/src/index.ts`.
   - Accompanied by an explicit migration recipe in `CHANGELOG.md` and this document.
   - Retained in root exports and type-tested in `sdk/examples/public-api.ts`.
3. **Sunset**: Final release phase prior to removal; warning emitted in documentation.
4. **Removed**: Excised from `sdk/src/index.ts` and the codebase.

### Minimum Notice Periods

- **SDK Exported Functions / Classes**: Minimum **1 minor release** (`0.X.0` $\rightarrow$ `0.X+1.0`) notice.
- **SDK Type Aliases / Interfaces**: Minimum **1 minor release** notice.
- **Contract View / Invocation Methods**: Minimum **2 minor releases** notice to allow network-wide contract upgrades.

---

## 4. Representative Deprecation & Migration Example

### Deprecation: `CircleDetailResponse` $\rightarrow$ `ApiCircleDetailResponse`

To align indexer responses with the unified wire naming convention (`Api*Response`), the legacy alias `CircleDetailResponse` is deprecated as of `0.2.0` and will be removed in `0.4.0`.

#### Before (`0.1.x`):
```typescript
import { CircleDetailResponse } from "@circleup/sdk";

function handleDetail(res: CircleDetailResponse) {
  console.log(res.circle.address);
}
```

#### After (`0.2.0+`):
```typescript
import { ApiCircleDetailResponse } from "@circleup/sdk";

function handleDetail(res: ApiCircleDetailResponse) {
  console.log(res.circle.address);
}
```

Both types remain structurally identical until `0.4.0`.

---

## 5. Privacy & State Isolation Guarantees

In addition to API shape stability, `@circleup/sdk` guarantees:

1. **Privacy-Safe Diagnostics by Default**:
   - SDK error objects (`SdkError`, `IndexerError`, `TxFailure`) exclude private keys (`S...`), seed phrases, signed transaction envelopes, and raw unbounded provider bodies.
   - Error messages use SDK-authored sentences or sanitized, length-bounded provider text.
   - All structured logging (`TxLogger`) is strictly opt-in via `client.setTxLogger(fn)`. The SDK collects zero telemetry silently.
2. **Multi-Client State Independence**:
   - Each `CircleUpClient`, `CircleClient`, `FactoryClient`, `ReputationClient`, and `IndexerClient` instance owns its own configuration, RPC transport, timeout settings, polling schedules, and cache.
   - Instantiating multiple clients for different networks or deployments within a single process causes zero configuration leakage.

---

## 6. Release Checklist

Before tagging and publishing any `@circleup/sdk` version:

- [ ] **1. Public Surface Integrity**:
  ```bash
  node sdk/scripts/check-public-api.cjs
  ```
  Verify that all intended symbols are exported at root, no internal helpers are leaked, and no deep imports exist in consumer workspaces.
- [ ] **2. Type Compilation & Declaration Emit**:
  ```bash
  npm run build:sdk
  npx tsc -p sdk/examples/tsconfig.json
  ```
  Confirm declaration files (`dist/index.d.ts`) emit cleanly without errors.
- [ ] **3. Runtime Test Suite**:
  ```bash
  npm run test --workspace=sdk
  ```
  Ensure all unit, gating, retry, and transaction lifecycle tests pass.
- [ ] **4. Contract & API Schema Fixtures**:
  - Contract argument XDR fixtures (`sdk/src/fixtures/versionedRpcFixtures.ts`) pass against target contracts.
  - API schema validation fixtures (`sdk/src/fixtures/apiResponseFixtures.ts`) pass against `docs/api/v1/openapi.json`.
- [ ] **5. Deprecation & Migration Documentation**:
  - Any new deprecation has replacement annotations and removal target version.
  - `CHANGELOG.md` contains an updated `[Unreleased]` entry detailing Added, Changed, Fixed, and Migration Guidance.
- [ ] **6. Automated Release Check**:
  ```bash
  npx ts-node scripts/src/release-check.ts
  ```
  All workspace version alignment and release dry-run assertions must pass.
