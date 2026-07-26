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
