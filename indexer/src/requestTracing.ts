import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { logApiRequest } from "./logger";

// UUIDv4 only: bounded, random, and cannot contain wallet addresses or log syntax.
export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requestTracing(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
  const values = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "x-request-id");
  const supplied = req.headers["x-request-id"];
  const requestId = values.length === 1 && typeof supplied === "string" && REQUEST_ID_RE.test(supplied)
    ? supplied.toLowerCase() : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  const startedAt = Date.now();
  res.on("finish", () => logApiRequest({
    requestId, method: req.method,
    // Never log raw URLs, query strings, wallets, or caller-controlled paths.
    path: typeof req.route?.path === "string" ? req.route.path : "unmatched",
    statusCode: res.statusCode, durationMs: Date.now() - startedAt,
  }));
  next();
}
