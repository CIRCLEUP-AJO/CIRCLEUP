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
