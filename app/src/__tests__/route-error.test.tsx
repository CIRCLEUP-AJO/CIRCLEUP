/**
 * Route error boundary (circles/[address]/error.tsx).
 *
 * Retry is offered only for a likely transient indexer outage. Deterministic
 * / invalid failures are not presented as retryable network outages — the user
 * gets a clear message and a way back instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import CircleError from "../app/circles/[address]/error.tsx";
import ReputationError from "../app/reputation/[address]/error.tsx";
import { classifyRouteError, isAddressLike } from "../lib/route-errors.ts";

describe("circles/[address] error boundary", () => {
  it("offers 'Try again' for a likely indexer outage", () => {
    const error = new Error("The indexer is unreachable or degraded") as Error & {
      digest?: string;
    };
    error.digest = "abc123";
    render(<CircleError error={error} reset={vi.fn()} />);

    expect(screen.getByText(/Indexer unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByText(/Back to circles/i)).toBeInTheDocument();
  });

  it("treats a 503 as a retryable outage", () => {
    const error = new Error("indexer returned 503") as Error & { digest?: string };
    render(<CircleError error={error} reset={vi.fn()} />);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does not offer retry for a deterministic failure", () => {
    const error = new Error("invalid circle address supplied") as Error & {
      digest?: string;
    };
    render(<CircleError error={error} reset={vi.fn()} />);

    expect(screen.getByText(/Something went wrong loading this circle/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Back to circles/i)).toBeInTheDocument();
  });

  it("does not offer retry for a generic unexpected error", () => {
    const error = new Error("Something unexpected happened") as Error & {
      digest?: string;
    };
    render(<CircleError error={error} reset={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
  });
});

describe("reputation/[address] error boundary", () => {
  it("offers 'Try again' for a likely indexer outage", () => {
    const error = new Error("The indexer is unreachable or degraded") as Error & {
      digest?: string;
    };
    render(<ReputationError error={error} reset={vi.fn()} />);
    expect(screen.getByText(/Indexer unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByText(/Back to reputation/i)).toBeInTheDocument();
  });

  it("does not offer retry for a deterministic failure", () => {
    const error = new Error("invalid address supplied") as Error & {
      digest?: string;
    };
    render(<ReputationError error={error} reset={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Back to reputation/i)).toBeInTheDocument();
  });
});

describe("route error classification", () => {
  it("classifies invalid address as 400 and non-retryable", () => {
    const outcome = classifyRouteError(new Error("invalid address supplied"));
    expect(outcome.status).toBe(400);
    expect(outcome.retryable).toBe(false);
  });

  it("classifies unknown entity as 404 and non-retryable", () => {
    const outcome = classifyRouteError(new Error("circle not found"));
    expect(outcome.status).toBe(404);
    expect(outcome.retryable).toBe(false);
  });

  it("classifies delayed indexing as retryable", () => {
    const outcome = classifyRouteError(new Error("indexer has not seen this circle yet"));
    expect(outcome.retryable).toBe(true);
  });

  it("classifies contract read failure as 502 and non-retryable", () => {
    const outcome = classifyRouteError(new Error("contract read failed"));
    expect(outcome.status).toBe(502);
    expect(outcome.retryable).toBe(false);
  });

  it("classifies service outage as 503 and retryable", () => {
    const outcome = classifyRouteError(new Error("upstream service unavailable"));
    expect(outcome.status).toBe(503);
    expect(outcome.retryable).toBe(true);
  });

  it("validates addresses without touching the network", () => {
    expect(isAddressLike("0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
    expect(isAddressLike("not-an-address")).toBe(false);
    expect(isAddressLike("")).toBe(false);
  });
});

describe("dynamic route loaders", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an invalid address before any downstream fetch", async () => {
    const { loadCircleRoute } = await import("../lib/route-loaders.ts");
    const result = await loadCircleRoute("not-an-address");
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown circle", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    const { loadCircleRoute } = await import("../lib/route-loaders.ts");
    const result = await loadCircleRoute("0x1234567890abcdef1234567890abcdef12345678");
    expect(result.status).toBe(404);
  });

  it("returns a retryable outcome when indexing is delayed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    const { loadCircleRoute } = await import("../lib/route-loaders.ts");
    const result = await loadCircleRoute("0x1234567890abcdef1234567890abcdef12345678", {
      indexingDelay: true,
    });
    expect(result.status).toBe(503);
    expect(result.retryable).toBe(true);
  });

  it("returns 502 for a contract read failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    const { loadCircleRoute } = await import("../lib/route-loaders.ts");
    const result = await loadCircleRoute("0x1234567890abcdef1234567890abcdef12345678");
    expect(result.status).toBe(502);
  });

  it("returns 503 for a service outage", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { loadCircleRoute } = await import("../lib/route-loaders.ts");
    const result = await loadCircleRoute("0x1234567890abcdef1234567890abcdef12345678");
    expect(result.status).toBe(503);
    expect(result.retryable).toBe(true);
  });

  it("loads a valid circle entity", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ address: "0x1234567890abcdef1234567890abcdef12345678" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { loadCircleRoute } = await import("../lib/route-loaders.ts");
    const result = await loadCircleRoute("0x1234567890abcdef1234567890abcdef12345678");
    expect(result.status).toBe(200);
    expect(result.data).toBeTruthy();
  });

  it("rejects an invalid reputation address before any downstream fetch", async () => {
    const { loadReputationRoute } = await import("../lib/route-loaders.ts");
    const result = await loadReputationRoute("bad");
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads a valid reputation entity", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ address: "0x1234567890abcdef1234567890abcdef12345678" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { loadReputationRoute } = await import("../lib/route-loaders.ts");
    const result = await loadReputationRoute("0x1234567890abcdef1234567890abcdef12345678");
    expect(result.status).toBe(200);
  });
});
