#!/usr/bin/env ts-node
/**
 * validate-templates.ts — Contributor-template & documentation integrity checker
 *
 * Two responsibilities:
 *
 *   1. Template integrity (issue/PR templates, SUPPORT.md, SECURITY.md):
 *      verifies relative (repo-local) links resolve on disk and asserts that
 *      the bug-report / feature-request / PR templates carry their required
 *      content tokens.
 *
 *   2. Documentation validation (all Markdown files in the repo):
 *      - inventories Markdown files (skipping node_modules, build output, etc.)
 *      - resolves repository-relative links, including `#anchor` fragments
 *      - verifies referenced npm scripts (`npm run <script>`) and workspace
 *        paths against the relevant package.json files
 *      - ignores external http(s) URLs (no network access required) and code
 *        spans / fenced code blocks (so example commands are not validated)
 *      - supports a suppression mechanism for valid nonstandard references
 *
 * Usage (called from CI):
 *   npx ts-node scripts/src/validate-templates.ts
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed; actionable locations printed to stdout
 *
 * Design goals (from the acceptance criteria):
 *   - Reports broken links as <file>:<line>: <message> so editors and CI
 *     annotations can point directly to the problem.
 *   - Safety-notice check is content-agnostic: it looks for the presence of
 *     known redaction keywords rather than comparing exact prose, so normal
 *     template improvements never trip the check.
 *   - External links are never fetched; CI never depends on network access.
 *   - No transitive dependencies beyond Node built-ins + ts-node.
 *
 * Suppressing a valid nonstandard reference
 * -----------------------------------------
 * Some links or commands are intentionally nonstandard (generated files,
 * example paths, scripts defined outside the scanned package.json, etc.).
 * To suppress a finding, add a `doc-validate:ignore` HTML comment on the same
 * line as the reference, or on the line immediately above it:
 *
 *   <!-- doc-validate:ignore -->
 *   [generated](./build/generated/README.md)
 *
 *   See [example](./examples/not-yet-committed.md) <!-- doc-validate:ignore -->
 *
 * A suppression applies only to the line it annotates (or the next line when
 * placed on its own line).  Use it sparingly and explain why in the PR.
 */

import fs from "fs";
import path from "path";

// ── Paths ─────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GITHUB_DIR = path.join(REPO_ROOT, ".github");

/** Marker that suppresses a finding on the annotated line (or the next line). */
const SUPPRESSION_MARKER = "doc-validate:ignore";

/** Directories that are never scanned for Markdown documentation. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "out",
  "artifacts",
]);

/** Directories that hold fixtures for the validator itself. */
const FIXTURE_DIR = path.join(REPO_ROOT, "scripts", "fixtures", "doc-validate");

/** Template files to scan.  Paths are relative to REPO_ROOT. */
export function collectTemplatePaths(): string[] {
  const paths: string[] = [];

  // All files under .github/ISSUE_TEMPLATE/
  const issueTemplateDir = path.join(GITHUB_DIR, "ISSUE_TEMPLATE");
  if (fs.existsSync(issueTemplateDir)) {
    for (const entry of fs.readdirSync(issueTemplateDir)) {
      paths.push(path.join(issueTemplateDir, entry));
    }
  }

  // The single PR template
  const prTemplate = path.join(GITHUB_DIR, "PULL_REQUEST_TEMPLATE.md");
  if (fs.existsSync(prTemplate)) {
    paths.push(prTemplate);
  }

  // SUPPORT.md and SECURITY.md at repo root (they contain navigational links)
  for (const name of ["SUPPORT.md", "SECURITY.md"]) {
    const p = path.join(REPO_ROOT, name);
    if (fs.existsSync(p)) paths.push(p);
  }

  return paths;
}

// ── Markdown inventory ────────────────────────────────────────────────────────

/**
 * Recursively collects every Markdown file under REPO_ROOT, skipping
 * dependency/build directories and the validator's own fixtures (which are
 * intentionally broken and are exercised by the fixture tests instead).
 */
export function collectMarkdownFiles(root: string = REPO_ROOT): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (full === FIXTURE_DIR) continue;
        walk(full);
      } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
        results.push(full);
      }
    }
  }

  walk(root);
  return results.sort();
}

// ── Suppression handling ──────────────────────────────────────────────────────

/**
 * Returns a predicate that reports whether a given 1-based line number in the
 * file is suppressed.  A suppression marker on line N suppresses line N and
 * line N+1 (so it can sit on its own line above the reference).
 */
export function buildSuppressionPredicate(
  lines: string[],
): (lineNumber: number) => boolean {
  const suppressed = new Set<number>();
  lines.forEach((text, idx) => {
    if (text.includes(SUPPRESSION_MARKER)) {
      suppressed.add(idx + 1);
      suppressed.add(idx + 2);
    }
  });
  return (lineNumber: number) => suppressed.has(lineNumber);
}

/**
 * Replaces fenced code blocks and inline code spans with blank placeholders so
 * that example commands and links inside code are not validated.  Line numbers
 * are preserved (each replaced character becomes a space, newlines are kept).
 */
export function maskCode(content: string): string {
  const lines = content.split("\n");
  let inFence = false;
  let fenceMarker = "";

  const masked = lines.map((line) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
        return " ".repeat(line.length);
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = "";
        return " ".repeat(line.length);
      }
    }
    if (inFence) return " ".repeat(line.length);

    // Mask inline code spans (`...`) while preserving surrounding text.
    return line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
  });

  return masked.join("\n");
}

// ── Link extraction ────────────────────────────────────────────────────────────

interface LinkOccurrence {
  /** Absolute path of the file containing the link. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Raw link text as it appears in the source, e.g. "../docs/EVENTS.md" */
  rawLink: string;
  /** Resolved absolute path on disk. */
  resolvedPath: string;
}

/**
 * Markdown link patterns we care about:
 *   [text](../relative/path)      — inline links
 *   [text](./relative/path)
 *   [text](relative/path)         — no leading dot (e.g. "SECURITY.md")
 *
 * We intentionally ignore:
 *   - http:// / https:// links (external, not repo-local)
 *   - Anchor-only links (#section)
 *   - mailto: links
 */
const RELATIVE_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export function extractRelativeLinks(filePath: string): LinkOccurrence[] {
  const content = fs.readFileSync(filePath, "utf8");
  const masked = maskCode(content);
  const lines = masked.split("\n");
  const results: LinkOccurrence[] = [];
  const fileDir = path.dirname(filePath);

  lines.forEach((lineText, idx) => {
    let match: RegExpExecArray | null;
    RELATIVE_LINK_RE.lastIndex = 0;
    while ((match = RELATIVE_LINK_RE.exec(lineText)) !== null) {
      const rawLink = match[2].trim();

      // Skip external URLs, anchors, and mailto links
      if (
        rawLink.startsWith("http://") ||
        rawLink.startsWith("https://") ||
        rawLink.startsWith("#") ||
        rawLink.startsWith("mailto:")
      ) {
        continue;
      }

      // Strip fragment (#section) before resolving path
      const linkWithoutFragment = rawLink.split("#")[0];
      if (!linkWithoutFragment) continue; // pure anchor

      const resolvedPath = path.resolve(fileDir, linkWithoutFragment);
      results.push({
        file: filePath,
        line: idx + 1,
        rawLink,
        resolvedPath,
      });
    }
  });

  return results;
}

// ── Anchor validation ─────────────────────────────────────────────────────────

/**
 * Converts a Markdown heading into the GitHub-style anchor slug.
 * Lowercases, strips punctuation, and replaces spaces with hyphens.
 */
export function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * Collects the set of anchor slugs defined by headings in a Markdown file.
 */
export function collectAnchors(filePath: string): Set<string> {
  const content = fs.readFileSync(filePath, "utf8");
  const masked = maskCode(content);
  const anchors = new Set<string>();
  for (const line of masked.split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) anchors.add(slugifyHeading(heading[1]));
  }
  return anchors;
}

interface AnchorOccurrence {
  file: string;
  line: number;
  rawLink: string;
  /** Absolute path of the file whose anchor is referenced. */
  targetFile: string;
  anchor: string;
}

/**
 * Extracts links that carry a `#fragment`, so the fragment can be validated
 * against the target file's headings.  Pure anchors (`#section`) are checked
 * against the containing file.
 */
export function extractAnchorLinks(filePath: string): AnchorOccurrence[] {
  const content = fs.readFileSync(filePath, "utf8");
  const masked = maskCode(content);
  const lines = masked.split("\n");
  const results: AnchorOccurrence[] = [];
  const fileDir = path.dirname(filePath);

  lines.forEach((lineText, idx) => {
    let match: RegExpExecArray | null;
    RELATIVE_LINK_RE.lastIndex = 0;
    while ((match = RELATIVE_LINK_RE.exec(lineText)) !== null) {
      const rawLink = match[2].trim();
      if (
        rawLink.startsWith("http://") ||
        rawLink.startsWith("https://") ||
        rawLink.startsWith("mailto:")
      ) {
        continue;
      }
      const hashIndex = rawLink.indexOf("#");
      if (hashIndex === -1) continue;
      const anchor = rawLink.slice(hashIndex + 1);
      if (!anchor) continue;
      const linkPath = rawLink.slice(0, hashIndex);
      const targetFile = linkPath
        ? path.resolve(fileDir, linkPath)
        : filePath;
      results.push({
        file: filePath,
        line: idx + 1,
        rawLink,
        targetFile,
        anchor,
      });
    }
  });

  return results;
}

// ── npm script & workspace validation ────────────────────────────────────────

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

/** Reads and parses a package.json, returning null when absent/invalid. */
export function readPackageJson(pkgPath: string): PackageJson | null {
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

interface ScriptReference {
  file: string;
  line: number;
  script: string;
  /** Directory whose package.json is expected to define the script. */
  packageDir: string;
}

/**
 * Finds `npm run <script>` / `npm run-script <script>` references in prose
 * (code spans are masked out, so only documented commands are checked).
 */
export function extractScriptReferences(filePath: string): ScriptReference[] {
  const content = fs.readFileSync(filePath, "utf8");
  const masked = maskCode(content);
  const lines = masked.split("\n");
  const results: ScriptReference[] = [];
  const fileDir = path.dirname(filePath);

  const scriptRe = /\bnpm\s+run(?:-script)?\s+([A-Za-z0-9:_-]+)/g;

  lines.forEach((lineText, idx) => {
    let match: RegExpExecArray | null;
    scriptRe.lastIndex = 0;
    while ((match = scriptRe.exec(lineText)) !== null) {
      results.push({
        file: filePath,
        line: idx + 1,
        script: match[1],
        packageDir: fileDir,
      });
    }
  });

  return results;
}

/**
 * Walks up from `startDir` to REPO_ROOT looking for the nearest package.json.
 * Returns the directory containing it, or null when none is found.
 */
export function findNearestPackageDir(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (dir === REPO_ROOT) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Verifies that a script is defined in the nearest package.json (or the root
 * package.json as a fallback for docs that reference root-level scripts).
 */
export function scriptExists(script: string, packageDir: string): boolean {
  const candidates = [packageDir, REPO_ROOT];
  for (const dir of candidates) {
    const pkg = readPackageJson(path.join(dir, "package.json"));
    if (pkg?.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, script)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts workspace paths declared in the root package.json and verifies each
 * resolves to an existing directory.
 */
export function collectWorkspacePaths(): { pattern: string; resolved: string }[] {
  const rootPkg = readPackageJson(path.join(REPO_ROOT, "package.json"));
  if (!rootPkg?.workspaces) return [];
  const patterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : rootPkg.workspaces.packages ?? [];
  return patterns
    .filter((p) => !p.includes("*"))
    .map((p) => ({ pattern: p, resolved: path.resolve(REPO_ROOT, p) }));
}

// ── Safety-notice check ────────────────────────────────────────────────────────

/**
 * Keywords that must appear together in the bug-report template.
 *
 * We check for the PRESENCE of these content tokens rather than exact prose
 * so ordinary template rewording never triggers a false positive.  The intent
 * is to verify that the template warns contributors about each category of
 * sensitive data — not to enforce wording.
 *
 * What each keyword represents:
 *   "seed"       → seed phrase / mnemonic warning
 *   "private key" → private key / secret key warning (also catches "S-prefix")
 *   "XDR"        → signed XDR / transaction envelope warning
 *   "API key"    → API key / credential warning
 *                  (also matches "api key" case-insensitively)
 *   "SECURITY.md" → the template must reference the security policy
 */
const REQUIRED_SAFETY_TOKENS: string[] = [
  "seed",
  "private key",
  "xdr",
  "api key",
  "SECURITY.md",
];

/**
 * Returns the list of missing safety tokens for the bug-report template.
 * An empty array means all tokens are present.
 */
export function checkBugReportSafetyNotice(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8").toLowerCase();
  return REQUIRED_SAFETY_TOKENS.filter(
    (token) => !content.includes(token.toLowerCase()),
  );
}

// ── Feature-request component-checklist check ─────────────────────────────────

/**
 * Tokens that must appear in feature_request.md to confirm it carries an
 * affected-component checklist.  We check for the presence of checkbox syntax
 * combined with at least one known package name so ordinary rewording never
 * trips the check.
 *
 * What each token represents:
 *   "- [ ]"      → standard GitHub checkbox syntax — confirms a checklist exists
 *   "contracts"  → at least one contracts/ entry exists in the list
 *   "indexer"    → indexer package is listed
 *   "app"        → app package is listed
 */
const REQUIRED_FEATURE_REQUEST_TOKENS: string[] = [
  "- [ ]",
  "contracts",
  "indexer",
  "app",
];

/**
 * Returns the list of missing component-checklist tokens for the feature-request
 * template.  An empty array means all tokens are present.
 */
export function checkFeatureRequestComponentList(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8").toLowerCase();
  return REQUIRED_FEATURE_REQUEST_TOKENS.filter(
    (token) => !content.includes(token.toLowerCase()),
  );
}

// ── PR template integrity check ───────────────────────────────────────────────

/**
 * Tokens that must appear in PULL_REQUEST_TEMPLATE.md to confirm it carries
 * the required security-review and traceability sections.
 *
 * What each token represents:
 *   "security"       → a contract security checklist section exists
 *   "traceab"        → a traceability table or section exists
 *   "changelog"      → contributor is reminded to update CHANGELOG.md
 *   "- [ ]"          → at least one actionable checkbox is present
 */
const REQUIRED_PR_TEMPLATE_TOKENS: string[] = [
  "security",
  "traceab",
  "changelog",
  "- [ ]",
];

/**
 * Returns the list of missing integrity tokens for the PR template.
 * An empty array means all tokens are present.
 */
export function checkPrTemplateIntegrity(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8").toLowerCase();
  return REQUIRED_PR_TEMPLATE_TOKENS.filter(
    (token) => !content.includes(token.toLowerCase()),
  );
}

// ── Package-impact & verification convention check ────────────────────────────

/**
 * Tokens that must appear in the issue and PR templates to confirm they carry
 * the compact package-impact / verification section described in
 * docs/TRACEABILITY.md.
 *
 * The convention is deliberately checkbox-free: contributors map each
 * acceptance criterion to the affected packages and the commands that verify
 * the behavior, without duplicating a full test plan.
 *
 * What each token represents:
 *   "package impact"    → the section heading exists
 *   "verification"      → contributors state how the change is verified
 *   "acceptance"        → criteria are mapped, not just listed
 *   "contracts"         → at least one package boundary is named
 *   "indexer"           → indexer boundary is named
 *   "app"               → app boundary is named
 *   "TRACEABILITY.md"   → the convention doc is linked for guidance
 */
const REQUIRED_TRACEABILITY_TOKENS: string[] = [
  "package impact",
  "verification",
  "acceptance",
  "contracts",
  "indexer",
  "app",
  "TRACEABILITY.md",
];

/**
 * Returns the list of missing traceability tokens for a template file.
 * An empty array means all tokens are present.
 */
export function checkTraceabilitySection(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8").toLowerCase();
  return REQUIRED_TRACEABILITY_TOKENS.filter(
    (token) => !content.includes(token.toLowerCase()),
  );
}

// ── Diagnosis & reporting ─────────────────────────────────────────────────────

interface Failure {
  /** Human-readable location string: "path/to/file.md:42" */
  location: string;
  message: string;
}

function relPath(absolute: string): string {
  return path.relative(REPO_ROOT, absolute);
}

// ── Documentation validation ─────────────────────────────────────────────────

/**
 * Runs the documentation checks over every Markdown file and returns failures.
 * External URLs are never fetched, so this is safe to run offline in CI.
 */
export function validateDocumentation(
  markdownFiles: string[] = collectMarkdownFiles(),
): Failure[] {
  const failures: Failure[] = [];

  for (const filePath of markdownFiles) {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const isSuppressed = buildSuppressionPredicate(lines);

    // 1. Relative link targets must exist.
    for (const link of extractRelativeLinks(filePath)) {
      if (isSuppressed(link.line)) continue;
      if (!fs.existsSync(link.resolvedPath)) {
        failures.push({
          location: `${relPath(link.file)}:${link.line}`,
          message: `broken relative link "${link.rawLink}" — target not found: ${relPath(link.resolvedPath)}`,
        });
      }
    }

    // 2. Anchor fragments must match a heading in the target file.
    for (const anchorLink of extractAnchorLinks(filePath)) {
      if (isSuppressed(anchorLink.line)) continue;
      if (!fs.existsSync(anchorLink.targetFile)) continue; // reported above
      const anchors = collectAnchors(anchorLink.targetFile);
      if (!anchors.has(anchorLink.anchor.toLowerCase())) {
        failures.push({
          location: `${relPath(anchorLink.file)}:${anchorLink.line}`,
          message: `broken anchor "${anchorLink.rawLink}" — no matching heading in ${relPath(anchorLink.targetFile)}`,
        });
      }
    }

    // 3. Referenced npm scripts must be defined in a package.json.
    for (const ref of extractScriptReferences(filePath)) {
      if (isSuppressed(ref.line)) continue;
      const packageDir = findNearestPackageDir(ref.packageDir);
      if (!packageDir) continue; // no package.json context — skip
      if (!scriptExists(ref.script, packageDir)) {
        failures.push({
          location: `${relPath(ref.file)}:${ref.line}`,
          message: `unknown npm script "${ref.script}" — not defined in ${relPath(path.join(packageDir, "package.json"))} or the root package.json`,
        });
      }
    }
  }

  // 4. Declared workspace paths must resolve to existing directories.
  for (const ws of collectWorkspacePaths()) {
    if (!fs.existsSync(ws.resolved)) {
      failures.push({
        location: "package.json",
        message: `workspace path "${ws.pattern}" does not exist: ${relPath(ws.resolved)}`,
      });
    }
  }

  return failures;
}

// ── Runner ─────────────────────────────────────────────────────────────────────

function run(): void {
  const templatePaths = collectTemplatePaths();

  if (templatePaths.length === 0) {
    console.error(
      "validate-templates: no template files found under .github/ — " +
        "check that the repository structure is intact.",
    );
    process.exit(1);
  }

  const failures: Failure[] = [];

  // ── 1. Relative link resolution ──────────────────────────────────────────
  for (const filePath of templatePaths) {
    const links = extractRelativeLinks(filePath);
    for (const link of links) {
      if (!fs.existsSync(link.resolvedPath)) {
        failures.push({
          location: `${relPath(link.file)}:${link.line}`,
          message: `broken relative link "${link.rawLink}" — target not found: ${relPath(link.resolvedPath)}`,
        });
      }
    }
  }

  // ── 2. Bug-report safety notice ──────────────────────────────────────────
  const bugReportPath = path.join(
    GITHUB_DIR,
    "ISSUE_TEMPLATE",
    "bug_report.md",
  );
  if (fs.existsSync(bugReportPath)) {
    const missing = checkBugReportSafetyNotice(bugReportPath);
    for (const token of missing) {
      failures.push({
        location: relPath(bugReportPath),
        message:
          `missing required safety-notice content — expected the word/phrase "${token}" ` +
          `to appear somewhere in the template (exact wording is not required, ` +
          `but the concept must be addressed).`,
      });
    }
  } else {
    failures.push({
      location: relPath(bugReportPath),
      message:
        "bug_report.md not found — every project must have a bug-report template " +
        "with a safety notice so contributors know what NOT to include in public issues.",
    });
  }

  // ── 3. Feature-request component checklist ───────────────────────────────
  //
  // feature_request.md must include at least one checkbox item that lets
  // contributors identify which part of the codebase their request targets.
  // This keeps triage tractable across the monorepo structure.
  const featureRequestPath = path.join(
    GITHUB_DIR,
    "ISSUE_TEMPLATE",
    "feature_request.md",
  );
  if (fs.existsSync(featureRequestPath)) {
    const missing = checkFeatureRequestComponentList(featureRequestPath);
    for (const token of missing) {
      failures.push({
        location: relPath(featureRequestPath),
        message:
          `missing required component-checklist content — expected "${token}" ` +
          `to appear so contributors can identify which package their request affects.`,
      });
    }
  } else {
    failures.push({
      location: relPath(featureRequestPath),
      message:
        "feature_request.md not found — the repository must have a feature-request " +
        "template with an affected-component checklist for triage.",
    });
  }

  // ── 4. Documentation links, anchors, scripts, and workspace paths ─────────
  //
  // External http(s) links are never fetched, so this check runs offline.
  failures.push(...validateDocumentation());

  // ── 5. PR template must exist and carry security + traceability sections ──
  const prTemplatePath = path.join(GITHUB_DIR, "PULL_REQUEST_TEMPLATE.md");
  if (!fs.existsSync(prTemplatePath)) {
    failures.push({
      location: relPath(prTemplatePath),
      message:
        "PULL_REQUEST_TEMPLATE.md not found — the repository must have a PR template.",
    });
  } else {
    const missingPr = checkPrTemplateIntegrity(prTemplatePath);
    for (const token of missingPr) {
      failures.push({
        location: relPath(prTemplatePath),
        message:
          `missing required PR template section — expected "${token}" ` +
          `to be present so reviewers can verify security and traceability.`,
      });
    }
  }

  // ── 5. Package-impact & verification convention (issue + PR templates) ────
  //
  // Both the feature-request template and the PR template must carry the
  // compact package-impact / verification section so cross-package changes
  // (contract → indexer → app → deployment) surface missing evidence at
  // review time.  See docs/TRACEABILITY.md for the convention and examples.
  for (const filePath of [featureRequestPath, prTemplatePath]) {
    if (!fs.existsSync(filePath)) continue; // already reported above
    const missingTrace = checkTraceabilitySection(filePath);
    for (const token of missingTrace) {
      failures.push({
        location: relPath(filePath),
        message:
          `missing package-impact/verification content — expected "${token}" ` +
          `so each acceptance criterion maps to affected packages and ` +
          `verification commands (see docs/TRACEABILITY.md).`,
      });
    }
  }

  // ── Output ────────────────────────────────────────────────────────────────
  const scanned = templatePaths.length;
  const markdownCount = collectMarkdownFiles().length;

  if (failures.length === 0) {
    console.log(
      `validate-templates: all checks passed ` +
        `(${scanned} template file${scanned === 1 ? "" : "s"} and ` +
        `${markdownCount} Markdown file${markdownCount === 1 ? "" : "s"} scanned, ` +
        `0 failures) ✓`,
    );
    process.exit(0);
  }

  console.log(
    `validate-templates: ${failures.length} failure${failures.length === 1 ? "" : "s"} ` +
      `found in ${scanned} file${scanned === 1 ? "" : "s"}:\n`,
  );

  for (const f of failures) {
    console.log(`  ${f.location}: ${f.message}`);
  }

  console.log(
    "\nFix the issues above to keep contributor templates accurate and safe.",
  );
  console.log(
    `To suppress a valid nonstandard reference, add a "${SUPPRESSION_MARKER}" ` +
      `HTML comment on the same line or the line above it.`,
  );
  process.exit(1);
}

if (require.main === module) {
  run();
}
