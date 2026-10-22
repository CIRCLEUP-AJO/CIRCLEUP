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
