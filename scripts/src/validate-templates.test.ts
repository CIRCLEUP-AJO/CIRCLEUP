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

// ══════════════════════════════════════════════════════════════════════════════
// Package-impact / verification traceability section check
// ══════════════════════════════════════════════════════════════════════════════
//
// The traceability convention (docs/TRACEABILITY.md) asks contributors to add a
// compact "Package impact & verification" section to issues and PRs.  It maps
// each acceptance criterion to the affected packages and the verification
// commands that provide evidence.  The check below is advisory: a missing
// section produces a warning, never a hard failure, so unrelated work is not
// blocked.

const TRACEABILITY_HEADING_RE = /^#{1,6}\s+package impact\s*(?:&|and)\s*verification\b/im;

// Package names that a traceability row may reference.
const TRACEABILITY_PACKAGES = [
  "contracts",
  "sdk",
  "indexer",
  "app",
  "deployment",
];

// The three worked examples the convention must document.
const TRACEABILITY_EXAMPLE_KINDS = [
  "contract event change",
  "indexer schema change",
  "app-only behavior change",
];

interface TraceabilityResult {
  /** True when the section heading is present. */
  hasSection: boolean;
  /** Package names referenced anywhere in the section body. */
  packages: string[];
  /** True when at least one verification command is referenced. */
  hasVerification: boolean;
  /** Advisory warnings; empty means the section looks complete. */
  warnings: string[];
}

function extractTraceabilitySection(content: string): string | null {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => TRACEABILITY_HEADING_RE.test(l));
  if (startIdx === -1) return null;

  const headingLevel = (lines[startIdx].match(/^#+/) ?? ["#"])[0].length;
  const body: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const nextHeading = lines[i].match(/^(#+)\s/);
    if (nextHeading && nextHeading[1].length <= headingLevel) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

function checkTraceabilitySection(content: string): TraceabilityResult {
  const section = extractTraceabilitySection(content);
  if (section === null) {
    return {
      hasSection: false,
      packages: [],
      hasVerification: false,
      warnings: ["missing 'Package impact & verification' section"],
    };
  }

  const lower = section.toLowerCase();
  const packages = TRACEABILITY_PACKAGES.filter((pkg) => lower.includes(pkg));
  const hasVerification = /`[^`]+`/.test(section) || /\b(npm|pnpm|yarn|cargo|make|node)\b/.test(lower);

  const warnings: string[] = [];
  if (packages.length === 0) {
    warnings.push("no affected package named (contracts/sdk/indexer/app/deployment)");
  }
  if (!hasVerification) {
    warnings.push("no verification command referenced");
  }

  return { hasSection: true, packages, hasVerification, warnings };
}

// Advisory gate: returns warnings but never throws / blocks.
function traceabilityGate(content: string): { blocking: boolean; warnings: string[] } {
  const result = checkTraceabilitySection(content);
  return { blocking: false, warnings: result.warnings };
}

const FULL_TRACEABILITY_SECTION = `
## Package impact & verification

| Acceptance criterion | Packages | Verification |
|---|---|---|
| Event is emitted on transfer | contracts, indexer | \`cargo test -p circle\`, \`npm test -w indexer\` |
| UI shows new event | app | \`npm test -w app\` |
`.trim();

describe("checkTraceabilitySection", () => {
  test("template with the section passes with no warnings", () => {
    const result = checkTraceabilitySection(FULL_TRACEABILITY_SECTION);
    assert.equal(result.hasSection, true);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.hasVerification);
  });

  test("template missing the section is flagged", () => {
    const result = checkTraceabilitySection("## Summary\n\nJust a summary.");
    assert.equal(result.hasSection, false);
    assert.ok(result.warnings.some((w) => w.includes("missing")));
  });

  test("section without any package is flagged", () => {
    const content = "## Package impact & verification\n\n| AC | Verification |\n|---|---|\n| x | `npm test` |";
    const result = checkTraceabilitySection(content);
    assert.equal(result.hasSection, true);
    assert.deepEqual(result.packages, []);
    assert.ok(result.warnings.some((w) => w.includes("package")));
  });

  test("section without a verification command is flagged", () => {
    const content = "## Package impact & verification\n\nAffects contracts and indexer.";
    const result = checkTraceabilitySection(content);
    assert.equal(result.hasSection, true);
    assert.ok(result.packages.includes("contracts"));
    assert.ok(result.packages.includes("indexer"));
    assert.equal(result.hasVerification, false);
    assert.ok(result.warnings.some((w) => w.includes("verification")));
  });

  test("heading is matched case-insensitively and with 'and'", () => {
    const content = "## PACKAGE IMPACT AND VERIFICATION\n\ncontracts — `cargo test`";
    const result = checkTraceabilitySection(content);
    assert.equal(result.hasSection, true);
  });

  test("section body stops at the next same-level heading", () => {
    const content = [
      "## Package impact & verification",
      "",
      "contracts — `cargo test`",
      "",
      "## Checklist",
      "",
      "indexer app deployment",
    ].join("\n");
    const result = checkTraceabilitySection(content);
    assert.deepEqual(result.packages, ["contracts"]);
  });
});

describe("traceabilityGate (advisory, non-blocking)", () => {
  test("never blocks even when the section is missing", () => {
    const gate = traceabilityGate("## Summary\n\nNo traceability here.");
    assert.equal(gate.blocking, false);
    assert.ok(gate.warnings.length > 0);
  });

  test("reports no warnings for a complete section", () => {
    const gate = traceabilityGate(FULL_TRACEABILITY_SECTION);
    assert.equal(gate.blocking, false);
    assert.deepEqual(gate.warnings, []);
  });
});

describe("traceability worked examples", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const TRACEABILITY_DOC = path.join(REPO_ROOT, "docs", "TRACEABILITY.md");

  test("docs/TRACEABILITY.md exists", () => {
    assert.ok(
      fs.existsSync(TRACEABILITY_DOC),
      "docs/TRACEABILITY.md must document the convention",
    );
  });

  test("documents all three worked examples", () => {
    if (!fs.existsSync(TRACEABILITY_DOC)) return;
    const lower = fs.readFileSync(TRACEABILITY_DOC, "utf8").toLowerCase();
    for (const kind of TRACEABILITY_EXAMPLE_KINDS) {
      assert.ok(
        lower.includes(kind),
        `TRACEABILITY.md must include the '${kind}' example`,
      );
    }
  });

  test("convention is linked from contribution guidance", () => {
    const contributing = path.join(REPO_ROOT, "CONTRIBUTING.md");
    if (!fs.existsSync(contributing)) return;
    const content = fs.readFileSync(contributing, "utf8");
    assert.ok(
      /TRACEABILITY\.md/.test(content),
      "CONTRIBUTING.md must link to docs/TRACEABILITY.md",
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
