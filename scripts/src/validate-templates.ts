#!/usr/bin/env ts-node
/**
 * validate-templates.ts — Contributor-template integrity checker
 *
 * Scans every file in `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md`
 * for relative (repo-local) links and verifies that their targets actually exist on
 * disk.  Also asserts that the bug-report template carries the required safety-notice
 * block so contributors know what NOT to include in public issues.
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
 *   - No transitive dependencies beyond Node built-ins + ts-node.
 */

import fs from "fs";
import path from "path";

// ── Paths ─────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GITHUB_DIR = path.join(REPO_ROOT, ".github");

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
  const lines = content.split("\n");
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

  // ── 4. PR template must exist and carry security + traceability sections ──
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

  if (failures.length === 0) {
    console.log(
      `validate-templates: all checks passed ` +
        `(${scanned} file${scanned === 1 ? "" : "s"} scanned, ` +
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
  process.exit(1);
}

run();
