import { describe, expect, it } from "vitest";

import { getBrowseState, isValidUrl } from "../app/page";

describe("homepage hero validation and CTA state", () => {
  it("accepts absolute HTTP and HTTPS indexer URLs", () => {
    expect(isValidUrl("http://localhost:3001")).toBe(true);
    expect(isValidUrl("https://indexer.example.com")).toBe(true);
  });

  it("rejects empty, relative, and placeholder URLs", () => {
    expect(isValidUrl("")).toBe(false);
    expect(isValidUrl(" ")).toBe(false);
    expect(isValidUrl("/api/circles")).toBe(false);
    expect(isValidUrl("localhost:3001")).toBe(false);
  });

  it("treats a failed fetch as unavailable instead of rendering a broken CTA", () => {
    expect(getBrowseState(null)).toEqual({ kind: "unavailable" });
    expect(getBrowseState({ ok: false, error: "network" } as any)).toEqual({
      kind: "unavailable",
    });
  });

  it("offers a browse CTA only when circles are available", () => {
    expect(getBrowseState({ ok: true, circles: [] } as any)).toEqual({ kind: "empty" });
    expect(getBrowseState({ ok: true, circles: [{ address: "C123" }] } as any)).toEqual({
      kind: "browse",
      count: 1,
    });
    expect(
      getBrowseState({ ok: true, circles: [{ address: "C1" }, { address: "C2" }] } as any),
    ).toEqual({ kind: "browse", count: 2 });
  });
});
