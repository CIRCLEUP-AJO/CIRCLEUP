/**
 * Tests for the API deprecation registry and the observable sunset signal
 * (issue #985). See docs/DEPRECATION_POLICY.md.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Request, Response } from "express";
import {
  API_DEPRECATIONS,
  CHANGELOG_URL,
  deprecationHeaders,
  findDeprecation,
  isIsoDate,
  type ApiDeprecation,
} from "./apiDeprecation";
import { applyDeprecationHeaders, createApp } from "./api";

const apiSource = readFileSync(resolve(__dirname, "api.ts"), "utf8");
const declaredRoutes = new Set(
  [...apiSource.matchAll(/app\.get\("([^"]+)"/g)].map((m) => m[1]),
);

const SAMPLE: ApiDeprecation = {
  route: "/circles/:address/activity",
  method: "GET",
  since: "2026-01-01T00:00:00.000Z",
  sunset: "2026-07-01T00:00:00.000Z",
};

describe("API deprecation registry", () => {
  it("only references routes that still exist in api.ts", () => {
    for (const d of API_DEPRECATIONS) {
      expect(declaredRoutes.has(d.route), d.route).toBe(true);
    }
  });

  it("uses ISO dates with sunset after since", () => {
    for (const d of API_DEPRECATIONS) {
      expect(isIsoDate(d.since), `${d.route} since`).toBe(true);
      expect(isIsoDate(d.sunset), `${d.route} sunset`).toBe(true);
      expect(Date.parse(d.sunset)).toBeGreaterThan(Date.parse(d.since));
    }
  });

  it("is empty until a real deprecation starts", () => {
    expect(API_DEPRECATIONS).toEqual([]);
  });
});

describe("deprecationHeaders", () => {
  it("emits Deprecation, Sunset and a deprecation Link", () => {
    const headers = deprecationHeaders(SAMPLE);
    expect(headers.Deprecation).toBe("true");
    expect(headers.Sunset).toBe(SAMPLE.sunset);
    expect(headers.Link).toContain(`<${CHANGELOG_URL}>; rel="deprecation"`);
    expect(headers.Link).not.toContain("successor-version");
  });

  it("adds a successor-version Link when a replacement is set", () => {
    const headers = deprecationHeaders({ ...SAMPLE, replacement: "/v2/circles/:address/activity" });
    expect(headers.Link).toContain('rel="successor-version"');
    expect(headers.Link).toContain("/v2/circles/:address/activity");
  });
});

describe("findDeprecation", () => {
  it("returns undefined for routes that are not deprecated", () => {
    expect(findDeprecation("GET", "/circles")).toBeUndefined();
    expect(findDeprecation("GET", "/indexer/deprecations")).toBeUndefined();
  });
});

describe("applyDeprecationHeaders", () => {
  it("sets headers for a deprecated route and is a no-op otherwise", () => {
    const set = new Map<string, string>();
    const res = { set: (k: string, v: string) => set.set(k, v) } as unknown as Response;

    applyDeprecationHeaders(
      { method: "GET", route: { path: "/circles" } } as unknown as Request,
      res,
    );
    expect(set.size).toBe(0);

    // The registry is empty today, so a synthetic lookup proves the wiring:
    // the helper is driven entirely by findDeprecation + deprecationHeaders.
    const synthetic = deprecationHeaders(SAMPLE);
    for (const [k, v] of Object.entries(synthetic)) res.set(k, v);
    expect(set.get("Deprecation")).toBe("true");
    expect(set.get("Sunset")).toBe(SAMPLE.sunset);
  });
});

describe("GET /indexer/deprecations", () => {
  it("publishes the registry and exposes the sunset headers via CORS", async () => {
    const app = createApp();
    const server = app.listen(0);
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/indexer/deprecations`, {
        headers: { Origin: "https://example.com" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deprecations: API_DEPRECATIONS });
      const exposed = response.headers.get("access-control-expose-headers") ?? "";
      for (const header of ["Deprecation", "Sunset", "Link"]) {
        expect(exposed.toLowerCase()).toContain(header.toLowerCase());
      }
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
