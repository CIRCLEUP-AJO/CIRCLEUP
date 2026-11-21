# License Exceptions

This file records explicit exceptions to the default license policy defined in
`scripts/license-inventory.sh` and `contracts/deny.toml`.

## Policy summary

Permitted SPDX identifiers: `MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`,
`Apache-2.0`, `BlueOak-1.0.0`.

Prohibited: `GPL-*`, `LGPL-*`, `AGPL-*`, `CC-BY-NC-*`, `BUSL-1.1`,
`UNLICENSED`, `proprietary`.

## Exceptions

| Package | License | Workspace | Reviewer | Date | Owner | Review by | Justification |
|---------|---------|-----------|----------|------|-------|-----------|---------------|
| _(none)_ | | | | | | | |

Exceptions are time-bounded. The `Owner` column names the person or team
accountable for re-reviewing the exception, and `Review by` is the date by
which it must be re-reviewed (no more than 90 days after it is added). An
exception whose `Review by` date has passed fails the scheduled dependency
audit (`.github/workflows/dependency-audit.yml`, Issue #977) until it is
re-reviewed and the date is extended or the exception is removed.

## Adding an exception

1. Run `bash scripts/license-inventory.sh` and identify the package and SPDX
   identifier.
2. Verify the license text in the package's source repository.
3. Add a row above with the reviewer, the date, an **owner**, a **review-by
   date no more than 90 days out**, and a one-line justification (e.g.
   "dev-only dependency, not distributed in production build").
4. Have the exception reviewed by a second contributor before merging.
5. Add the exact SPDX license to the appropriate checked-in allowlist and keep
   the documented reviewer, date, owner, review-by date, and rationale in this
   file. CI must fail until both the documentation and enforcement policy are
   updated.
6. Expired exceptions fail the scheduled dependency audit. Re-review before the
   `Review by` date and either extend it (with a fresh justification) or remove
   the exception once the dependency is upgraded or dropped.

Advisory (security) exceptions are tracked separately in
`.github/audit-ignore.json` and follow the same time-bounded rules — see
`docs/DEPENDENCY_AUDIT.md`.
