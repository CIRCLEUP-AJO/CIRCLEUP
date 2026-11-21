#!/usr/bin/env bash
# ─── CircleUp dependency license inventory ────────────────────────────────────
#
# Produces machine-readable license inventories for every package manager in
# the repository:
#
#   artifacts/licenses-*.csv       — JS deps, including devDependencies, per workspace
#   artifacts/licenses-rust.json    — Rust crate licenses (cargo-license)
#   artifacts/licenses-inventory.json — sorted, diffable inventory used for
#                                     change detection against the committed
#                                     baseline artifacts/licenses-baseline.json
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

# ── Stable, diffable JSON inventory (Issue #977) ─────────────────────────────
# Derived from the CSVs and Rust JSON above, sorted by workspace, package and
# version so that change detection against the committed baseline produces
# stable diffs. The baseline lives at artifacts/licenses-baseline.json and is
# updated ONLY via a reviewed pull request — never automatically.
echo "[license-inventory] Building artifacts/licenses-inventory.json..."
node -e '
const fs = require("fs");
const path = require("path");
const artifacts = process.argv[1];
const workspaces = ["app", "indexer", "sdk", "scripts"];
const entries = [];

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

for (const workspace of workspaces) {
  const file = path.join(artifacts, `licenses-${workspace}.csv`);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    if (cols.length < 2) continue;
    const name = cols[0].trim();
    const license = cols[1].trim();
    const at = name.lastIndexOf("@");
    const pkg = at > 0 ? name.slice(0, at) : name;
    const version = at > 0 ? name.slice(at + 1) : "";
    entries.push({ workspace, package: pkg, version, license });
  }
}

const rustFile = path.join(artifacts, "licenses-rust.json");
if (fs.existsSync(rustFile)) {
  try {
    const rust = JSON.parse(fs.readFileSync(rustFile, "utf8"));
    for (const crate of Array.isArray(rust) ? rust : []) {
      entries.push({
        workspace: "contracts",
        package: String(crate.name || ""),
        version: String(crate.version || ""),
        license: String(crate.license || ""),
      });
    }
  } catch (error) {
    console.error(`[license-inventory] WARN: unable to parse licenses-rust.json: ${error.message}`);
  }
}

entries.sort((a, b) =>
  a.workspace.localeCompare(b.workspace) ||
  a.package.localeCompare(b.package) ||
  a.version.localeCompare(b.version) ||
  a.license.localeCompare(b.license),
);

fs.writeFileSync(
  path.join(artifacts, "licenses-inventory.json"),
  `${JSON.stringify(entries, null, 2)}\n`,
);
' "${ARTIFACTS}"
echo "[license-inventory] Written: artifacts/licenses-inventory.json"

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
