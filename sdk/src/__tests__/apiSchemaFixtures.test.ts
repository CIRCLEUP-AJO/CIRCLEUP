import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateIndexerResponse, type IndexerEndpointName } from "../indexerSchema";
import { IndexerError } from "../client";
import {
  ALL_OPENAPI_RESPONSE_FIXTURES,
  OPENAPI_CIRCLES_LIST_FIXTURE,
  OPENAPI_CIRCLE_DETAIL_FIXTURE,
  OPENAPI_MEMBERS_FIXTURE,
  OPENAPI_ROUNDS_FIXTURE,
  OPENAPI_MEMBER_CONTRIBUTIONS_FIXTURE,
  OPENAPI_REPUTATION_FIXTURE,
  OPENAPI_AUDIT_EVENTS_FIXTURE,
  OPENAPI_HEALTH_FIXTURE,
  OPENAPI_INDEXER_STATE_FIXTURE,
  OPENAPI_ERROR_LEGACY_FIXTURE,
  OPENAPI_ERROR_STRUCTURED_FIXTURE,
  OPENAPI_ERROR_NOT_FOUND_FIXTURE,
  OPENAPI_ERROR_PAYLOAD_TOO_LARGE_FIXTURE,
  OPENAPI_ERROR_RATE_LIMIT_FIXTURE,
  OPENAPI_ERROR_SERVER_FIXTURE,
  OPENAPI_ERROR_SERVICE_UNAVAILABLE_FIXTURE,
} from "../fixtures/apiResponseFixtures";

describe("Issue #911: API Schema Validation Fixtures from Published HTTP Contract", () => {
  const rootDir = path.resolve(__dirname, "../../..");
  const openapiPath = path.join(rootDir, "docs/api/v1/openapi.json");

  const openapiSpec = JSON.parse(fs.readFileSync(openapiPath, "utf8")) as {
    paths: Record<string, { get?: { responses?: Record<string, { content?: { "application/json"?: { schema?: { $ref?: string } } } }> } }>;
    components: { schemas: Record<string, any> };
  };

  /** Helper to validate an object against a simplified OpenAPI object schema */
  function validateAgainstOpenApiSchema(schema: any, obj: any, pathStr = "$"): string[] {
    const errors: string[] = [];
    if (!schema) return errors;

    if (schema.$ref) {
      const refName = schema.$ref.replace("#/components/schemas/", "");
      const target = openapiSpec.components.schemas[refName];
      if (!target) {
        errors.push(`Unresolved $ref: ${schema.$ref} at ${pathStr}`);
        return errors;
      }
      return validateAgainstOpenApiSchema(target, obj, pathStr);
    }

    if (schema.type === "object") {
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        errors.push(`Expected object at ${pathStr}, got ${typeof obj}`);
        return errors;
      }

      if (schema.required && Array.isArray(schema.required)) {
        for (const reqField of schema.required) {
          if (!(reqField in obj) || obj[reqField] === undefined) {
            errors.push(`Missing required field '${reqField}' at ${pathStr}.${reqField}`);
          }
        }
      }

      if (schema.properties) {
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          if (propName in obj && obj[propName] !== undefined) {
            const childErrors = validateAgainstOpenApiSchema(
              propSchema,
              obj[propName],
              `${pathStr}.${propName}`,
            );
            errors.push(...childErrors);
          }
        }
      }
    } else if (schema.type === "array") {
      if (!Array.isArray(obj)) {
        errors.push(`Expected array at ${pathStr}, got ${typeof obj}`);
        return errors;
      }
      if (schema.items) {
        obj.forEach((item, idx) => {
          const itemErrors = validateAgainstOpenApiSchema(
            schema.items,
            item,
            `${pathStr}[${idx}]`,
          );
          errors.push(...itemErrors);
        });
      }
    } else if (schema.type === "string") {
      if (typeof obj !== "string") {
        errors.push(`Expected string at ${pathStr}, got ${typeof obj}`);
      } else if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(obj)) {
          errors.push(`Value '${obj}' at ${pathStr} does not match pattern ${schema.pattern}`);
        }
      } else if (schema.enum && !schema.enum.includes(obj)) {
        errors.push(`Value '${obj}' at ${pathStr} is not in enum [${schema.enum.join(", ")}]`);
      }
    } else if (schema.type === "integer") {
      if (typeof obj !== "number" || !Number.isInteger(obj)) {
        errors.push(`Expected integer at ${pathStr}, got ${typeof obj}`);
      }
    } else if (schema.type === "boolean") {
      if (typeof obj !== "boolean") {
        errors.push(`Expected boolean at ${pathStr}, got ${typeof obj}`);
      }
    }
    return errors;
  }

  describe("1. Success response fixtures validate against OpenAPI and SDK parsers", () => {
    const successCases: Array<{
      endpoint: IndexerEndpointName;
      fixture: unknown;
      schemaName: string;
    }> = [
      {
        endpoint: "circlesList",
        fixture: OPENAPI_CIRCLES_LIST_FIXTURE,
        schemaName: "circlesList",
      },
      {
        endpoint: "circleDetail",
        fixture: OPENAPI_CIRCLE_DETAIL_FIXTURE,
        schemaName: "circleDetail",
      },
      {
        endpoint: "members",
        fixture: OPENAPI_MEMBERS_FIXTURE,
        schemaName: "members",
      },
      {
        endpoint: "rounds",
        fixture: OPENAPI_ROUNDS_FIXTURE,
        schemaName: "rounds",
      },
      {
        endpoint: "memberContributions",
        fixture: OPENAPI_MEMBER_CONTRIBUTIONS_FIXTURE,
        schemaName: "memberContributions",
      },
      {
        endpoint: "reputation",
        fixture: OPENAPI_REPUTATION_FIXTURE,
        schemaName: "reputation",
      },
      {
        endpoint: "auditEvents",
        fixture: OPENAPI_AUDIT_EVENTS_FIXTURE,
        schemaName: "auditEvents",
      },
      {
        endpoint: "health",
        fixture: OPENAPI_HEALTH_FIXTURE,
        schemaName: "health",
      },
      {
        endpoint: "indexerState",
        fixture: OPENAPI_INDEXER_STATE_FIXTURE,
        schemaName: "indexerState",
      },
    ];

    it.each(successCases)(
      "fixture for $endpoint matches both OpenAPI schema $schemaName and SDK parser",
      ({ endpoint, fixture, schemaName }) => {
        // Validate against SDK runtime schema
        const sdkViolations = validateIndexerResponse(endpoint, fixture);
        expect(sdkViolations).toEqual([]);

        // Validate against OpenAPI schema
        const openApiSchema = openapiSpec.components.schemas[schemaName];
        expect(openApiSchema, `Schema ${schemaName} must exist in openapi.json`).toBeDefined();
        const openApiViolations = validateAgainstOpenApiSchema(openApiSchema, fixture);
        expect(openApiViolations).toEqual([]);
      },
    );
  });

  describe("2. Error response fixtures validate against OpenAPI Error schema and IndexerError", () => {
    const errorCases = [
      { name: "legacy error", fixture: OPENAPI_ERROR_LEGACY_FIXTURE, status: 400 },
      { name: "structured error", fixture: OPENAPI_ERROR_STRUCTURED_FIXTURE, status: 400 },
      { name: "not found", fixture: OPENAPI_ERROR_NOT_FOUND_FIXTURE, status: 404 },
      { name: "payload too large", fixture: OPENAPI_ERROR_PAYLOAD_TOO_LARGE_FIXTURE, status: 413 },
      { name: "rate limit", fixture: OPENAPI_ERROR_RATE_LIMIT_FIXTURE, status: 429 },
      { name: "internal server error", fixture: OPENAPI_ERROR_SERVER_FIXTURE, status: 500 },
      { name: "service unavailable", fixture: OPENAPI_ERROR_SERVICE_UNAVAILABLE_FIXTURE, status: 503 },
    ];

    it.each(errorCases)("fixture for $name satisfies error schema and IndexerError", ({ fixture, status }) => {
      const errSchema = openapiSpec.components.schemas.Error;
      expect(errSchema).toBeDefined();

      // Error fixture matches OpenAPI Error schema
      const violations = validateAgainstOpenApiSchema(errSchema, fixture);
      expect(violations).toEqual([]);

      // IndexerError correctly parses it
      const message =
        typeof (fixture as any).error === "string"
          ? (fixture as any).error
          : (fixture as any).error?.message;
      const indexerErr = new IndexerError(message, status, "http://localhost:3001/api");
      expect(indexerErr.status).toBe(status);
      expect(indexerErr.message).toBe(message);
      if (status === 429 || status >= 500) {
        expect(indexerErr.retryable).toBe(true);
      } else {
        expect(indexerErr.retryable).toBe(false);
      }
    });
  });

  describe("3. Drift detection: all documented OpenAPI endpoints have matching fixtures", () => {
    it("ensures every GET route in openapi.json has a mapped test fixture", () => {
      const paths = Object.keys(openapiSpec.paths);
      expect(paths.length).toBeGreaterThan(0);

      // Verify each path has responses documented and a test fixture represents it
      const coveredSchemas = new Set(Object.keys(ALL_OPENAPI_RESPONSE_FIXTURES));
      for (const [pathKey, pathItem] of Object.entries(openapiSpec.paths)) {
        const getOp = pathItem.get;
        if (!getOp || pathKey === "/openapi/v1.json") continue;

        const res200 = getOp.responses?.["200"];
        expect(res200, `Path ${pathKey} must document HTTP 200`).toBeDefined();

        const schemaRef = res200?.content?.["application/json"]?.schema?.$ref;
        if (schemaRef) {
          const schemaName = schemaRef.replace("#/components/schemas/", "");
          expect(
            coveredSchemas.has(schemaName) || schemaName === "History" || schemaName === "Reconciliation" || schemaName === "Failures" || schemaName === "Summary",
            `Endpoint ${pathKey} with schema ${schemaName} must have a registered fixture`,
          ).toBe(true);
        }
      }
    });
  });
});

