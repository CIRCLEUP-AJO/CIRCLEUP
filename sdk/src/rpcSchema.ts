/**
 * Runtime schema validation and parsing for Soroban RPC responses.
 *
 * Enforces production contract guarantees:
 * 1. Safe additive compatibility: Unknown or future RPC provider fields are tolerated and ignored.
 * 2. Explicit required fields: Missing required fields are explicitly rejected with descriptive errors.
 * 3. Sanitized error reporting: Error messages describe schema violations without leaking sensitive payloads.
 */

export class RpcParsingError extends Error {
  public readonly method: string;
  public readonly field: string;
  public readonly reason: string;

  constructor(method: string, field: string, reason: string) {
    super(`[Soroban RPC ${method}] Schema violation at "${field}": ${reason}`);
    this.name = "RpcParsingError";
    this.method = method;
    this.field = field;
    this.reason = reason;
  }
}

function assertObject(raw: unknown, method: string, field = "$"): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcParsingError(method, field, `expected an object, got ${raw === null ? "null" : typeof raw}`);
  }
  return raw as Record<string, unknown>;
}

function assertInteger(raw: unknown, method: string, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new RpcParsingError(method, field, `expected an integer number, got ${typeof raw}`);
  }
  return raw;
}

function assertString(raw: unknown, method: string, field: string): string {
  if (typeof raw !== "string") {
    throw new RpcParsingError(method, field, `expected a string, got ${typeof raw}`);
  }
  return raw;
}

function assertArray(raw: unknown, method: string, field: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new RpcParsingError(method, field, `expected an array, got ${typeof raw}`);
  }
  return raw;
}

// ─── Parsed Models ────────────────────────────────────────────────────────────

export interface ParsedRpcEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: unknown[];
  value: unknown;
  pagingToken?: string;
  inSuccessfulContractCall?: boolean;
}

export interface ParsedGetEventsResponse {
  events: ParsedRpcEvent[];
  latestLedger: number;
  cursor?: string;
}

export interface ParsedSimulateTransactionResponse {
  id?: string;
  latestLedger: number;
  minResourceFee?: string;
  transactionData?: unknown;
  events?: unknown[];
  error?: string;
  results?: Array<{ auth: unknown[]; xdr: string }>;
  result?: { auth: unknown[]; retval: unknown };
  cost?: { cpuInsns: string; memBytes: string };
  restorePreamble?: { minResourceFee: string; transactionData: unknown };
}

export interface ParsedSendTransactionResponse {
  status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
  hash: string;
  latestLedger?: number;
  latestLedgerCloseTime?: number | string;
  errorResult?: unknown;
}

export interface ParsedGetTransactionResponse {
  status: "SUCCESS" | "NOT_FOUND" | "FAILED";
  latestLedger: number;
  latestLedgerCloseTime?: number | string;
  oldestLedger?: number;
  ledger?: number;
  createdAt?: number | string;
  applicationOrder?: number;
  feeBump?: boolean;
  envelopeXdr?: string;
  resultXdr?: string;
  resultMetaXdr?: string;
  diagnosticEventsXdr?: string[];
}

export interface ParsedGetLatestLedgerResponse {
  id: string;
  protocolVersion: number;
  sequence: number;
  ledgerCloseTime?: number | string;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

/**
 * Validates and parses Soroban RPC `getEvents` response.
 * Tolerates unknown additive fields while enforcing required pagination and event properties.
 */
export function parseRpcGetEventsResponse(raw: unknown): ParsedGetEventsResponse {
  const obj = assertObject(raw, "getEvents");

  if (!("latestLedger" in obj)) {
    throw new RpcParsingError("getEvents", "latestLedger", "missing required field");
  }
  const latestLedger = assertInteger(obj.latestLedger, "getEvents", "latestLedger");

  if (!("events" in obj)) {
    throw new RpcParsingError("getEvents", "events", "missing required field");
  }
  const rawEvents = assertArray(obj.events, "getEvents", "events");

  const events: ParsedRpcEvent[] = rawEvents.map((e, idx) => {
    const item = assertObject(e, "getEvents", `events[${idx}]`);
    if (!("id" in item)) throw new RpcParsingError("getEvents", `events[${idx}].id`, "missing required field");
    if (!("type" in item)) throw new RpcParsingError("getEvents", `events[${idx}].type`, "missing required field");
    if (!("ledger" in item)) throw new RpcParsingError("getEvents", `events[${idx}].ledger`, "missing required field");
    if (!("contractId" in item)) throw new RpcParsingError("getEvents", `events[${idx}].contractId`, "missing required field");
    if (!("topic" in item)) throw new RpcParsingError("getEvents", `events[${idx}].topic`, "missing required field");
    if (!("value" in item)) throw new RpcParsingError("getEvents", `events[${idx}].value`, "missing required field");

    return {
      id: assertString(item.id, "getEvents", `events[${idx}].id`),
      type: assertString(item.type, "getEvents", `events[${idx}].type`),
      ledger: assertInteger(item.ledger, "getEvents", `events[${idx}].ledger`),
      ledgerClosedAt: typeof item.ledgerClosedAt === "string" ? item.ledgerClosedAt : "",
      contractId: assertString(item.contractId, "getEvents", `events[${idx}].contractId`),
      topic: assertArray(item.topic, "getEvents", `events[${idx}].topic`),
      value: item.value,
      pagingToken: typeof item.pagingToken === "string" ? item.pagingToken : undefined,
      inSuccessfulContractCall: typeof item.inSuccessfulContractCall === "boolean" ? item.inSuccessfulContractCall : undefined,
    };
  });

  return {
    events,
    latestLedger,
    cursor: typeof obj.cursor === "string" ? obj.cursor : undefined,
  };
}

/**
 * Validates and parses Soroban RPC `simulateTransaction` response.
 * Handles both success and simulation failure shapes.
 */
export function parseRpcSimulateTransactionResponse(raw: unknown): ParsedSimulateTransactionResponse {
  const obj = assertObject(raw, "simulateTransaction");

  if (!("latestLedger" in obj)) {
    throw new RpcParsingError("simulateTransaction", "latestLedger", "missing required field");
  }
  const latestLedger = assertInteger(obj.latestLedger, "simulateTransaction", "latestLedger");

  const hasError = "error" in obj && typeof obj.error === "string";
  const hasMinFee = "minResourceFee" in obj;

  if (!hasError && !hasMinFee) {
    throw new RpcParsingError(
      "simulateTransaction",
      "minResourceFee",
      "successful simulation response must include 'minResourceFee' (or 'error' on rejection)",
    );
  }

  const parsed: ParsedSimulateTransactionResponse = {
    latestLedger,
    id: typeof obj.id === "string" ? obj.id : undefined,
    minResourceFee: typeof obj.minResourceFee === "string" || typeof obj.minResourceFee === "number" ? String(obj.minResourceFee) : undefined,
    transactionData: obj.transactionData,
    events: Array.isArray(obj.events) ? obj.events : undefined,
    error: hasError ? String(obj.error) : undefined,
  };

  if (obj.cost && typeof obj.cost === "object") {
    const c = obj.cost as Record<string, unknown>;
    parsed.cost = {
      cpuInsns: String(c.cpuInsns ?? "0"),
      memBytes: String(c.memBytes ?? "0"),
    };
  }

  if (Array.isArray(obj.results)) {
    parsed.results = obj.results as Array<{ auth: unknown[]; xdr: string }>;
  } else if (obj.result && typeof obj.result === "object") {
    parsed.result = obj.result as { auth: unknown[]; retval: unknown };
  }

  if (obj.restorePreamble && typeof obj.restorePreamble === "object") {
    const p = obj.restorePreamble as Record<string, unknown>;
    parsed.restorePreamble = {
      minResourceFee: String(p.minResourceFee ?? "0"),
      transactionData: p.transactionData,
    };
  }

  return parsed;
}

/**
 * Validates and parses Soroban RPC `sendTransaction` response.
 */
export function parseRpcSendTransactionResponse(raw: unknown): ParsedSendTransactionResponse {
  const obj = assertObject(raw, "sendTransaction");

  if (!("status" in obj)) {
    throw new RpcParsingError("sendTransaction", "status", "missing required field");
  }
  const statusStr = assertString(obj.status, "sendTransaction", "status");
  const validStatuses = ["PENDING", "DUPLICATE", "TRY_AGAIN_LATER", "ERROR"];
  if (!validStatuses.includes(statusStr)) {
    throw new RpcParsingError(
      "sendTransaction",
      "status",
      `invalid transaction status '${statusStr}', expected one of ${validStatuses.join(", ")}`,
    );
  }

  if (!("hash" in obj)) {
    throw new RpcParsingError("sendTransaction", "hash", "missing required field");
  }
  const hash = assertString(obj.hash, "sendTransaction", "hash");

  return {
    status: statusStr as ParsedSendTransactionResponse["status"],
    hash,
    latestLedger: typeof obj.latestLedger === "number" ? obj.latestLedger : undefined,
    latestLedgerCloseTime: typeof obj.latestLedgerCloseTime === "number" || typeof obj.latestLedgerCloseTime === "string" ? obj.latestLedgerCloseTime : undefined,
    errorResult: obj.errorResult,
  };
}

/**
 * Validates and parses Soroban RPC `getTransaction` response.
 */
export function parseRpcGetTransactionResponse(raw: unknown): ParsedGetTransactionResponse {
  const obj = assertObject(raw, "getTransaction");

  if (!("status" in obj)) {
    throw new RpcParsingError("getTransaction", "status", "missing required field");
  }
  const statusStr = assertString(obj.status, "getTransaction", "status");
  const validStatuses = ["SUCCESS", "NOT_FOUND", "FAILED"];
  if (!validStatuses.includes(statusStr)) {
    throw new RpcParsingError(
      "getTransaction",
      "status",
      `invalid status '${statusStr}', expected one of ${validStatuses.join(", ")}`,
    );
  }

  if (!("latestLedger" in obj)) {
    throw new RpcParsingError("getTransaction", "latestLedger", "missing required field");
  }
  const latestLedger = assertInteger(obj.latestLedger, "getTransaction", "latestLedger");

  if (statusStr === "SUCCESS") {
    if (!("ledger" in obj)) {
      throw new RpcParsingError("getTransaction", "ledger", "SUCCESS status requires confirmed 'ledger'");
    }
  }

  return {
    status: statusStr as ParsedGetTransactionResponse["status"],
    latestLedger,
    latestLedgerCloseTime: typeof obj.latestLedgerCloseTime === "number" || typeof obj.latestLedgerCloseTime === "string" ? obj.latestLedgerCloseTime : undefined,
    oldestLedger: typeof obj.oldestLedger === "number" ? obj.oldestLedger : undefined,
    ledger: typeof obj.ledger === "number" ? obj.ledger : undefined,
    createdAt: typeof obj.createdAt === "number" || typeof obj.createdAt === "string" ? obj.createdAt : undefined,
    applicationOrder: typeof obj.applicationOrder === "number" ? obj.applicationOrder : undefined,
    feeBump: typeof obj.feeBump === "boolean" ? obj.feeBump : undefined,
    envelopeXdr: typeof obj.envelopeXdr === "string" ? obj.envelopeXdr : undefined,
    resultXdr: typeof obj.resultXdr === "string" ? obj.resultXdr : undefined,
    resultMetaXdr: typeof obj.resultMetaXdr === "string" ? obj.resultMetaXdr : undefined,
    diagnosticEventsXdr: Array.isArray(obj.diagnosticEventsXdr) ? (obj.diagnosticEventsXdr as string[]) : undefined,
  };
}

/**
 * Validates and parses Soroban RPC `getLatestLedger` response.
 */
export function parseRpcGetLatestLedgerResponse(raw: unknown): ParsedGetLatestLedgerResponse {
  const obj = assertObject(raw, "getLatestLedger");

  if (!("sequence" in obj)) {
    throw new RpcParsingError("getLatestLedger", "sequence", "missing required field");
  }
  const sequence = assertInteger(obj.sequence, "getLatestLedger", "sequence");

  if (!("id" in obj)) {
    throw new RpcParsingError("getLatestLedger", "id", "missing required field");
  }
  const id = assertString(obj.id, "getLatestLedger", "id");

  const protocolVersion = typeof obj.protocolVersion === "number" ? obj.protocolVersion : 0;

  return {
    id,
    protocolVersion,
    sequence,
    ledgerCloseTime: typeof obj.ledgerCloseTime === "number" || typeof obj.ledgerCloseTime === "string" ? obj.ledgerCloseTime : undefined,
  };
}
