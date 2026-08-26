# License Exceptions

This file records explicit exceptions to the default license policy defined in
`scripts/license-inventory.sh`.

## Policy summary

Permitted SPDX identifiers: `MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`,
`Apache-2.0`, `BlueOak-1.0.0`.

Prohibited: `GPL-*`, `LGPL-*`, `AGPL-*`, `CC-BY-NC-*`, `BUSL-1.1`,
`UNLICENSED`, `proprietary`.

## Exceptions

| Package | License | Workspace | Reviewer | Date | Justification |
|---------|---------|-----------|----------|------|---------------|
| _(none)_ | | | | | |

## Adding an exception

1. Run `bash scripts/license-inventory.sh` and identify the package and SPDX
   identifier.
2. Verify the license text in the package's source repository.
3. Add a row above with your name, the review date, and a one-line
   justification (e.g. "dev-only dependency, not distributed in production
   build").
4. Have the exception reviewed by a second contributor before merging.
