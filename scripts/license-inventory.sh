#!/usr/bin/env bash
# ─── CircleUp dependency license inventory ────────────────────────────────────
#
# Produces machine-readable license inventories for every package manager in
# the repository:
#
#   artifacts/licenses-*.csv       — JS deps, including devDependencies, per workspace
#   artifacts/licenses-rust.json    — Rust crate licenses (cargo-license)
#
# Requirements
# ────────────
#   node + npm           (JS workspaces)
#   cargo-license        install once: cargo install cargo-license
#
# Usage
# ─────
#   bash scripts/license-inventory.sh
#
# In CI install cargo-license and run cargo fetch before this check so no
# network access is required during inventory generation.
#
#   - name: Generate license inventory
#     run: bash scripts/license-inventory.sh
#   - name: Upload license artifacts
#     uses: actions/upload-artifact@v4
#     with:
#       name: licenses
#       path: artifacts/
#
# Policy
# ──────
# Permitted SPDX identifiers (enforced exactly by license-checker and cargo-deny):
#   MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0
#
# Unknown or unlisted licenses must receive an explicit exception documented
# in docs/LICENSE_EXCEPTIONS.md before the artifact is released.
#
# Exit codes
# ──────────
#   0   All inventories produced; all licenses are allowed.
#   1   A prohibited license was found; see output for details.
#   2   A required tool is missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="${REPO_ROOT}/artifacts"
mkdir -p "${ARTIFACTS}"

# ── Allowed SPDX identifiers ─────────────────────────────────────────────────
ALLOWED_LICENSES="MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;BlueOak-1.0.0"

violations=0

# ── JS: every npm workspace ───────────────────────────────────────────────────
for workspace in app indexer sdk scripts; do
  echo "[license-inventory] Scanning ${workspace}/ dependencies..."
  (
    cd "${REPO_ROOT}/${workspace}"
    project_package="$(node -e 'const p=require("./package.json"); process.stdout.write(`${p.name}@${p.version}`)')"
    npx license-checker --unknown --excludePrivatePackages \
      --onlyAllow "${ALLOWED_LICENSES}" --excludePackages "${project_package}" \
      --out "${ARTIFACTS}/licenses-${workspace}.csv" --csv
  ) || violations=$((violations + 1))
  if [[ -f "${ARTIFACTS}/licenses-${workspace}.csv" ]]; then
    echo "[license-inventory] Written: artifacts/licenses-${workspace}.csv"
  fi
done

# ── Rust: contracts workspace ─────────────────────────────────────────────────
if ! command -v cargo-license > /dev/null 2>&1; then
  echo "[license-inventory] ERROR: cargo-license not found. Install with:" >&2
  echo "  cargo install cargo-license" >&2
  exit 2
else
  echo "[license-inventory] Scanning contracts/ Rust dependencies..."
  (
    cd "${REPO_ROOT}/contracts"
    cargo license --json > "${ARTIFACTS}/licenses-rust.json"
  )
  echo "[license-inventory] Written: artifacts/licenses-rust.json"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "[license-inventory] Inventory complete. Artifacts in: ${ARTIFACTS}/"
ls -lh "${ARTIFACTS}/"

if [ "${violations}" -gt 0 ]; then
  echo ""
  echo "[license-inventory] FAILED: ${violations} prohibited license violation(s) found." >&2
  echo "  Add an exception to docs/LICENSE_EXCEPTIONS.md if the use is justified." >&2
  exit 1
fi

echo "[license-inventory] All licenses OK."
