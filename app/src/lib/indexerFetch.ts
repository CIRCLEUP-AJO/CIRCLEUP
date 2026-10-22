/** Read-only indexer transport. The response exposes X-Request-ID for diagnostics. */
export function indexerFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
    throw new TypeError("indexerFetch only supports reads");
  }
  const headers = new Headers(init.headers);
  headers.set("X-Request-ID", globalThis.crypto.randomUUID());
  return fetch(input, { ...init, headers });
}
