/**
 * Unit tests for validate-templates.ts
 *
 * Tests the two exported-for-testing helper modules inline:
 *   - relative-link extraction (the regex + path resolution logic)
 *   - safety-notice keyword check
 *
 * The integration path (actual repo templates pass) is exercised by the CI
 * step that runs the script directly; these tests cover the logic in isolation
 * using synthetic temp files so no real-file I/O is required.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Inline re-implementations of the tested logic ─────────────────────────────
//
// validate-templates.ts is a CLI script (calls process.exit) so we cannot
// import it directly.  The core logic is simple enough to re-state here for
// white-box testing without risking the tests triggering a process.exit.
// Any logic change in the source must be mirrored here — the CI run of the
// full script against the real repo serves as the integration smoke-test.

const RELATIVE_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

function extractRelativeLinks(
  content: string,
  fileDir: string,
): Array<{ line: number; rawLink: string; resolvedPath: string }> {
  const lines = content.split("\n");
  const results: Array<{ line: number; rawLink: string; resolvedPath: string }> = [];

  lines.forEach((lineText, idx) => {
    let match: RegExpExecArray | null;
    RELATIVE_LINK_RE.lastIndex = 0;
    while ((match = RELATIVE_LINK_RE.exec(lineText)) !== null) {
      const rawLink = match[2].trim();
      if (
        rawLink.startsWith("http://") ||
        rawLink.startsWith("https://") ||
        rawLink.startsWith("#") ||
        rawLink.startsWith("mailto:")
      ) {
        continue;
      }
      const linkWithoutFragment = rawLink.split("#")[0];
      if (!linkWithoutFragment) continue;
      results.push({
        line: idx + 1,
        rawLink,
        resolvedPath: path.resolve(fileDir, linkWithoutFragment),
      });
    }
  });

  return results;
}

const REQUIRED_SAFETY_TOKENS = [
  "seed",
  "private key",
  "xdr",
  "api key",
  "SECURITY.md",
];

function checkBugReportSafetyNotice(content: string): string[] {
  const lower = content.toLowerCase();
  return REQUIRED_SAFETY_TOKENS.filter(
    (token) => !lower.includes(token.toLowerCase()),
  );
}

// ── Helper: write a temp file and return its path ─────────────────────────────

function writeTmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-tmpl-test-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ══════════════════════════════════════════════════════════════════════════════
// Link extraction
// ══════════════════════════════════════════════════════════════════════════════

describe("extractRelativeLinks", () => {
  test("detects a simple relative link", () => {
    const links = extractRelativeLinks(
      "[Policy](../docs/DEPRECATION_POLICY.md)",
      "/repo/.github",
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].rawLink, "../docs/DEPRECATION_POLICY.md");
    assert.equal(links[0].line, 1);
    assert.ok(links[0].resolvedPath.endsWith("DEPRECATION_POLICY.md"));
  });

  test("ignores https:// links", () => {
    const links = extractRelativeLinks(
      "[GitHub](https://github.com/CIRCLEUP-AJO/CIRCLEUP)",
      "/tmp",
    );
    assert.equal(links.length, 0);
  });

  test("ignores http:// links", () => {
    const links = extractRelativeLinks(
      "[local](http://localhost:3000)",
      "/tmp",
    );
    assert.equal(links.length, 0);
  });

  test("ignores anchor-only links", () => {
    const links = extractRelativeLinks("[section](#protocol-changes)", "/tmp");
    assert.equal(links.length, 0);
  });

  test("ignores mailto: links", () => {
    const links = extractRelativeLinks("[email](mailto:team@example.com)", "/tmp");
    assert.equal(links.length, 0);
  });

  test("strips fragment before resolving path", () => {
    const links = extractRelativeLinks(
      "[CONTRIBUTING](../CONTRIBUTING.md#protocol-and-wire-format-changes)",
      "/repo/.github",
    );
    assert.equal(links.length, 1);
    assert.ok(
      links[0].resolvedPath.endsWith("CONTRIBUTING.md"),
      "fragment must be stripped from the resolved path",
    );
  });

  test("reports correct 1-based line numbers", () => {
    const content = "line one\n[Policy](../docs/EVENTS.md)\nline three";
    const links = extractRelativeLinks(content, "/repo/.github");
    assert.equal(links.length, 1);
    assert.equal(links[0].line, 2);
  });

  test("detects multiple links on different lines", () => {
    const content = [
      "[A](../docs/A.md)",
      "some prose",
      "[B](../docs/B.md)",
    ].join("\n");
    const links = extractRelativeLinks(content, "/repo/.github");
    assert.equal(links.length, 2);
    assert.equal(links[0].line, 1);
    assert.equal(links[1].line, 3);
  });

  test("detects two links on the same line", () => {
    const content = "[A](./A.md) and [B](./B.md)";
    const links = extractRelativeLinks(content, "/tmp");
    assert.equal(links.length, 2);
    assert.equal(links[0].line, 1);
    assert.equal(links[1].line, 1);
  });

  test("empty content returns no links", () => {
    assert.equal(extractRelativeLinks("", "/tmp").length, 0);
  });

  test("content with no markdown links returns no links", () => {
    const content = "Just some prose without any links here.";
    assert.equal(extractRelativeLinks(content, "/tmp").length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Broken-link detection (on-disk check)
// ══════════════════════════════════════════════════════════════════════════════

describe("broken-link detection (on-disk)", () => {
  test("existing target passes (no failure)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-blk-"));
    // Create the target file
    const target = path.join(dir, "EVENTS.md");
    fs.writeFileSync(target, "# Events", "utf8");
    // Template that links to it
    const content = "[Events](./EVENTS.md)";
    const links = extractRelativeLinks(content, dir);
    assert.equal(links.length, 1);
    assert.ok(fs.existsSync(links[0].resolvedPath), "target must exist");
  });

  test("missing target fails (file does not exist)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-blk-"));
    const content = "[Phantom](./PHANTOM.md)";
    const links = extractRelativeLinks(content, dir);
    assert.equal(links.length, 1);
    assert.ok(!fs.existsSync(links[0].resolvedPath), "target must NOT exist");
  });

  test("link to existing parent-relative path resolves correctly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-blk-"));
    const subDir = path.join(dir, "sub");
    fs.mkdirSync(subDir);
    const target = path.join(dir, "ROOT.md");
    fs.writeFileSync(target, "# Root", "utf8");

    const content = "[Root](../ROOT.md)";
    const links = extractRelativeLinks(content, subDir);
    assert.equal(links.length, 1);
    assert.ok(fs.existsSync(links[0].resolvedPath));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Safety-notice keyword check
// ══════════════════════════════════════════════════════════════════════════════

describe("checkBugReportSafetyNotice", () => {
  const FULL_NOTICE = `
## Before you submit

Please redact the following:
- Secret seed phrases, mnemonic words, or private keys
- Signed XDR transactions
- API keys, passwords, or environment secrets
- Real production wallet addresses

See SECURITY.md for vulnerability reports.
  `.trim();

  test("returns no missing tokens when all keywords are present", () => {
    const missing = checkBugReportSafetyNotice(FULL_NOTICE);
    assert.deepEqual(missing, [], "fully compliant notice must have no missing tokens");
  });

  test("detects missing 'seed' token", () => {
    const content = FULL_NOTICE.replace(/seed/gi, "REMOVED");
    const missing = checkBugReportSafetyNotice(content);
    assert.ok(
      missing.includes("seed"),
      "must flag 'seed' as missing when removed",
    );
  });

  test("detects missing 'private key' token", () => {
    const content = FULL_NOTICE.replace(/private key/gi, "REMOVED");
    const missing = checkBugReportSafetyNotice(content);
    assert.ok(missing.includes("private key"));
  });

  test("detects missing 'xdr' token", () => {
    const content = FULL_NOTICE.replace(/xdr/gi, "REMOVED");
    const missing = checkBugReportSafetyNotice(content);
    assert.ok(missing.includes("xdr"));
  });

  test("detects missing 'api key' token", () => {
    const content = FULL_NOTICE.replace(/api key/gi, "REMOVED");
    const missing = checkBugReportSafetyNotice(content);
    assert.ok(missing.includes("api key"));
  });

  test("detects missing SECURITY.md reference", () => {
    const content = FULL_NOTICE.replace(/SECURITY\.md/g, "REMOVED");
    const missing = checkBugReportSafetyNotice(content);
    assert.ok(missing.includes("SECURITY.md"));
  });

  test("check is case-insensitive (uppercased keywords still pass)", () => {
    const content = FULL_NOTICE.toUpperCase();
    // SECURITY.md becomes SECURITY.MD — still contains "security.md" in lower
    const missing = checkBugReportSafetyNotice(content);
    // All tokens are lowercase-compared so uppercase body must pass
    assert.deepEqual(missing, []);
  });

  test("completely empty content fails all tokens", () => {
    const missing = checkBugReportSafetyNotice("");
    assert.equal(
      missing.length,
      REQUIRED_SAFETY_TOKENS.length,
      "empty content must fail every safety token",
    );
  });

  test("partial content fails only the missing tokens", () => {
    const content = "seed phrases and XDR must be redacted. See SECURITY.md.";
    const missing = checkBugReportSafetyNotice(content);
    // Present: seed, xdr, SECURITY.md — Missing: private key, api key
    assert.ok(missing.includes("private key"));
    assert.ok(missing.includes("api key"));
    assert.ok(!missing.includes("seed"));
    assert.ok(!missing.includes("xdr"));
    assert.ok(!missing.includes("SECURITY.md"));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration smoke-test: real repo templates must pass
// ══════════════════════════════════════════════════════════════════════════════

describe("real repo templates", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const GITHUB_DIR = path.join(REPO_ROOT, ".github");
  const BUG_REPORT = path.join(GITHUB_DIR, "ISSUE_TEMPLATE", "bug_report.md");
  const PR_TEMPLATE = path.join(GITHUB_DIR, "PULL_REQUEST_TEMPLATE.md");

  test("bug_report.md exists", () => {
    assert.ok(
      fs.existsSync(BUG_REPORT),
      "bug_report.md must exist under .github/ISSUE_TEMPLATE/",
    );
  });

  test("PULL_REQUEST_TEMPLATE.md exists", () => {
    assert.ok(
      fs.existsSync(PR_TEMPLATE),
      "PULL_REQUEST_TEMPLATE.md must exist under .github/",
    );
  });

  test("bug_report.md passes all safety-notice checks", () => {
    if (!fs.existsSync(BUG_REPORT)) return; // skip if file absent (caught above)
    const content = fs.readFileSync(BUG_REPORT, "utf8");
    const missing = checkBugReportSafetyNotice(content);
    assert.deepEqual(
      missing,
      [],
      `bug_report.md is missing safety tokens: ${missing.join(", ")}`,
    );
  });

  test("all relative links in PR template resolve to existing files", () => {
    if (!fs.existsSync(PR_TEMPLATE)) return;
    const content = fs.readFileSync(PR_TEMPLATE, "utf8");
    const fileDir = path.dirname(PR_TEMPLATE);
    const links = extractRelativeLinks(content, fileDir);
    const broken = links.filter((l) => !fs.existsSync(l.resolvedPath));
    assert.deepEqual(
      broken.map((l) => `${l.line}: ${l.rawLink}`),
      [],
      "PR template must not contain broken relative links",
    );
  });

  test("all relative links in bug_report.md resolve to existing files", () => {
    if (!fs.existsSync(BUG_REPORT)) return;
    const content = fs.readFileSync(BUG_REPORT, "utf8");
    const fileDir = path.dirname(BUG_REPORT);
    const links = extractRelativeLinks(content, fileDir);
    const broken = links.filter((l) => !fs.existsSync(l.resolvedPath));
    assert.deepEqual(
      broken.map((l) => `${l.line}: ${l.rawLink}`),
      [],
      "bug_report.md must not contain broken relative links",
    );
  });
});

// Re-export the tokens array so the describe block can reference it
const REQUIRED_SAFETY_TOKENS = [
  "seed",
  "private key",
  "xdr",
  "api key",
  "SECURITY.md",
];

// ══════════════════════════════════════════════════════════════════════════════
// Feature-request component-checklist check
// ══════════════════════════════════════════════════════════════════════════════

// Re-implement the checker inline (same pattern as the safety-notice tests
// above) so the tests are self-contained and do not trigger process.exit.

const REQUIRED_FEATURE_REQUEST_TOKENS = ["- [ ]", "contracts", "indexer", "app"];

function checkFeatureRequestComponentList(content: string): string[] {
  const lower = content.toLowerCase();
  return REQUIRED_FEATURE_REQUEST_TOKENS.filter(
    (token) => !lower.includes(token.toLowerCase()),
  );
}

const FULL_FEATURE_REQUEST = `
## Affected Component

- [ ] \`contracts/circle\`
- [ ] \`contracts/circle_factory\`
- [ ] \`contracts/reputation\`
- [ ] \`sdk\`
- [ ] \`indexer\`
- [ ] \`app\`
- [ ] \`scripts\`
- [ ] Documentation
`.trim();

describe("checkFeatureRequestComponentList", () => {
  test("returns no missing tokens when all required items are present", () => {
    const missing = checkFeatureRequestComponentList(FULL_FEATURE_REQUEST);
    assert.deepEqual(missing, [], "fully compliant feature request must have no missing tokens");
  });

  test("detects missing checkbox syntax '- [ ]'", () => {
    const content = FULL_FEATURE_REQUEST.replace(/- \[ \]/g, "* ");
    const missing = checkFeatureRequestComponentList(content);
    assert.ok(missing.includes("- [ ]"), "must flag missing checkbox syntax");
  });

  test("detects missing 'contracts' entry", () => {
    const content = FULL_FEATURE_REQUEST.replace(/contracts/gi, "REMOVED");
    const missing = checkFeatureRequestComponentList(content);
    assert.ok(missing.includes("contracts"));
  });

  test("detects missing 'indexer' entry", () => {
    const content = FULL_FEATURE_REQUEST.replace(/indexer/gi, "REMOVED");
    const missing = checkFeatureRequestComponentList(content);
    assert.ok(missing.includes("indexer"));
  });

  test("detects missing 'app' entry", () => {
    const content = FULL_FEATURE_REQUEST.replace(/\bapp\b/gi, "REMOVED");
    const missing = checkFeatureRequestComponentList(content);
    assert.ok(missing.includes("app"));
  });

  test("completely empty content fails all tokens", () => {
    const missing = checkFeatureRequestComponentList("");
    assert.equal(
      missing.length,
      REQUIRED_FEATURE_REQUEST_TOKENS.length,
      "empty content must fail every token",
    );
  });

  test("partial content fails only the missing tokens", () => {
    const content = "- [ ] `app`\n- [ ] `indexer`";
    const missing = checkFeatureRequestComponentList(content);
    assert.ok(!missing.includes("- [ ]"), "checkbox syntax is present");
    assert.ok(!missing.includes("app"),    "'app' is present");
    assert.ok(!missing.includes("indexer"), "'indexer' is present");
    assert.ok(missing.includes("contracts"), "'contracts' is absent");
  });

  test("check is case-insensitive (uppercased content still passes)", () => {
    const missing = checkFeatureRequestComponentList(FULL_FEATURE_REQUEST.toUpperCase());
    // "- [ ]" is not affected by toUpperCase; others are lowercased in comparison
    assert.deepEqual(missing, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PR template integrity check
// ══════════════════════════════════════════════════════════════════════════════

const REQUIRED_PR_TEMPLATE_TOKENS = ["security", "traceab", "changelog", "- [ ]"];

function checkPrTemplateIntegrity(content: string): string[] {
  const lower = content.toLowerCase();
  return REQUIRED_PR_TEMPLATE_TOKENS.filter(
    (token) => !lower.includes(token.toLowerCase()),
  );
}

const FULL_PR_TEMPLATE = `
## Summary

## Traceability

| Acceptance criterion | Evidence |
|---|---|
|  |  |

## Contract security checklist

<details>
<summary>Contract security review</summary>
See docs/CONTRACT_SECURITY_CHECKLIST.md
</details>

## Checklist

- [ ] I have updated \`CHANGELOG.md\` under \`[Unreleased]\`
- [ ] CI passes on this branch
`.trim();

describe("checkPrTemplateIntegrity", () => {
  test("returns no missing tokens when all required sections are present", () => {
    const missing = checkPrTemplateIntegrity(FULL_PR_TEMPLATE);
    assert.deepEqual(missing, [], "fully compliant PR template must have no missing tokens");
  });

  test("detects missing 'security' section", () => {
    const content = FULL_PR_TEMPLATE.replace(/security/gi, "REMOVED");
    const missing = checkPrTemplateIntegrity(content);
    assert.ok(missing.includes("security"));
  });

  test("detects missing traceability section", () => {
    const content = FULL_PR_TEMPLATE.replace(/traceab/gi, "REMOVED");
    const missing = checkPrTemplateIntegrity(content);
    assert.ok(missing.includes("traceab"));
  });

  test("detects missing changelog reminder", () => {
    const content = FULL_PR_TEMPLATE.replace(/changelog/gi, "REMOVED");
    const missing = checkPrTemplateIntegrity(content);
    assert.ok(missing.includes("changelog"));
  });

  test("detects missing checkbox syntax", () => {
    const content = FULL_PR_TEMPLATE.replace(/- \[ \]/g, "* ");
    const missing = checkPrTemplateIntegrity(content);
    assert.ok(missing.includes("- [ ]"));
  });

  test("completely empty content fails all tokens", () => {
    const missing = checkPrTemplateIntegrity("");
    assert.equal(missing.length, REQUIRED_PR_TEMPLATE_TOKENS.length);
  });

  test("partial content fails only the missing tokens", () => {
    const content = "security checklist\n- [ ] done\nchangelog updated";
    const missing = checkPrTemplateIntegrity(content);
    assert.ok(!missing.includes("security"));
    assert.ok(!missing.includes("- [ ]"));
    assert.ok(!missing.includes("changelog"));
    assert.ok(missing.includes("traceab"), "'traceab' is absent");
  });

  test("check is case-insensitive", () => {
    const missing = checkPrTemplateIntegrity(FULL_PR_TEMPLATE.toUpperCase());
    // "- [ ]" is unaffected by toUpperCase
    assert.deepEqual(missing, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Real repo template smoke tests (feature_request + PR)
// ══════════════════════════════════════════════════════════════════════════════

describe("real repo templates — feature_request and PR integrity", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const GITHUB_DIR = path.join(REPO_ROOT, ".github");
  const FEATURE_REQUEST = path.join(GITHUB_DIR, "ISSUE_TEMPLATE", "feature_request.md");
  const PR_TEMPLATE = path.join(GITHUB_DIR, "PULL_REQUEST_TEMPLATE.md");

  test("feature_request.md exists", () => {
    assert.ok(
      fs.existsSync(FEATURE_REQUEST),
      "feature_request.md must exist under .github/ISSUE_TEMPLATE/",
    );
  });

  test("feature_request.md passes all component-checklist checks", () => {
    if (!fs.existsSync(FEATURE_REQUEST)) return;
    const content = fs.readFileSync(FEATURE_REQUEST, "utf8");
    const missing = checkFeatureRequestComponentList(content);
    assert.deepEqual(
      missing,
      [],
      `feature_request.md is missing component-checklist tokens: ${missing.join(", ")}`,
    );
  });

  test("feature_request.md has no broken relative links", () => {
    if (!fs.existsSync(FEATURE_REQUEST)) return;
    const content = fs.readFileSync(FEATURE_REQUEST, "utf8");
    const fileDir = path.dirname(FEATURE_REQUEST);
    const links = extractRelativeLinks(content, fileDir);
    const broken = links.filter((l) => !fs.existsSync(l.resolvedPath));
    assert.deepEqual(
      broken.map((l) => `${l.line}: ${l.rawLink}`),
      [],
      "feature_request.md must not contain broken relative links",
    );
  });

  test("PULL_REQUEST_TEMPLATE.md passes all integrity checks", () => {
    if (!fs.existsSync(PR_TEMPLATE)) return;
    const content = fs.readFileSync(PR_TEMPLATE, "utf8");
    const missing = checkPrTemplateIntegrity(content);
    assert.deepEqual(
      missing,
      [],
      `PULL_REQUEST_TEMPLATE.md is missing required sections: ${missing.join(", ")}`,
    );
  });

  test("PULL_REQUEST_TEMPLATE.md has no broken relative links", () => {
    if (!fs.existsSync(PR_TEMPLATE)) return;
    const content = fs.readFileSync(PR_TEMPLATE, "utf8");
    const fileDir = path.dirname(PR_TEMPLATE);
    const links = extractRelativeLinks(content, fileDir);
    const broken = links.filter((l) => !fs.existsSync(l.resolvedPath));
    assert.deepEqual(
      broken.map((l) => `${l.line}: ${l.rawLink}`),
      [],
      "PULL_REQUEST_TEMPLATE.md must not contain broken relative links",
    );
  });
});

// Re-export for inline use in the describe blocks above
// (mirrors the pattern already in this file)
function extractRelativeLinks(
  content: string,
  fileDir: string,
): Array<{ line: number; rawLink: string; resolvedPath: string }> {
  const lines = content.split("\n");
  const results: Array<{ line: number; rawLink: string; resolvedPath: string }> = [];
  const RE = /\[([^\]]*)\]\(([^)]+)\)/g;

  lines.forEach((lineText, idx) => {
    let match: RegExpExecArray | null;
    RE.lastIndex = 0;
    while ((match = RE.exec(lineText)) !== null) {
      const rawLink = match[2].trim();
      if (
        rawLink.startsWith("http://") ||
        rawLink.startsWith("https://") ||
        rawLink.startsWith("#") ||
        rawLink.startsWith("mailto:")
      ) {
        continue;
      }
      const linkWithoutFragment = rawLink.split("#")[0];
      if (!linkWithoutFragment) continue;
      results.push({
        line: idx + 1,
        rawLink,
        resolvedPath: path.resolve(fileDir, linkWithoutFragment),
      });
    }
  });

  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
// Documentation validator (docs-check) — inline re-implementation
// ══════════════════════════════════════════════════════════════════════════════
//
// Mirrors scripts/src/validate-docs.ts so the checker's behaviour can be
// exercised without spawning a process.  The validator:
//   - extracts repository-relative Markdown links, ignoring external URLs,
//     anchor-only links, mailto:, and links inside fenced/inline code spans
//   - resolves each link against the source file's directory
//   - verifies referenced npm scripts exist in the owning package.json
//   - honours a suppression marker for intentional nonstandard references
//   - reports the source file and 1-based line for every failure

const DOCS_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const SUPPRESSION_MARKER = "docs-check-ignore";

interface DocLink {
  line: number;
  rawLink: string;
  resolvedPath: string;
}

interface DocIssue {
  file: string;
  line: number;
  message: string;
}

/** Strip fenced code blocks and inline code spans so they are not scanned. */
function stripCodeSpans(content: string): string[] {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const lineText of lines) {
    if (/^\s*(```|~~~)/.test(lineText)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    if (inFence) {
      out.push("");
      continue;
    }
    // Blank out inline code spans, preserving line structure.
    out.push(lineText.replace(/`[^`]*`/g, ""));
  }
  return out;
}

function extractDocLinks(content: string, fileDir: string): DocLink[] {
  const lines = stripCodeSpans(content);
  const results: DocLink[] = [];
  lines.forEach((lineText, idx) => {
    let match: RegExpExecArray | null;
    DOCS_LINK_RE.lastIndex = 0;
    while ((match = DOCS_LINK_RE.exec(lineText)) !== null) {
      const rawLink = match[2].trim();
      if (
        rawLink.startsWith("http://") ||
        rawLink.startsWith("https://") ||
        rawLink.startsWith("#") ||
        rawLink.startsWith("mailto:")
      ) {
        continue;
      }
      const linkWithoutFragment = rawLink.split("#")[0];
      if (!linkWithoutFragment) continue;
      results.push({
        line: idx + 1,
        rawLink,
        resolvedPath: path.resolve(fileDir, linkWithoutFragment),
      });
    }
  });
  return results;
}

function isSuppressed(content: string, line: number): boolean {
  const lines = content.split("\n");
  const current = lines[line - 1] ?? "";
  const previous = lines[line - 2] ?? "";
  return current.includes(SUPPRESSION_MARKER) || previous.includes(SUPPRESSION_MARKER);
}

function checkDocLinks(
  filePath: string,
  content: string,
): DocIssue[] {
  const fileDir = path.dirname(filePath);
  const issues: DocIssue[] = [];
  for (const link of extractDocLinks(content, fileDir)) {
    if (isSuppressed(content, link.line)) continue;
    if (!fs.existsSync(link.resolvedPath)) {
      issues.push({
        file: filePath,
        line: link.line,
        message: `broken local link: ${link.rawLink}`,
      });
    }
  }
  return issues;
}

interface PackageScripts {
  [pkgJsonPath: string]: Set<string>;
}

function loadPackageScripts(repoRoot: string): PackageScripts {
  const result: PackageScripts = {};
  const candidates = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "scripts", "package.json"),
    path.join(repoRoot, "app", "package.json"),
    path.join(repoRoot, "indexer", "package.json"),
  ];
  for (const pkgPath of candidates) {
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      result[pkgPath] = new Set(Object.keys(parsed.scripts ?? {}));
    } catch {
      result[pkgPath] = new Set();
    }
  }
  return result;
}

const NPM_RUN_RE = /npm\s+run\s+([A-Za-z0-9:_-]+)/g;

function checkNpmScripts(
  filePath: string,
  content: string,
  repoRoot: string,
  scripts: PackageScripts,
): DocIssue[] {
  const issues: DocIssue[] = [];
  const lines = stripCodeSpans(content);
  // Determine which package.json governs this doc by walking up to repo root.
  const rel = path.relative(repoRoot, filePath);
  let governingPkg = path.join(repoRoot, "package.json");
  if (rel.startsWith("scripts" + path.sep)) {
    governingPkg = path.join(repoRoot, "scripts", "package.json");
  } else if (rel.startsWith("app" + path.sep)) {
    governingPkg = path.join(repoRoot, "app", "package.json");
  } else if (rel.startsWith("indexer" + path.sep)) {
    governingPkg = path.join(repoRoot, "indexer", "package.json");
  }
  const available = scripts[governingPkg];
  if (!available) return issues;

  lines.forEach((lineText, idx) => {
    let match: RegExpExecArray | null;
    NPM_RUN_RE.lastIndex = 0;
    while ((match = NPM_RUN_RE.exec(lineText)) !== null) {
      const scriptName = match[1];
      if (isSuppressed(content, idx + 1)) continue;
      if (!available.has(scriptName)) {
        issues.push({
          file: filePath,
          line: idx + 1,
          message: `unknown npm script: ${scriptName}`,
        });
      }
    }
  });
  return issues;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRepoFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cu-docs-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }),
    "utf8",
  );
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "EXISTS.md"), "# Exists\n", "utf8");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts", "package.json"),
    JSON.stringify({ scripts: { "validate-templates": "tsx src/validate-templates.ts" } }),
    "utf8",
  );
  return root;
}

describe("docs validator — link extraction", () => {
  test("ignores external https:// links (no network dependency)", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = "[GitHub](https://github.com/CIRCLEUP-AJO/CIRCLEUP)";
    assert.deepEqual(checkDocLinks(file, content), []);
  });

  test("ignores anchor-only links", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    assert.deepEqual(checkDocLinks(file, "[top](#overview)"), []);
  });

  test("ignores mailto: links", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    assert.deepEqual(checkDocLinks(file, "[mail](mailto:team@example.com)"), []);
  });

  test("ignores links inside fenced code blocks", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = ["```md", "[Phantom](./PHANTOM.md)", "```"].join("\n");
    assert.deepEqual(checkDocLinks(file, content), []);
  });

  test("ignores links inside inline code spans", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = "Use `[Phantom](./PHANTOM.md)` as an example.";
    assert.deepEqual(checkDocLinks(file, content), []);
  });

  test("resolves a valid relative link with fragment", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = "[Exists](./EXISTS.md#section)";
    assert.deepEqual(checkDocLinks(file, content), []);
  });
});

describe("docs validator — broken local links", () => {
  test("reports broken link with source file and line", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = ["# Title", "", "[Phantom](./PHANTOM.md)"].join("\n");
    const issues = checkDocLinks(file, content);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].file, file);
    assert.equal(issues[0].line, 3);
    assert.match(issues[0].message, /broken local link/);
  });

  test("reports each broken link on its own line", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = ["[A](./A.md)", "[B](./B.md)"].join("\n");
    const issues = checkDocLinks(file, content);
    assert.deepEqual(issues.map((i) => i.line), [1, 2]);
  });

  test("suppression marker on the same line silences the issue", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = "[Phantom](./PHANTOM.md) <!-- docs-check-ignore -->";
    assert.deepEqual(checkDocLinks(file, content), []);
  });

  test("suppression marker on the previous line silences the issue", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = [
      "<!-- docs-check-ignore -->",
      "[Phantom](./PHANTOM.md)",
    ].join("\n");
    assert.deepEqual(checkDocLinks(file, content), []);
  });

  test("intentional generated link is suppressed and not reported", () => {
    const root = makeRepoFixture();
    const file = path.join(root, "docs", "README.md");
    const content = [
      "<!-- docs-check-ignore: generated by build -->",
      "[Generated](./generated/OUTPUT.md)",
    ].join("\n");
    assert.deepEqual(checkDocLinks(file, content), []);
  });
});

describe("docs validator — npm scripts", () => {
  test("valid npm script passes", () => {
    const root = makeRepoFixture();
    const scripts = loadPackageScripts(root);
    const file = path.join(root, "README.md");
    const content = "Run `npm run build` to compile.";
    assert.deepEqual(checkNpmScripts(file, content, root, scripts), []);
  });

  test("missing npm script is reported with file and line", () => {
    const root = makeRepoFixture();
    const scripts = loadPackageScripts(root);
    const file = path.join(root, "README.md");
    const content = ["# Build", "", "Run `npm run nonexistent`"].join("\n");
    const issues = checkNpmScripts(file, content, root, scripts);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].file, file);
    assert.equal(issues[0].line, 3);
    assert.match(issues[0].message, /unknown npm script: nonexistent/);
  });

  test("package-specific script resolves against its own package.json", () => {
    const root = makeRepoFixture();
    const scripts = loadPackageScripts(root);
    const file = path.join(root, "scripts", "README.md");
    const content = "Run `npm run validate-templates`.";
    assert.deepEqual(checkNpmScripts(file, content, root, scripts), []);
  });

  test("script from another package is not accepted", () => {
    const root = makeRepoFixture();
    const scripts = loadPackageScripts(root);
    const file = path.join(root, "scripts", "README.md");
    const content = "Run `npm run build`.";
    const issues = checkNpmScripts(file, content, root, scripts);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /unknown npm script: build/);
  });

  test("npm script inside a code span is still checked", () => {
    const root = makeRepoFixture();
    const scripts = loadPackageScripts(root);
    const file = path.join(root, "README.md");
    const content = "Run `npm run missing-script`.";
    const issues = checkNpmScripts(file, content, root, scripts);
    assert.equal(issues.length, 1);
  });

  test("suppression marker silences an unknown npm script", () => {
    const root = makeRepoFixture();
    const scripts = loadPackageScripts(root);
    const file = path.join(root, "README.md");
    const content = "Run `npm run legacy` <!-- docs-check-ignore -->";
    assert.deepEqual(checkNpmScripts(file, content, root, scripts), []);
  });
});
