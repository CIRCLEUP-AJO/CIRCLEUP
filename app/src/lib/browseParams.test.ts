import { describe, it, expect } from "vitest";
import { parseBrowseParams, browseQueryString } from "./homeHero";

describe("parseBrowseParams", () => {
  it("defaults invalid values explicitly", () => {
    expect(parseBrowseParams({})).toEqual({
      status: undefined,
      sort: "created_ledger",
      order: "desc",
      page: 1,
    });
    expect(parseBrowseParams({ status: "Bogus", sort: "nope", order: "sideways", page: "-3" })).toEqual({
      status: undefined,
      sort: "created_ledger",
      order: "desc",
      page: 1,
    });
  });
  it("keeps valid combinations and clamps page", () => {
    const p = parseBrowseParams({ status: "Active", sort: "round_amount", order: "asc", page: "4" });
    expect(p).toEqual({ status: "Active", sort: "round_amount", order: "asc", page: 4 });
    expect(parseBrowseParams({ page: "9999" }).page).toBe(1000);
  });
  it("round-trips through the query string", () => {
    const p = parseBrowseParams({ status: "Pending", sort: "member_count", order: "asc", page: "2" });
    expect(browseQueryString(p)).toBe("status=Pending&sort=member_count&order=asc&page=2");
  });
});
