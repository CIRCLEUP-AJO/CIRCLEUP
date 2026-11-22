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
# in docs/LICENSE_EXCEPTIONS.md before the artifact is released. Exceptions are
# never auto-applied: they are reported separately so a reviewer can confirm the
# documented exception still applies. See docs/DEPENDENCY_AUDIT.md for cadence,
# severity thresholds, exception owner, and artifact retention.
#
# Artifacts (uploaded by .github/workflows/dependency-audit.yml)
# ───────────────────────────────────────────────────────────────
#   artifacts/licenses-<workspace>.csv   — JS deps per workspace
#   artifacts/licenses-rust.json         — Rust crate licenses
#   artifacts/license-findings.txt       — prohibited licenses, mapped to policy
#   artifacts/license-exceptions.txt     — findings matching documented exceptions
#
# Exit codes
# ──────────
#   0   All inventories produced; all licenses are allowed (or only documented
#       exceptions were found).
#   1   A prohibited license was found that is not covered by a documented
#       exception; see output for details.
#   2   A required tool is missing.
=======

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="${REPO_ROOT}/artifacts"
mkdir -p "${ARTIFACTS}"

# ── Allowed SPDX identifiers ─────────────────────────────────────────────────
ALLOWED_LICENSES="MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;BlueOak-1.0.0"

violations=0
FINDINGS_FILE="${ARTIFACTS}/license-findings.txt"
EXCEPTIONS_FILE="${ARTIFACTS}/license-exceptions.txt"
: > "${FINDINGS_FILE}"
: > "${EXCEPTIONS_FILE}"

# ── Documented exceptions ─────────────────────────────────────────────────────
# docs/LICENSE_EXCEPTIONS.md lists exceptions as markdown table rows:
#   | <package> | <license> | <owner> | <review-by YYYY-MM-DD> | <rationale> |
# Exceptions are reported, never suppressed: a matching finding is recorded in
# license-exceptions.txt for reviewer confirmation, and an expired review-by
# date is treated as an actionable finding.
EXCEPTIONS_DOC="${REPO_ROOT}/docs/LICENSE_EXCEPTIONS.md"

# Returns 0 if the package/license pair matches a documented, unexpired exception.
match_exception() {
  local pkg="$1" lic="$2"
  [[ -f "${EXCEPTIONS_DOC}" ]] || return 1
  local today
  today="$(date -u +%Y-%m-%d)"
  awk -F'|' -v pkg="${pkg}" -v lic="${lic}" -v today="${today}" '
    /^\|/ {
      gsub(/^[ \t]+|[ \t]+$/, "", $2)
      gsub(/^[ \t]+|[ \t]+$/, "", $3)
      gsub(/^[ \t]+|[ \t]+$/, "", $4)
      gsub(/^[ \t]+|[ \t]+$/, "", $5)
      if ($2 == pkg && $3 == lic && $5 >= today) { found = 1 }
    }
    END { exit(found ? 0 : 1) }
  ' "${EXCEPTIONS_DOC}"
}

# Records a prohibited license finding, distinguishing documented exceptions.
record_finding() {
  local pkg="$1" lic="$2" source="$3"
  if match_exception "${pkg}" "${lic}"; then
    echo "[license-inventory] EXCEPTION (documented): ${pkg} (${lic}) in ${source}" >&2
    echo "${source}: ${pkg} (${lic}) — documented exception, re-review required" >> "${EXCEPTIONS_FILE}"
  else
    echo "[license-inventory] VIOLATION: ${pkg} (${lic}) in ${source}" >&2
    echo "${source}: ${pkg} (${lic}) — prohibited, no documented exception" >> "${FINDINGS_FILE}"
    violations=$((violations + 1))
  fi
}

# ── JS: every npm workspace ───────────────────────────────────────────────────
for workspace in app indexer sdk scripts; do
  echo "[license-inventory] Scanning ${workspace}/ dependencies..."
  (
    cd "${REPO_ROOT}/${workspace}"
    project_package="$(node -e 'const p=require("./package.json"); process.stdout.write(`${p.name}@${p.version}`)')"
    # Always emit the full inventory CSV (no --onlyAllow) so artifacts are
    # reviewable even when prohibited licenses are present.
    npx license-checker --unknown --excludePrivatePackages \
      --excludePackages "${project_package}" \
      --out "${ARTIFACTS}/licenses-${workspace}.csv" --csv
  )
  if [[ -f "${ARTIFACTS}/licenses-${workspace}.csv" ]]; then
    echo "[license-inventory] Written: artifacts/licenses-${workspace}.csv"
    # Map each package's license against the allowlist, reporting findings.
    while IFS=$'\t' read -r pkg lic; do
      [[ -z "${pkg}" || -z "${lic}" ]] && continue
      local_allowed=0
      IFS=';' read -ra allowed_arr <<< "${ALLOWED_LICENSES}"
      for allowed in "${allowed_arr[@]}"; do
        [[ "${lic}" == "${allowed}" ]] && local_allowed=1
      done
      if [[ "${local_allowed}" -eq 0 ]]; then
        record_finding "${pkg}" "${lic}" "${workspace}"
      fi
    done < <(node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        // CSV: "module name","license","repository","publisher","email","url","path"
        const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [];
        const clean = (s) => (s || "").replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, "\"");
        const name = clean(cols[0]);
        const license = clean(cols[1]);
        if (name && license) process.stdout.write(`${name}\t${license}\n`);
      }
    ' "${ARTIFACTS}/licenses-${workspace}.csv")
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
  # Map each crate's license expression against the allowlist.
  while IFS=$'\t' read -r crate lic; do
    [[ -z "${crate}" || -z "${lic}" ]] && continue
    crate_allowed=0
    IFS=';' read -ra allowed_arr <<< "${ALLOWED_LICENSES}"
    for allowed in "${allowed_arr[@]}"; do
      [[ "${lic}" == "${allowed}" ]] && crate_allowed=1
    done
    if [[ "${crate_allowed}" -eq 0 ]]; then
      record_finding "${crate}" "${lic}" "contracts"
    fi
  done < <(node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const entry of data) {
      const name = entry.name || "";
      const license = entry.license || "";
      if (name && license) process.stdout.write(`${name}\t${license}\n`);
    }
  ' "${ARTIFACTS}/licenses-rust.json")
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

if [ -s "${EXCEPTIONS_FILE}" ]; then
  echo ""
  echo "[license-inventory] Documented exceptions found (re-review required):"
  cat "${EXCEPTIONS_FILE}"
fi

if [ "${violations}" -gt 0 ]; then
  echo ""
  echo "[license-inventory] FAILED: ${violations} prohibited license violation(s) found." >&2
  echo "  See artifacts/license-findings.txt for details." >&2
  echo "  Add a time-bounded exception to docs/LICENSE_EXCEPTIONS.md if justified." >&2
  exit 1
fi

echo "[license-inventory] All licenses OK (no undocumented prohibited licenses)."
