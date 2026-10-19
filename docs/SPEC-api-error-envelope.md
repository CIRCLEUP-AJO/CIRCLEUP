# API Error Envelope Specification

## Problem Statement

Clients need stable error codes for validation, missing records, rate limits, and server errors. Operators need request identifiers for debugging without exposing SQL errors or stack traces to external clients.

## Goals

1. Add a common error envelope with safe code, message, and correlation ID
2. Preserve HTTP semantic status codes
3. Keep internal diagnostics (SQL, stack traces) private
4. Ensure all API errors use documented codes

## Implementation

### 2.1 Error Code Registry

Create `indexer/src/api/errors.ts`:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────
// Public-facing error codes that clients can programmatically handle.
// These codes are stable and versioned; never reuse a retired code.

export const ErrorCodes = {
  // 4xx Client Errors
  VALIDATION_ERROR: "VALIDATION_ERROR",      // Invalid query params, malformed request
  NOT_FOUND: "NOT_FOUND",                      // Resource does not exist
  RATE_LIMITED: "RATE_LIMITED",                // Too many requests
  
  // 5xx Server Errors
  INTERNAL_ERROR: "INTERNAL_ERROR",            // Unexpected server failure
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",  // Database or dependency unavailable
  
  // Edge cases
  BAD_GATEWAY: "BAD_GATEWAY",                  // Upstream RPC failed
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Status Mapping
// ─────────────────────────────────────────────────────────────────────────────

const HttpStatusMap: Record<ErrorCode, number> = {
  [ErrorCodes.VALIDATION_ERROR]: 400,
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.RATE_LIMITED]: 429,
  [ErrorCodes.INTERNAL_ERROR]: 500,
  [ErrorCodes.SERVICE_UNAVAILABLE]: 503,
  [ErrorCodes.BAD_GATEWAY]: 502,
};

// ─────────────────────────────────────────────────────────────────────────────
// Error Envelope
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiError {
  /** Stable error code for programmatic handling */
  code: ErrorCode;
  /** Human-readable message safe for external clients */
  message: string;
  /** Correlation ID for log correlation - NOT exposed to clients by default */
  correlationId?: string;
  /** Additional context - only included in development */
  details?: unknown;
}

/**
 * Creates an error response envelope with sanitized content.
 * 
 * @param code - Stable error code
 * * @param message - Public-safe message
 * @param options.correlationId - Internal correlation ID for logging
 * @param options.includeDetails - Whether to include internal details (dev only)
 */
export function createError(
  code: ErrorCode,
  message: string,
  options: { 
    correlationId?: string;
    includeDetails?: unknown;
    statusCode?: number;
  } = {}
): { status: number; body: ApiError } {
  const status = options.statusCode ?? HttpStatusMap[code] ?? 500;
  
  const envelope: ApiError = {
    code,
    message,
  };
  
  // Never expose internal details in production
  if (process.env.NODE_ENV !== "production" && options.includeDetails) {
    envelope.details = options.includeDetails;
  }
  
  // Correlation ID is internal only - not returned to clients
  // It's logged server-side and returned in response headers
  return { status, body: envelope };
}
```

### 2.2 Correlation ID Middleware

Create `indexer/src/api/middleware.ts`:

```typescript
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

// Correlation ID header name (lowercase for header consistency)
const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Middleware that:
 * 1. Extracts existing correlation ID from request header, or generates new one
 * 2. Attaches it to the request for handlers to use
 * 3. Adds it to response headers for client/log correlation
 * 4. Does NOT expose it in the response body (security)
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  // Use existing correlation ID from header, or generate new one
  const correlationId = req.headers[CORRELATION_ID_HEADER] as string | undefined
    ?? randomUUID();
  
  // Attach to request for handlers
  (req as any).correlationId = correlationId;
  
  // Add to response headers (client can pass this back for debugging)
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  
  next();
}

/**
 * Get correlation ID from request, throwing if not set
 */
export function getCorrelationId(req: Request): string {
  const id = (req as any).correlationId;
  if (!id) {
    throw new Error("Correlation ID middleware not applied");
  }
  return id;
}
```

### 2.3 Error Handler Middleware

Update the global error handler in `api.ts`:

```typescript
import { createError, ErrorCodes } from "./api/errors";
import { getCorrelationId } from "./api/middleware";

// ─────────────────────────────────────────────────────────────────────────────
// Updated Error Handler
// ─────────────────────────────────────────────────────────────────────────────

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const correlationId = getCorrelationId(req);
  
  // Log full error internally
  logApiRequestError({
    method: req.method,
    path: req.originalUrl || req.url,
    statusCode: 500,
    error: err instanceof Error ? err.message : String(err),
    correlationId,
  });
  
  // Determine error type and create appropriate response
  let errorResponse: ReturnType<typeof createError>;
  
  if (err instanceof SyntaxError) {
    // JSON parse error - malformed request body
    errorResponse = createError(
      ErrorCodes.VALIDATION_ERROR,
      "Malformed JSON in request body",
      { correlationId }
    );
  } else if (err instanceof ZodError) {
    // Validation error - query params or body failed schema
    const messages = err.issues.map(i => `${i.path.join(".")}: ${i.message}`);
    errorResponse = createError(
      ErrorCodes.VALIDATION_ERROR,
      messages.join("; "),
      { correlationId }
    );
  } else if (err instanceof PoolTimeoutError) {
    // Database pool exhausted
    errorResponse = createError(
      ErrorCodes.SERVICE_UNAVAILABLE,
      "Service temporarily unavailable",
      { 
        correlationId,
        statusCode: 503,
      }
    );
  } else if (err instanceof QueryCanceledError) {
    // Query timeout - return timeout error, NOT empty data
    errorResponse = createError(
      ErrorCodes.INTERNAL_ERROR,
      "Request timed out",
      { 
        correlationId,
        statusCode: 503,
      }
    );
  } else {
    // Unknown internal error - sanitized message only
    // Never expose stack traces or SQL errors to clients
    errorResponse = createError(
      ErrorCodes.INTERNAL_ERROR,
      "An unexpected error occurred",
      { 
        correlationId,
        includeDetails: process.env.NODE_ENV !== "production" ? String(err) : undefined,
      }
    );
  }
  
  // Log detailed error server-side for debugging
  console.error(`[api] Error ${correlationId}:`, err);
  
  res.status(errorResponse.status).json(errorResponse.body);
});
```

### 2.4 Typed Error Responses

Update specific route handlers to use the error envelope:

```typescript
import { createError, ErrorCodes } from "./api/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Updated Route Errors
// ─────────────────────────────────────────────────────────────────────────────

// Validation error in query params
app.get("/circles", listRateLimiter, async (req: Request, res: Response) => {
  const pageResult = parsePage(req.query.page);
  // ...
  
  if (errors.length > 0) {
    const { status, body } = createError(
      ErrorCodes.VALIDATION_ERROR,
      errors.join("; "),
      { correlationId: getCorrelationId(req) }
    );
    res.status(status).json(body);
    return;
  }
});

// Not found error
app.get("/circles/:address", detailRateLimiter, async (req: Request, res: Response) => {
  const addressResult = parseAddress(req.params.address, "Circle address");
  if (isParseError(addressResult)) {
    const { status, body } = createError(
      ErrorCodes.VALIDATION_ERROR,
      addressResult.error,
      { correlationId: getCorrelationId(req) }
    );
    res.status(status).json(body);
    return;
  }
  
  const circle = await queryOne<CircleRow>(/* ... */);
  if (!circle) {
    const { status, body } = createError(
      ErrorCodes.NOT_FOUND,
      `Circle '${addressResult}' not found`,
      { 
        correlationId: getCorrelationId(req),
        includeDetails: "Circle may not exist on-chain or indexer not yet processed",
      }
    );
    res.status(status).json(body);
    return;
  }
});

// Rate limit error - handled by express-rate-limit but ensure envelope
const rateLimiter = rateLimit({
  // ... existing config
  message: JSON.stringify(
    createError(
      ErrorCodes.RATE_LIMITED,
      "Too many requests, please try again later",
      { correlationId: "rate-limit-" + Date.now() }
    ).body
  ),
});
```

### 2.5 Test Coverage

Create `indexer/src/api.errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createError, ErrorCodes } from "./errors";
import { correlationIdMiddleware, getCorrelationId } from "./middleware";

describe("Error envelope", () => {
  it("creates VALIDATION_ERROR with correct status", () => {
    const result = createError(
      ErrorCodes.VALIDATION_ERROR,
      "Invalid page parameter"
    );
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("VALIDATION_ERROR");
    expect(result.body.message).toBe("Invalid page parameter");
  });

  it("creates NOT_FOUND with correct status", () => {
    const result = createError(
      ErrorCodes.NOT_FOUND,
      "Circle not found"
    );
    expect(result.status).toBe(404);
    expect(result.body.code).toBe("NOT_FOUND");
  });

  it("creates RATE_LIMITED with correct status", () => {
    const result = createError(
      ErrorCodes.RATE_LIMITED,
      "Too many requests"
    );
    expect(result.status).toBe(429);
    expect(result.body.code).toBe("RATE_LIMITED");
  });

  it("excludes details in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    
    const result = createError(
      ErrorCodes.INTERNAL_ERROR,
      "Error",
      { includeDetails: { sql: "SELECT * FROM private_table" } }
    );
    
    expect(result.body.details).toBeUndefined();
    
    process.env.NODE_ENV = originalEnv;
  });

  it("includes details in development", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    
    const result = createError(
      ErrorCodes.INTERNAL_ERROR,
      "Error",
      { includeDetails: { sql: "SELECT * FROM private" } }
    );
    
    expect(result.body.details).toBeDefined();
    
    process.env.NODE_ENV = originalEnv;
  });

  it("never exposes correlationId in response body", () => {
    const result = createError(
      ErrorCodes.INTERNAL_ERROR,
      "Error",
      { correlationId: "corr-123" }
    );
    expect(result.body.correlationId).toBeUndefined();
  });
});

describe("Correlation ID middleware", () => {
  it("generates new correlation ID when none provided", () => {
    const req = { headers: {} } as any;
    const res = { setHeader: () => {} } as any;
    const next = () => {};
    
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBeDefined();
    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses existing correlation ID from header", () => {
    const existingId = "existing-correlation-id";
    const req = { headers: { "x-correlation-id": existingId } } as any;
    const res = { setHeader: () => {} } as any;
    const next = () => {};
    
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe(existingId);
  });

  it("sets correlation ID header on response", () => {
    const req = { headers: {} } as any;
    let headerName = "";
    let headerValue = "";
    const res = { 
      setHeader: (name: string, value: string) => { 
        headerName = name; 
        headerValue = value; 
      } 
    } as any;
    const next = () => {};
    
    correlationIdMiddleware(req, res, next);
    expect(headerName).toBe("x-correlation-id");
    expect(headerValue).toBe(req.correlationId);
  });
});

describe("Error responses do not leak SQL", () => {
  it("DB error message is sanitized", () => {
    const dbError = new Error('relation "users" does not exist');
    const result = createError(
      ErrorCodes.INTERNAL_ERROR,
      "An unexpected error occurred",
      { includeDetails: dbError.message }
    );
    
    // In production, details should not be exposed
    expect(result.body.details).toBeUndefined();
    
    // In development, original error is included but this test
    // verifies the mechanism works
  });
});
```

### 2.6 Client-Side Type Definitions

The SDK should include the error types for client handling:

```typescript
// sdk/src/errors.ts
export type ApiErrorCode = 
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "BAD_GATEWAY";

export interface ApiErrorResponse {
  code: ApiErrorCode;
  message: string;
  // correlationId is NOT exposed to clients
}

export function isApiError(response: unknown): response is ApiErrorResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    "message" in response
  );
}
```

## Acceptance Criteria

- [ ] All API errors use the documented error codes
- [ ] HTTP status codes are correct (400 for validation, 404 for not found, 429 for rate limit, 5xx for server errors)
- [ ] Correlation IDs are generated per-request and logged server-side
- [ ] Correlation IDs are NOT exposed in response bodies
- [ ] SQL errors, stack traces, and internal details are never exposed to clients in production
- [ ] NODE_ENV=development includes details for debugging
- [ ] All route error handlers use the common error envelope

## Priority

**High** - Security and reliability. Leaking SQL errors or stack traces is a security vulnerability.