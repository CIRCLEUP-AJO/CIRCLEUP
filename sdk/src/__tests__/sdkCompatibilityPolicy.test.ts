import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CircleDetailResponse, ApiCircleDetailResponse } from "../index";

describe("Issue #909: SDK Compatibility and Semantic Versioning Policy", () => {
  const rootDir = path.resolve(__dirname, "../../..");
  const policyPath = path.join(rootDir, "docs/SDK_COMPATIBILITY.md");
  const readmePath = path.join(rootDir, "sdk/README.md");
  const changelogPath = path.join(rootDir, "CHANGELOG.md");

  it("publishes comprehensive docs/SDK_COMPATIBILITY.md", () => {
    expect(fs.existsSync(policyPath)).toBe(true);
    const content = fs.readFileSync(policyPath, "utf8");

    // Scope & Canonical Entry Point
    expect(content).toMatch(/Scope & Canonical Entry Point/i);
    expect(content).toMatch(/@circleup\/sdk/);
    expect(content).toMatch(/sdk\/src\/index\.ts/);

    // Pre-1.0 Semantic Versioning
    expect(content).toMatch(/Pre-1\.0 Semantic Versioning/i);
    expect(content).toMatch(/0\.x\.Y/);
    expect(content).toMatch(/0\.X\.0/);

    // Deprecation Lifecycle & Notice Periods
    expect(content).toMatch(/Deprecation Lifecycle/i);
    expect(content).toMatch(/Minimum Notice Periods/i);

    // Release Checklist
    expect(content).toMatch(/Release Checklist/i);
    expect(content).toMatch(/check-public-api/);
  });

  it("exports representative deprecated symbol CircleDetailResponse from root API", () => {
    // Structural compatibility: CircleDetailResponse is equivalent to ApiCircleDetailResponse
    const mockDetail: CircleDetailResponse = {
      circle: {
        id: 1,
        address: "C".padEnd(56, "A"),
        creator: "G".padEnd(56, "A"),
        round_amount: "100000000",
        member_count: 2,
        status: "Active",
        current_round: 1,
        total_rounds: 2,
        created_ledger: "1000",
        updated_at: "2026-01-01T00:00:00Z",
      },
      members: [],
      latestLedger: 1000,
    };

    const apiDetail: ApiCircleDetailResponse = mockDetail;
    expect(apiDetail.circle.address).toBe("C".padEnd(56, "A"));
  });

  it("links to the policy in sdk/README.md and CHANGELOG.md", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    expect(readme).toMatch(/SDK_COMPATIBILITY\.md/);

    const changelog = fs.readFileSync(changelogPath, "utf8");
    expect(changelog).toMatch(/SDK_COMPATIBILITY\.md/);
  });
});

