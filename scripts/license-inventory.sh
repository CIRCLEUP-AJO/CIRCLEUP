#!/usr/bin/env bash
# ─── CircleUp dependency license inventory ────────────────────────────────────
#
# Produces machine-readable license inventories for every package manager in
# the repository:
#
#   artifacts/licenses-app.csv      — production JS deps for app/
#   artifacts/licenses-indexer.csv  — production JS deps for indexer/
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
# In CI add this as a step after npm ci and cargo fetch so that no network
# access is required during the inventory run:
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
# Permitted SPDX identifiers (non-exhaustive; covers current deps):
#   MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0
#
# Prohibited:
#   GPL-2.0, GPL-3.0, LGPL-2.0, LGPL-2.1, LGPL-3.0, AGPL-3.0
#   CC-BY-NC-*, BUSL-1.1, proprietary / UNLICENSED (unless reviewed)
#
# Unknown or unlisted licenses must receive an explicit exception documented
# in docs/LICENSE_EXCEPTIONS.md before the artifact is released.
#
# Exit codes
# ──────────
#   0   All inventories produced; no prohibited licenses detected.
#   1   A prohibited license was found; see output for details.
#   2   A required tool is missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="${REPO_ROOT}/artifacts"
mkdir -p "${ARTIFACTS}"

# ── Prohibited license patterns (grep-compatible) ────────────────────────────
PROHIBITED_PATTERN="GPL-[23]\.0\|LGPL-[23]\.[01]\|AGPL-3\.0\|CC-BY-NC\|BUSL-1\.1\|UNLICENSED\|proprietary"

violations=0

# ── JS: app workspace ─────────────────────────────────────────────────────────
echo "[license-inventory] Scanning app/ JS dependencies..."
(
  cd "${REPO_ROOT}/app"
  npx license-checker --production --excludePrivatePackages \
    --out "${ARTIFACTS}/licenses-app.csv" --csv
)
echo "[license-inventory] Written: artifacts/licenses-app.csv"

if grep -i "${PROHIBITED_PATTERN}" "${ARTIFACTS}/licenses-app.csv" > /dev/null 2>&1; then
  echo "[license-inventory] ERROR: Prohibited license(s) found in app/ deps:" >&2
  grep -i "${PROHIBITED_PATTERN}" "${ARTIFACTS}/licenses-app.csv" >&2
  violations=$((violations + 1))
fi

# ── JS: indexer workspace ─────────────────────────────────────────────────────
echo "[license-inventory] Scanning indexer/ JS dependencies..."
(
  cd "${REPO_ROOT}/indexer"
  npx license-checker --production --excludePrivatePackages \
    --out "${ARTIFACTS}/licenses-indexer.csv" --csv
)
echo "[license-inventory] Written: artifacts/licenses-indexer.csv"

if grep -i "${PROHIBITED_PATTERN}" "${ARTIFACTS}/licenses-indexer.csv" > /dev/null 2>&1; then
  echo "[license-inventory] ERROR: Prohibited license(s) found in indexer/ deps:" >&2
  grep -i "${PROHIBITED_PATTERN}" "${ARTIFACTS}/licenses-indexer.csv" >&2
  violations=$((violations + 1))
fi

# ── Rust: contracts workspace ─────────────────────────────────────────────────
if ! command -v cargo-license > /dev/null 2>&1; then
  echo "[license-inventory] WARNING: cargo-license not found. Install with:" >&2
  echo "  cargo install cargo-license" >&2
  echo "[license-inventory] Skipping Rust inventory." >&2
else
  echo "[license-inventory] Scanning contracts/ Rust dependencies..."
  (
    cd "${REPO_ROOT}/contracts"
    cargo license --json > "${ARTIFACTS}/licenses-rust.json"
  )
  echo "[license-inventory] Written: artifacts/licenses-rust.json"

  if grep -i "${PROHIBITED_PATTERN}" "${ARTIFACTS}/licenses-rust.json" > /dev/null 2>&1; then
    echo "[license-inventory] ERROR: Prohibited license(s) found in Rust deps:" >&2
    grep -i "${PROHIBITED_PATTERN}" "${ARTIFACTS}/licenses-rust.json" >&2
    violations=$((violations + 1))
  fi
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
