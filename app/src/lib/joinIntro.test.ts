/**
 * Tests for the join introduction content model.
 *
 * Acceptance criteria:
 *   - Each lifecycle status produces the correct variant and joinAvailable flag.
 *   - Prerequisites reflect wallet install, connection, and network state.
 *   - All content includes the guaranteeNote (advisory disclaimer).
 *   - No variant implies joining is available when the contract disallows it.
 */
import { describe, it, expect } from "vitest";
import { buildJoinIntroContent, type JoinIntroInput } from "./joinIntro";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<JoinIntroInput> = {}): JoinIntroInput {
  return {
    status: "Pending",
    joinedCount: 1,
    memberCount: 4,
    roundAmountStroops: "10000000", // 1 USDC
    isMember: false,
    walletState: "connected",
    networkName: "testnet",
    networkMismatch: false,
    ...overrides,
  };
}

// ─── Lifecycle variants ───────────────────────────────────────────────────────

describe("buildJoinIntroContent — lifecycle variants", () => {
  it("Pending + not member + slots open → pending_open, joinAvailable=true", () => {
    const result = buildJoinIntroContent(makeInput());
    expect(result.variant).toBe("pending_open");
    expect(result.joinAvailable).toBe(true);
  });

  it("Pending + already a member → pending_joined, joinAvailable=false", () => {
    const result = buildJoinIntroContent(makeInput({ isMember: true }));
    expect(result.variant).toBe("pending_joined");
    expect(result.joinAvailable).toBe(false);
  });

  it("Pending + all slots taken + not member → pending_full, joinAvailable=false", () => {
    const result = buildJoinIntroContent(
      makeInput({ joinedCount: 4, memberCount: 4, isMember: false }),
    );
    expect(result.variant).toBe("pending_full");
    expect(result.joinAvailable).toBe(false);
  });

  it("Active → active variant, joinAvailable=false", () => {
    const result = buildJoinIntroContent(makeInput({ status: "Active" }));
    expect(result.variant).toBe("active");
    expect(result.joinAvailable).toBe(false);
  });

  it("Completed → completed variant, joinAvailable=false", () => {
    const result = buildJoinIntroContent(makeInput({ status: "Completed" }));
    expect(result.variant).toBe("completed");
    expect(result.joinAvailable).toBe(false);
  });

  it("Cancelled → cancelled variant, joinAvailable=false", () => {
    const result = buildJoinIntroContent(makeInput({ status: "Cancelled" }));
    expect(result.variant).toBe("cancelled");
    expect(result.joinAvailable).toBe(false);
  });

  it("Closed → closed variant, joinAvailable=false", () => {
    const result = buildJoinIntroContent(makeInput({ status: "Closed" }));
    expect(result.variant).toBe("closed");
    expect(result.joinAvailable).toBe(false);
  });

  it("Unknown status → unknown variant, joinAvailable=false", () => {
    const result = buildJoinIntroContent(makeInput({ status: "Whatever" }));
    expect(result.variant).toBe("unknown");
    expect(result.joinAvailable).toBe(false);
  });
});

// ─── Advisory guarantee note ──────────────────────────────────────────────────

describe("buildJoinIntroContent — guaranteeNote always present", () => {
  const statuses = ["Pending", "Active", "Completed", "Cancelled", "Closed", "Unknown"];

  for (const status of statuses) {
    it(`guaranteeNote is non-empty for status=${status}`, () => {
      const result = buildJoinIntroContent(makeInput({ status }));
      expect(result.guaranteeNote).toBeTruthy();
      expect(result.guaranteeNote.length).toBeGreaterThan(20);
    });
  }
});

// ─── Prerequisites ────────────────────────────────────────────────────────────

describe("buildJoinIntroContent — wallet prerequisites", () => {
  it("wallet not_installed → installed prerequisite not met, includes freighter.app link", () => {
    const result = buildJoinIntroContent(
      makeInput({ walletState: "not_installed" }),
    );
    const installedPrereq = result.prerequisites.find(
      (p) => p.label === "Freighter wallet installed",
    );
    expect(installedPrereq).toBeDefined();
    expect(installedPrereq!.met).toBe(false);
    expect(installedPrereq!.setupUrl).toBe("https://freighter.app");
  });

  it("wallet disconnected → connected prerequisite not met", () => {
    const result = buildJoinIntroContent(
      makeInput({ walletState: "disconnected" }),
    );
    const connectedPrereq = result.prerequisites.find(
      (p) => p.label === "Wallet connected",
    );
    expect(connectedPrereq).toBeDefined();
    expect(connectedPrereq!.met).toBe(false);
  });

  it("wallet connected + no mismatch → all prerequisites met", () => {
    const result = buildJoinIntroContent(
      makeInput({ walletState: "connected", networkMismatch: false }),
    );
    expect(result.prerequisites.every((p) => p.met)).toBe(true);
  });

  it("network mismatch → network prerequisite not met, includes setup link", () => {
    const result = buildJoinIntroContent(
      makeInput({ walletState: "connected", networkMismatch: true }),
    );
    const networkPrereq = result.prerequisites.find((p) =>
      p.label.includes("testnet"),
    );
    expect(networkPrereq).toBeDefined();
    expect(networkPrereq!.met).toBe(false);
    expect(networkPrereq!.setupUrl).toBeTruthy();
  });

  it("prerequisites are empty for non-joinable statuses", () => {
    for (const status of ["Active", "Completed", "Cancelled", "Closed"]) {
      const result = buildJoinIntroContent(makeInput({ status }));
      expect(result.prerequisites).toHaveLength(0);
    }
  });

  it("prerequisites are empty when isMember=true on Pending", () => {
    const result = buildJoinIntroContent(makeInput({ isMember: true }));
    expect(result.prerequisites).toHaveLength(0);
  });
});

// ─── Body content checks ──────────────────────────────────────────────────────

describe("buildJoinIntroContent — body content", () => {
  it("pending_open body mentions collateral amount", () => {
    const result = buildJoinIntroContent(
      makeInput({ roundAmountStroops: "10000000" }),
    );
    expect(result.body).toContain("1.00");
  });

  it("pending_open body mentions joined/member counts", () => {
    const result = buildJoinIntroContent(
      makeInput({ joinedCount: 2, memberCount: 5 }),
    );
    expect(result.body).toContain("2");
    expect(result.body).toContain("5");
  });

  it("pending_full body mentions member count", () => {
    const result = buildJoinIntroContent(
      makeInput({ joinedCount: 3, memberCount: 3, isMember: false }),
    );
    expect(result.body).toContain("3");
  });

  it("all variants have non-empty heading and body", () => {
    const statuses = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const status of statuses) {
      const result = buildJoinIntroContent(makeInput({ status }));
      expect(result.heading.length).toBeGreaterThan(3);
      expect(result.body.length).toBeGreaterThan(10);
    }
  });
});
