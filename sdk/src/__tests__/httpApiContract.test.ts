import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import * as fixtures from "./indexerResponseFixtures";

const root = resolve(__dirname, "../../..");
const doc = JSON.parse(readFileSync(resolve(root, "docs/api/v1/openapi.json"), "utf8"));
// Validate the JSON Schema vocabulary used by this document against real SDK fixtures.
function accepts(schema: any, value: any): boolean {
  if (schema.$ref) return accepts(doc.components.schemas[schema.$ref.split("/").pop()], value);
  if (schema.anyOf) return schema.anyOf.some((s: any) => accepts(s, value));
  if (schema.oneOf) return schema.oneOf.filter((s: any) => accepts(s, value)).length === 1;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "string" && (typeof value !== "string" || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.format === "date-time" && !Number.isFinite(Date.parse(value))))) return false;
  if (schema.type === "integer" && !Number.isSafeInteger(value)) return false;
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (schema.type === "array") return Array.isArray(value) && (schema.maxItems === undefined || value.length <= schema.maxItems) && value.every(v => accepts(schema.items, v));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if ((schema.required || []).some((k: string) => !(k in value))) return false;
    return Object.entries(value).every(([k,v]) => schema.properties?.[k] ? accepts(schema.properties[k],v) : typeof schema.additionalProperties === "object" ? accepts(schema.additionalProperties,v) : schema.additionalProperties !== false);
  }
  return true;
}

describe("published v1 HTTP contract", () => {
  it("covers every Express read route and has no stale route", () => {
    const source = readFileSync(resolve(root, "indexer/src/api.ts"), "utf8");
    const routes = [...source.matchAll(/app\.get\("([^"]+)"/g)].map(m => m[1].replace(/:([a-zA-Z]+)/g, "{$1}")).sort();
    expect(Object.keys(doc.paths).sort()).toEqual(routes);
  });
  it("requires deliberate review when wire sources change", () => {
    for (const [file, digest] of Object.entries(doc["x-source-sha256"])) {
      const normalized = readFileSync(resolve(root, file), "utf8").replace(/\r\n/g, "\n");
      expect(createHash("sha256").update(normalized).digest("hex"), file).toBe(digest);
    }
  });
  it("documents a deprecation status for every published route", () => {
    const policy = doc["x-deprecation-policy"];
    expect(policy, "x-deprecation-policy").toBeTruthy();
    expect(policy.warningWindowDays).toBeGreaterThan(0);
    expect(policy.sunsetHeader).toBe("Sunset");
    expect(policy.deprecationHeader).toBe("Deprecation");
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        expect(["active", "deprecated"], `${method.toUpperCase()} ${path}`).toContain(op["x-deprecation-status"]);
        if (op["x-deprecation-status"] === "deprecated") {
          expect(op.deprecated, `${method.toUpperCase()} ${path} deprecated`).toBe(true);
          expect(Number.isFinite(Date.parse(op["x-sunset"])), `${method.toUpperCase()} ${path} x-sunset`).toBe(true);
        }
      }
    }
  });
  it("marks deprecated fields with deprecated: true and an x-sunset date", () => {
    const walk = (schema: any, where: string) => {
      if (!schema || typeof schema !== "object") return;
      if (schema.deprecated === true) expect(Number.isFinite(Date.parse(schema["x-sunset"])), where).toBe(true);
      if (schema["x-sunset"] !== undefined) expect(schema.deprecated, where).toBe(true);
      for (const [k, v] of Object.entries<any>(schema.properties || {})) walk(v, `${where}.${k}`);
      if (schema.items) walk(schema.items, `${where}[]`);
      for (const key of ["anyOf", "oneOf", "allOf"]) (schema[key] || []).forEach((s: any, i: number) => walk(s, `${where}.${key}[${i}]`));
    };
    for (const [name, schema] of Object.entries<any>(doc.components.schemas)) walk(schema, name);
  });
  it("fails source-hash review when a wire source changes without a deprecation entry", () => {
    const changed = Object.keys(doc["x-source-sha256"])[0];
    const normalized = readFileSync(resolve(root, changed), "utf8").replace(/\r\n/g, "\n");
    const drifted = { ...doc, "x-source-sha256": { ...doc["x-source-sha256"], [changed]: createHash("sha256").update(normalized + "\n").digest("hex") } };
    const review = (d: any) => Object.entries(d["x-source-sha256"]).every(([file, digest]) =>
      createHash("sha256").update(readFileSync(resolve(root, file), "utf8").replace(/\r\n/g, "\n")).digest("hex") === digest);
    expect(review(doc)).toBe(true);
    expect(review(drifted)).toBe(false);
    const hasDeprecationEntry = Object.values<any>(doc.paths).some(item => Object.values<any>(item).some(op => op["x-deprecation-status"] === "deprecated"));
    expect(review(drifted) || hasDeprecationEntry).toBe(false);
  });
  it("accepts representative published SDK endpoint fixtures", () => {
    const cases: Record<string, unknown> = {
      circlesList: fixtures.CIRCLES_LIST_FIXTURE, circleDetail: fixtures.CIRCLE_DETAIL_FIXTURE,
      members: fixtures.MEMBERS_FIXTURE, rounds: fixtures.ROUNDS_FIXTURE,
      memberContributions: fixtures.MEMBER_CONTRIBUTIONS_FIXTURE,
      reputation: fixtures.REPUTATION_FIXTURE, auditEvents: fixtures.AUDIT_EVENTS_FIXTURE,
      health: fixtures.HEALTH_FIXTURE, indexerState: fixtures.INDEXER_STATE_FIXTURE,
    };
    for (const [key, value] of Object.entries(cases)) expect(accepts(doc.components.schemas[key], value), key).toBe(true);
    expect(accepts(doc.components.schemas.reputation, fixtures.REPUTATION_UNKNOWN_MEMBER_FIXTURE)).toBe(true);
  });
  it("detects numeric amount drift, nullability drift, and oversized history", () => {
    const bad = JSON.parse(JSON.stringify(fixtures.MEMBER_CONTRIBUTIONS_FIXTURE));
    bad.contributions[0].amount = 100000000;
    expect(accepts(doc.components.schemas.memberContributions, bad)).toBe(false);
    const history = { circle_address: "C" + "A".repeat(55), events: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0, hasMore: false } };
    expect(accepts(doc.components.schemas.History, history)).toBe(true);
    expect(accepts(doc.components.schemas.Amount, null)).toBe(false);
    expect(accepts(doc.components.schemas.auditEvents, { ...fixtures.AUDIT_EVENTS_FIXTURE, events: Array(101).fill(fixtures.AUDIT_EVENTS_FIXTURE.events[0]) })).toBe(false);
    expect(accepts(doc.components.schemas.Error, {error: "Bad request"})).toBe(true);
    expect(accepts(doc.components.schemas.Error, {error: {message: "Failed", details: null}})).toBe(true);
  });
});
