// Review the OpenAPI document and fixtures before acknowledging source changes.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const target = path.join(root, "docs/api/v1/openapi.json");
const doc = JSON.parse(fs.readFileSync(target, "utf8"));

// Deprecation policy metadata.
//
// `x-deprecations` maps a route or field identifier to an entry describing:
//   - since:       version (or date) in which the deprecation was announced
//   - sunset:      version (or date) after which the route/field is removed
//   - replacement: the route/field that consumers should migrate to
//
// When a wire source changes, the snapshot must not silently absorb the change:
// a corresponding deprecation entry must be present so consumers get a
// documented warning and migration window before a breaking wire change.
const deprecations = doc["x-deprecations"] || {};

function normalizeDeprecation(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const { since, sunset, replacement } = entry;
  if (typeof since !== "string" || typeof sunset !== "string") {
    return null;
  }
  if (typeof replacement !== "string") {
    return null;
  }
  return { since, sunset, replacement };
}

const invalidEntries = [];
for (const key of Object.keys(deprecations)) {
  if (!normalizeDeprecation(deprecations[key])) {
    invalidEntries.push(key);
  }
}
if (invalidEntries.length > 0) {
  console.error(
    "Invalid x-deprecations entries (each needs string since, sunset, replacement): " +
      invalidEntries.join(", ")
  );
  process.exit(1);
}

// Track which wire sources changed so we can require deprecation coverage.
const changedSources = [];
for (const file of Object.keys(doc["x-source-sha256"])) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
  const digest = createHash("sha256").update(source).digest("hex");
  if (doc["x-source-sha256"][file] !== digest) {
    changedSources.push(file);
  }
  doc["x-source-sha256"][file] = digest;
}

// A wire source change must be accompanied by at least one deprecation entry
// so the snapshot cannot silently absorb a breaking change. Entries may be
// keyed by route/field or by the source file itself.
if (changedSources.length > 0) {
  const uncovered = changedSources.filter((file) => {
    if (Object.prototype.hasOwnProperty.call(deprecations, file)) {
      return false;
    }
    // Also accept entries whose key references the source file.
    return !Object.keys(deprecations).some((key) => key.includes(file));
  });
  if (uncovered.length > 0) {
    console.error(
      "Refusing to update contract snapshot: wire source(s) changed without a " +
        "corresponding x-deprecations entry:\n  " +
        uncovered.join("\n  ") +
        "\nAdd an x-deprecations entry (since/sunset/replacement) for each affected " +
        "route or field before acknowledging the change."
    );
    process.exit(1);
  }
}

doc["x-deprecations"] = deprecations;
fs.writeFileSync(target, JSON.stringify(doc, null, 2) + "\n");