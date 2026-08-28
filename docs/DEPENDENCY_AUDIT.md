# Dependency Audit and Lockfile Policy

## Lockfile policy

All four workspaces (`sdk`, `indexer`, `app`, `scripts`) share a single root `package-lock.json` managed by npm workspaces.

**Rules:**
- The lockfile is committed to the repository. Every install is deterministic and reproducible.
- `npm ci` is the canonical install command for CI and production. It fails on any lockfile drift.
- `npm install` is allowed locally for development but must produce a clean lockfile diff before a PR is opened.
- Dependency upgrades must be a separate, focused commit. Do not mix dependency bumps with feature changes.
- Evaluate all audit findings before merging a dependency upgrade. Run `npm audit` after every install.

## Audit status (as of 2026-08-28)

Run `npm audit --workspaces` to reproduce. Non-breaking fixes were applied with `npm audit fix`.

### Fixed in this change

| Package | Severity | CVE / advisory | Resolution |
|---------|----------|----------------|------------|
| `nanoid` | High | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8 | Resolved via `npm audit fix` |
| `brace-expansion` | High | GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895 | Resolved via `npm audit fix` |
| `minimatch` | High | GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74 | Resolved via `npm audit fix` |

### Deferred — require a breaking version upgrade

The following findings cannot be addressed without a major version bump to a framework or test
runner. These upgrades carry risk of regressions and are deferred until a dedicated upgrade PR
is reviewed, tested, and approved.

| Package | Severity | Fix available | Constraint | Scope |
|---------|----------|---------------|------------|-------|
| `esbuild <=0.24.2` | Moderate | `vitest@4.1.11` (breaking) | Test runner only — no production code path | devDependency — GHSA-67mh-4wv8-2f99 |
| `glob 10.2.0–10.4.5` | High | `eslint-config-next@16.3.3` (breaking) | Linting only — not present in deployed bundle | devDependency — GHSA-5j98-mcp5-4vw2 |
| `next <=16.3.0-preview.10` | High / Critical | `next@16.3.3` (major bump) | App framework — requires full regression test | runtime dependency — multiple CVEs |
| `postcss <=8.5.22` | High | `next@16.3.3` (major bump) | Pulled in by current Next.js version | runtime dependency — GHSA-fxqj-rqcc-2cmp |

**Rationale for deferral:**

- `esbuild` / `vitest`: affects `npm test` only, never the deployed application. Risk is limited to
  development environment. Schedule upgrade in a standalone PR with full test verification.
- `glob` / `eslint-config-next`: affects `npm run lint` only. Not in the production or test bundle.
  Schedule alongside the Next.js upgrade.
- `next` / `postcss`: multiple CVEs, but several are exploitable only when specific Next.js
  features (Image Optimization API, Server Actions, Server Components streaming) are used with
  attacker-controlled input that reaches those surfaces. The current app does not expose a
  public Image Optimization endpoint, does not use Server Actions, and does not accept
  user-controlled input in Server Components without validation. Risk is real but reduced.
  Upgrade in a dedicated PR after verifying all routes and CI checks.

## Running audits locally

```bash
# All workspaces
npm audit --workspaces

# Single workspace
npm audit --workspace=app
npm audit --workspace=sdk
npm audit --workspace=indexer
npm audit --workspace=scripts

# Apply non-breaking fixes
npm audit fix

# View what a force-fix would change before applying it
npm audit fix --force --dry-run
```

## Adding new dependencies

Before adding any new dependency:

1. Check its audit status: `npm audit` after the add.
2. Check its license: `npm run license:check --workspace=<pkg>`.
3. Prefer pinned devDependencies for tooling (linters, formatters, test runners).
4. Avoid adding transitive dependencies directly — fix the root package instead.
