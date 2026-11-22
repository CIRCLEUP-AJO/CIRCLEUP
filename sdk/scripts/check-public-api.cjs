#!/usr/bin/env node
/**
 * Release check for the @circleup/sdk public API.
 *
 * Run after a clean build (`npm run check:api` does both). It fails when:
 *
 *   1. a symbol that the docs or examples import from "@circleup/sdk" is not
 *      exported by the built root declaration (dist/index.d.ts);
 *   2. a helper that is internal by design is exported from the root;
 *   3. a consumer in this repo, or a doc, imports a deep path such as
 *      "@circleup/sdk/dist/client";
 *   4. test code was emitted into dist/;
 *   5. package.json "exports" exposes anything beyond the root entry point;
 *   6. the indexer HTTP API changed its wire contract (a field was removed,
 *      renamed, or had its wire type changed) without a matching deprecation
 *      entry — since / sunset / replacement — in the changelog or OpenAPI doc.
 *
 * Every problem is reported at once, and the exit code is non-zero if any were found.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { execFileSync } = require("child_process");

const SDK_DIR = path.resolve(__dirname, "..");
const REPO_DIR = path.resolve(SDK_DIR, "..");
const DIST_ENTRY = path.join(SDK_DIR, "dist", "index.d.ts");

/** Exported from client.ts for unit tests only — never part of the root API. */
const INTERNAL_ONLY = ["isTransientRpcError", "withRpcRetry", "mayHaveReachedServer", "withRpcReadDeadline", "optionalRead"];

/** Markdown and TypeScript files whose `@circleup/sdk` imports are documentation. */
const DOC_SOURCES = [
  "README.md",
  "QUICK_REFERENCE.md",
  "sdk/CONTRACT_FIXTURES.md",
  "docs",
  "sdk/examples",
];

/**
 * Docs whose imports are illustrative rather than real API — the deprecation
 * policy walks through a hypothetical `formatUsdcLegacy` symbol.
 */
const ILLUSTRATIVE_DOCS = new Set(["docs/DEPRECATION_POLICY.md"]);

/** Consumer code scanned for deep imports. */
const CONSUMER_SOURCES = ["app/src", "scripts/src", "indexer/src", "tests", "sdk/examples"];

/** Committed snapshot of the indexer wire contract (routes + response fields). */
const CONTRACT_SNAPSHOT = "indexer/api-contract.snapshot.json";

/** Documents that may carry a deprecation entry for a wire-breaking change. */
const DEPRECATION_DOCS = ["CHANGELOG.md", "docs/DEPRECATION_POLICY.md", "indexer/openapi.json", "indexer/openapi.yaml"];

/**
 * Contracts a wire-breaking change can reach. Reported on failure so release
 * review can identify every consumer that needs a migration window.
 */
const AFFECTED_CONTRACTS = [
  "app (app/src) — in-repo HTTP client",
  "sdk (@circleup/sdk) — published client types",
  "external consumers — third-party indexer API clients",
];

const problems = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function listFiles(rel, exts) {
  const abs = path.join(REPO_DIR, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const child = path.posix.join(rel.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) out.push(...listFiles(child, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(child);
  }
  return out;
}

function read(rel) {
  return fs.readFileSync(path.join(REPO_DIR, rel), "utf8");
}

/** Names imported from the package root, e.g. `import { a, type B as C } from "@circleup/sdk"`. */
function rootImports(text) {
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@circleup\/sdk["']/g;
  const names = [];
  let m;
  while ((m = re.exec(text))) {
    m[1]
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
      .forEach((n) => names.push(n));
  }
  return names;
}

/** Every name exported by the built root declaration, resolved through `export *`. */
function builtExports() {
  if (typeof ts.createProgram === "function" && ts.ModuleResolutionKind) {
    try {
      const program = ts.createProgram([DIST_ENTRY], {
        noEmit: true,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.Node10 ?? 2,
      });
      const checker = program.getTypeChecker();
      const source = program.getSourceFile(DIST_ENTRY);
      const moduleSymbol = source && checker.getSymbolAtLocation(source);
      if (moduleSymbol) {
        return new Set(checker.getExportsOfModule(moduleSymbol).map((s) => s.getName()));
      }
    } catch {
      // Fallback to declaration parser below
    }
  }

  // Robust declaration parser across TypeScript versions
  const seenFiles = new Set();
  function parseDts(file) {
    if (seenFiles.has(file) || !fs.existsSync(file)) return new Set();
    seenFiles.add(file);
    const code = fs.readFileSync(file, "utf8");
    const names = new Set();

    // export { a, b, type c } from "..." or export { a, b }
    const namedRe = /export\s+(?:type\s+)?\{([^}]+)\}/g;
    let m;
    while ((m = namedRe.exec(code))) {
      m[1]
        .split(",")
        .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim())
        .filter(Boolean)
        .forEach((n) => names.add(n));
    }

    // export * from "./sub"
    const starRe = /export\s+\*\s+from\s+["']([^"']+)["']/g;
    while ((m = starRe.exec(code))) {
      const sub = path.resolve(path.dirname(file), m[1] + (m[1].endsWith(".d.ts") ? "" : ".d.ts"));
      const subExports = parseDts(sub);
      for (const e of subExports) names.add(e);
    }

    // export declare function/const/class/type/interface
    const declRe = /export\s+(?:declare\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([a-zA-Z0-9_$]+)/g;
    while ((m = declRe.exec(code))) {
      if (m[1] !== "from" && m[1] !== "default") names.add(m[1]);
    }

    return names;
  }

  return parseDts(DIST_ENTRY);
}

// ── 1 & 2. Root exports vs docs, and internal helpers ────────────────────────

if (!fs.existsSync(DIST_ENTRY)) {
  problems.push(`dist/index.d.ts is missing — run "npm run build" first.`);
} else {
  const exported = builtExports();
  if (!exported) {
    problems.push("could not read the exports of dist/index.d.ts.");
  } else {
    for (const rel of DOC_SOURCES.flatMap((s) => listFiles(s, [".md", ".ts"]))) {
      if (ILLUSTRATIVE_DOCS.has(rel)) continue;
      for (const name of new Set(rootImports(read(rel)))) {
        if (!exported.has(name)) {
          problems.push(`${rel} imports "${name}" from "@circleup/sdk", but the root does not export it.`);
        }
      }
    }
    for (const name of INTERNAL_ONLY) {
      if (exported.has(name)) {
        problems.push(`internal helper "${name}" is exported from the package root.`);
      }
    }
    console.log(`Root exports: ${exported.size} symbols.`);
  }
}

// ── 3. Deep imports ──────────────────────────────────────────────────────────

const DEEP_IMPORT_RE = /(?:from\s*|require\(\s*|import\(\s*)["']@circleup\/sdk\/(?!package\.json)[^"']*["']/g;
for (const rel of [
  ...CONSUMER_SOURCES.flatMap((s) => listFiles(s, [".ts", ".tsx", ".js", ".mjs", ".cjs"])),
  ...DOC_SOURCES.flatMap((s) => listFiles(s, [".md"])),
]) {
  const text = read(rel);
  let m;
  while ((m = DEEP_IMPORT_RE.exec(text))) {
    const line = text.slice(0, m.index).split("\n").length;
    problems.push(`${rel}:${line} uses a deep import (${m[0]}); import from "@circleup/sdk" instead.`);
  }
}

// ── 4. Test code in dist ─────────────────────────────────────────────────────

const distDir = path.join(SDK_DIR, "dist");
if (fs.existsSync(distDir)) {
  for (const rel of listFiles(path.relative(REPO_DIR, distDir), [""])) {
    if (/(^|\/)__tests__(\/|$)|\.test\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(rel)) {
      problems.push(`${rel} is test code and must not be published.`);
    }
  }
}

// ── 5. package.json entry points ─────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(path.join(SDK_DIR, "package.json"), "utf8"));
const allowedEntries = new Set([".", "./package.json"]);
if (!pkg.exports || typeof pkg.exports !== "object") {
  problems.push(`package.json has no "exports" map, so every file in dist/ is importable.`);
} else {
  for (const key of Object.keys(pkg.exports)) {
    if (!allowedEntries.has(key)) {
      problems.push(`package.json "exports" advertises "${key}"; only the root entry point is stable.`);
    }
  }
}

// ── 6. Indexer wire contract vs committed snapshot ───────────────────────────

/**
 * Flatten a contract snapshot into `route -> field -> wireType` entries.
 * A snapshot looks like:
 *   { "routes": { "GET /api/v1/events": { "fields": { "id": "string", ... } } } }
 */
function flattenContract(contract) {
  const out = new Map();
  const routes = (contract && contract.routes) || {};
  for (const [route, def] of Object.entries(routes)) {
    const fields = (def && def.fields) || {};
    for (const [field, wireType] of Object.entries(fields)) {
      out.set(`${route} ${field}`, String(wireType));
    }
  }
  return out;
}

/** True when a doc records a deprecation entry for `route`/`field`. */
function hasDeprecationEntry(route, field) {
  for (const rel of DEPRECATION_DOCS) {
    const abs = path.join(REPO_DIR, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const idx = text.indexOf(field);
    if (idx === -1) continue;
    // Look at a window around the field mention for the required markers.
    const window = text.slice(Math.max(0, idx - 400), idx + 400);
    const mentionsRoute = window.includes(route) || window.includes(route.split(" ").pop());
    const hasSince = /\bsince\b/i.test(window);
    const hasSunset = /\bsunset\b/i.test(window);
    const hasReplacement = /\b(?:replacement|replaced\s+by|use\s+`?[A-Za-z0-9_]+`?\s+instead)\b/i.test(window);
    if (mentionsRoute && hasSince && hasSunset && hasReplacement) return true;
  }
  return false;
}

/** Build the current contract from the indexer sources. */
function currentContract() {
  const script = path.join(REPO_DIR, "indexer", "scripts", "dump-api-contract.cjs");
  if (!fs.existsSync(script)) return null;
  try {
    const json = execFileSync(process.execPath, [script], { cwd: REPO_DIR, encoding: "utf8" });
    return JSON.parse(json);
  } catch (err) {
    problems.push(`could not build the current indexer contract: ${err.message.split("\n")[0]}`);
    return null;
  }
}

const snapshotPath = path.join(REPO_DIR, CONTRACT_SNAPSHOT);
if (!fs.existsSync(snapshotPath)) {
  problems.push(`${CONTRACT_SNAPSHOT} is missing — commit the indexer wire contract snapshot.`);
} else {
  const previous = flattenContract(JSON.parse(fs.readFileSync(snapshotPath, "utf8")));
  const current = currentContract();
  if (current) {
    const next = flattenContract(current);
    const breaking = [];
    for (const [key, wireType] of previous) {
      const [route, field] = key.split(" ");
      if (!next.has(key)) {
        breaking.push({ route, field, kind: "removed" });
      } else if (next.get(key) !== wireType) {
        breaking.push({ route, field, kind: `wire type ${wireType} -> ${next.get(key)}` });
      }
    }
    // A field that only appears under a different name on the same route is a rename.
    for (const [key] of next) {
      const [route, field] = key.split(" ");
      if (previous.has(key)) continue;
      const renamedFrom = [...previous.keys()].find(
        (k) => k.startsWith(`${route} `) && !next.has(k) && k.split(" ")[1] !== field,
      );
      if (renamedFrom) {
        breaking.push({ route, field, kind: `renamed from "${renamedFrom.split(" ")[1]}"` });
      }
    }
    for (const change of breaking) {
      if (hasDeprecationEntry(change.route, change.field)) continue;
      problems.push(
        `${change.route} field "${change.field}" was ${change.kind} without a deprecation entry ` +
          `(since / sunset / replacement) in ${DEPRECATION_DOCS.join(", ")}.`,
      );
    }
    if (breaking.length > 0) {
      console.error("Wire-breaking indexer API changes affect these contracts:");
      for (const c of AFFECTED_CONTRACTS) console.error(`  - ${c}`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error(`Public API check failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log("Public API check passed.");
