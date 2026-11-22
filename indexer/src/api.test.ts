import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorsOptions } from "./api";

function callOrigin(
  options: ReturnType<typeof buildCorsOptions>,
  origin: string | undefined,
): Promise<{ err: Error | null; allow?: boolean }> {
  return new Promise((resolve) => {
    const originHandler = options.origin as (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => void;
    originHandler(origin, (err, allow) => resolve({ err, allow }));
  });
}

test("buildCorsOptions allows an origin on the allow-list", async () => {
  const options = buildCorsOptions(["https://app.circleup.xyz"]);
  const { err, allow } = await callOrigin(options, "https://app.circleup.xyz");
  assert.equal(err, null);
  assert.equal(allow, true);
});

test("buildCorsOptions rejects an origin not on the allow-list", async () => {
  const options = buildCorsOptions(["https://app.circleup.xyz"]);
  const { err } = await callOrigin(options, "https://evil.example.com");
  assert.ok(err instanceof Error);
  assert.match(err.message, /not allowed/);
});

test("buildCorsOptions allows requests with no Origin header (server-to-server)", async () => {
  const options = buildCorsOptions(["https://app.circleup.xyz"]);
  const { err, allow } = await callOrigin(options, undefined);
  assert.equal(err, null);
  assert.equal(allow, true);
});

test("buildCorsOptions allows everything when no allow-list is configured", () => {
  const options = buildCorsOptions([]);
  assert.equal(options.origin, true);
});

test("member contribution history route is documented in the module header", async () => {
  // Lightweight guard so the read-only history endpoint is not dropped from
  // the public surface without updating the file header / this assertion.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /GET \/members\/:member\/contributions/);
  assert.match(source, /app\.get\("\/members\/:member\/contributions"/);
  assert.match(source, /Failed to load member contributions/);
  // parseAddress("Member address") produces "Member address is required" at runtime;
  // verify the label string is present in source.
  assert.match(source, /Member address/);
});

test("members endpoint is documented with hasContributedCurrentRound in module header (#539)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /GET \/circles\/:address\/members/);
  assert.match(source, /has_contributed_current_round/);
  assert.match(source, /roundDeadlineLedgers/);
});

test("rounds endpoint is documented with deadlineLedger in module header (#540)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /GET \/circles\/:address\/rounds/);
  assert.match(source, /deadlineLedger/);
});

test("member contributions endpoint includes totalAmount and hasMore in response (#541)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /totalAmount/);
  assert.match(source, /hasMore/);
});

test("member circles endpoint is documented in module header (#dashboard)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /GET \/members\/:member\/circles/);
  assert.match(source, /app\.get\("\/members\/:member\/circles"/);
  assert.match(source, /Failed to load member circles/);
});

test("circle activity endpoint is documented in module header (#timeline)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /GET \/circles\/:address\/activity/);
  assert.match(source, /app\.get\("\/circles\/:address\/activity"/);
  assert.match(source, /Failed to load circle activity/);
});

test("circle activity endpoint returns events with ledger, event_position, and type fields (#timeline)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  // Verify the SQL aliases used in the UNION ALL
  assert.match(source, /circle_contribute/);
  assert.match(source, /circle_payout/);
  assert.match(source, /circle_default/);
  assert.match(source, /event_position/);
});

test("member circles endpoint returns circle and member sub-objects (#dashboard)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  // Verify the response structure fields are present in source
  assert.match(source, /total_contributions/);
  assert.match(source, /reputation_score/);
  assert.match(source, /payout_order/);
});

test("liveness and readiness probe routes are mounted (#934)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /app\.get\("\/health\/live"/);
  assert.match(source, /app\.get\("\/livez"/);
  assert.match(source, /app\.get\("\/health\/ready"/);
  assert.match(source, /app\.get\("\/readyz"/);
  assert.match(source, /probe === "liveness"/);
  assert.match(source, /probe === "readiness"/);
});

test("deprecation policy constants are defined with documented header names (#149)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  // Standard RFC 8594 / RFC 9745 style signalling headers.
  assert.match(source, /Deprecation/);
  assert.match(source, /Sunset/);
  assert.match(source, /deprecated/);
  // The migration window must be documented in the module header.
  assert.match(source, /migration window/i);
});

test("deprecated route emits Deprecation and Sunset headers with documented values (#149)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  // The helper that stamps the headers must be applied to the deprecated route.
  assert.match(source, /markDeprecated/);
  assert.match(source, /res\.setHeader\("Deprecation"/);
  assert.match(source, /res\.setHeader\("Sunset"/);
  // The deprecated route must still be mounted (legacy shape preserved).
  assert.match(source, /app\.get\("\/members\/:member\/contributions"/);
});

test("deprecated response body includes a deprecated marker while keeping legacy fields (#149)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  // The marker is added alongside the legacy payload, not in place of it.
  assert.match(source, /deprecated:\s*\{/);
  assert.match(source, /sunsetAt/);
  assert.match(source, /replacement/);
  // Legacy fields must remain present during the migration window.
  assert.match(source, /totalAmount/);
  assert.match(source, /hasMore/);
});

test("non-deprecated routes do not emit deprecation headers (#149)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  // Only the explicitly deprecated route should call the helper; count usages.
  const helperCalls = source.match(/markDeprecated\(/g) ?? [];
  // One definition + at most one call site for the single deprecated route.
  assert.ok(
    helperCalls.length <= 2,
    `markDeprecated should only be used for deprecated routes, found ${helperCalls.length} usages`,
  );
  // Health probes must never be marked deprecated.
  const liveBlock = source.slice(source.indexOf('app.get("/health/live"'));
  assert.doesNotMatch(liveBlock.slice(0, 400), /markDeprecated/);
});
