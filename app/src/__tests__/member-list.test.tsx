/**
 * Member list — stable identity, reorder, remove, and accessibility tests.
 *
 * Coverage:
 *   reorderMembers()  — pure function: boundary conditions, swap, multi-step
 *   createMemberRow() — stable id generation
 *   Component render  — reorder preserves values in correct slots
 *                     — remove never moves another row's value
 *                     — move-up / move-down produce the intended contract order
 *                     — reorder buttons have accessible names
 *                     — remove button has accessible name (incl. at-min state)
 *                     — address input has accessible name with position info
 *                     — editing a value after reorder updates the correct row
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";

import {
  reorderMembers,
  createMemberRow,
  type MemberRow,
} from "../app/create/CreateClient";

/**
 * Deterministic, checksum-valid G-addresses (Issue #477): shape alone is not
 * enough, every member entry must carry a valid strkey checksum.
 */
const addrFor = (seed: number): string =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/stellar", () => ({
  getWalletAddress: vi.fn().mockResolvedValue(null),
  invokeContract: vi.fn(),
  WalletError: class WalletError extends Error {
    constructor(
      public reason: string,
      message: string,
    ) {
      super(message);
      this.name = "WalletError";
    }
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    CIRCLE_FACTORY_ADDRESS:
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    ACTIVE_NETWORK: "testnet",
    getExplorerLink: () => null,
  };
});

import CreateClient from "../app/create/CreateClient";

// ─── Address fixtures ─────────────────────────────────────────────────────────

const A = addrFor(1);
const B = addrFor(2);
const C = addrFor(3);
const D = addrFor(4);

// ─── reorderMembers ───────────────────────────────────────────────────────────

describe("reorderMembers()", () => {
  const arr = ["a", "b", "c", "d"];

  it("returns the array unchanged when fromIndex === toIndex", () => {
    expect(reorderMembers(arr, 1, 1)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns the original reference when fromIndex === toIndex", () => {
    expect(reorderMembers(arr, 2, 2)).toBe(arr);
  });

  it("returns original when fromIndex is out of range (negative)", () => {
    expect(reorderMembers(arr, -1, 0)).toBe(arr);
  });

  it("returns original when fromIndex is out of range (too large)", () => {
    expect(reorderMembers(arr, 4, 0)).toBe(arr);
  });

  it("returns original when toIndex is out of range (negative)", () => {
    expect(reorderMembers(arr, 0, -1)).toBe(arr);
  });

  it("returns original when toIndex is out of range (too large)", () => {
    expect(reorderMembers(arr, 0, 4)).toBe(arr);
  });

  it("moves first element to last", () => {
    expect(reorderMembers(arr, 0, 3)).toEqual(["b", "c", "d", "a"]);
  });

  it("moves last element to first", () => {
    expect(reorderMembers(arr, 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("moves element one step down (adjacent swap)", () => {
    expect(reorderMembers(arr, 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves element one step up (adjacent swap)", () => {
    expect(reorderMembers(arr, 2, 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves middle element to front", () => {
    expect(reorderMembers(arr, 2, 0)).toEqual(["c", "a", "b", "d"]);
  });

  it("does not mutate the original array", () => {
    const original = ["x", "y", "z"];
    reorderMembers(original, 0, 2);
    expect(original).toEqual(["x", "y", "z"]);
  });

  it("handles a single-element array gracefully", () => {
    expect(reorderMembers(["only"], 0, 0)).toEqual(["only"]);
  });

  it("handles MemberRow objects (not just strings)", () => {
    const rows: MemberRow[] = [
      { id: "r0", value: A },
      { id: "r1", value: B },
      { id: "r2", value: C },
    ];
    const result = reorderMembers(rows, 0, 2);
    expect(result.map((r) => r.id)).toEqual(["r1", "r2", "r0"]);
    expect(result.map((r) => r.value)).toEqual([B, C, A]);
  });

  it("multi-step sequence produces the expected final order", () => {
    const step1 = reorderMembers(arr, 3, 0); // [d,a,b,c]
    expect(step1).toEqual(["d", "a", "b", "c"]);
    const step2 = reorderMembers(step1, 2, 3); // [d,a,c,b]
    expect(step2).toEqual(["d", "a", "c", "b"]);
  });
});

// ─── createMemberRow ──────────────────────────────────────────────────────────

describe("createMemberRow()", () => {
  it("creates a row with an empty value by default", () => {
    expect(createMemberRow().value).toBe("");
  });

  it("creates a row with the supplied value", () => {
    expect(createMemberRow(A).value).toBe(A);
  });

  it("each call produces a unique id", () => {
    const ids = new Set(Array.from({ length: 20 }, () => createMemberRow().id));
    expect(ids.size).toBe(20);
  });

  it("id is a non-empty string", () => {
    const row = createMemberRow();
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
  });
});

// ─── Component helpers ────────────────────────────────────────────────────────

function getMemberInputs() {
  return screen.getAllByRole("textbox", {
    name: /member \d+ of \d+ — stellar address/i,
  });
}

function fillMembers(values: string[]) {
  const inputs = getMemberInputs();
  values.forEach((v, i) => {
    if (inputs[i]) fireEvent.change(inputs[i], { target: { value: v } });
  });
}

function getMemberValues(): string[] {
  return getMemberInputs().map((el) => (el as HTMLInputElement).value);
}

// ─── Remove behaviour ─────────────────────────────────────────────────────────

describe("Member list — remove", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removing a middle row never shifts another row's value into the wrong slot", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[1]); // removes position 2 (value B)

    expect(getMemberValues()).toEqual([A, C, D]);
  });

  it("removing the first row gives [B, C, D]", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[0]);

    expect(getMemberValues()).toEqual([B, C, D]);
  });

  it("removing the last row gives [A, B, C]", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[removeBtns.length - 1]);

    expect(getMemberValues()).toEqual([A, B, C]);
  });

  it("remove button is aria-disabled at minimum member count", () => {
    render(<CreateClient />);
    // Default 4 rows — remove 2 to reach MIN_MEMBERS (2)
    const remove = () =>
      screen.getAllByRole("button", {
        name: /remove member|cannot remove/i,
      })[0];

    fireEvent.click(remove());
    fireEvent.click(remove());

    const btns = screen.getAllByRole("button", { name: /cannot remove/i });
    expect(btns.length).toBeGreaterThan(0);
    btns.forEach((btn) =>
      expect(btn).toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("remove button accessible name mentions minimum when at minimum", () => {
    render(<CreateClient />);
    const remove = () =>
      screen.getAllByRole("button", {
        name: /remove member|cannot remove/i,
      })[0];

    fireEvent.click(remove());
    fireEvent.click(remove());

    const btns = screen.getAllByRole("button", { name: /cannot remove/i });
    btns.forEach((btn) => {
      expect(btn.getAttribute("aria-label")).toMatch(/at least \d+ member/i);
    });
  });
});

// ─── Reorder behaviour ────────────────────────────────────────────────────────

describe("Member list — reorder (move up / move down)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("move-down on first row swaps with second row", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveDownBtns = screen.getAllByRole("button", {
      name: /move member \d+ down/i,
    });
    fireEvent.click(moveDownBtns[0]);

    expect(getMemberValues()).toEqual([B, A, C, D]);
  });

  it("move-up on second row swaps with first row", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveUpBtns = screen.getAllByRole("button", {
      name: /move member \d+ up/i,
    });
    fireEvent.click(moveUpBtns[1]); // move member 2 up

    expect(getMemberValues()).toEqual([B, A, C, D]);
  });

  it("move-down on last row is disabled", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveDownBtns = screen.getAllByRole("button", {
      name: /move member \d+ down/i,
    });
    expect(moveDownBtns[moveDownBtns.length - 1]).toBeDisabled();
  });

  it("move-up on first row is disabled", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveUpBtns = screen.getAllByRole("button", {
      name: /move member \d+ up/i,
    });
    expect(moveUpBtns[0]).toBeDisabled();
  });

  it("moving a row to the bottom puts it last in the submitted order", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Move A down three times → [B, C, D, A]
    for (let i = 0; i < 3; i++) {
      const btn = screen.getAllByRole("button", {
        name: /move member 1 down/i,
      })[0];
      fireEvent.click(btn);
    }

    expect(getMemberValues()).toEqual([B, C, D, A]);
  });

  it("interleaved move-up and move-down produce the expected order", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Move C (position 3) up → [A, C, B, D]
    const moveUpBtns = () =>
      screen.getAllByRole("button", { name: /move member \d+ up/i });
    fireEvent.click(moveUpBtns()[2]);
    expect(getMemberValues()).toEqual([A, C, B, D]);

    // Move A (still position 1) down → [C, A, B, D]
    const moveDownBtns = () =>
      screen.getAllByRole("button", { name: /move member \d+ down/i });
    fireEvent.click(moveDownBtns()[0]);
    expect(getMemberValues()).toEqual([C, A, B, D]);
  });

  it("reorder does not lose values — all original addresses still present", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveDown = () =>
      screen.getAllByRole("button", { name: /move member \d+ down/i });

    fireEvent.click(moveDown()[0]);
    fireEvent.click(moveDown()[1]);
    fireEvent.click(moveDown()[0]);

    const vals = getMemberValues();
    expect(vals).toHaveLength(4);
    expect(vals).toContain(A);
    expect(vals).toContain(B);
    expect(vals).toContain(C);
    expect(vals).toContain(D);
  });
});

// ─── Editing after reorder ────────────────────────────────────────────────────

describe("Member list — editing after reorder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editing a value after a move updates the correct row", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Move row 1 (A) down → [B, A, C, D]
    const moveDown = screen.getAllByRole("button", {
      name: /move member 1 down/i,
    });
    fireEvent.click(moveDown[0]);

    // Edit position 2 (now holds A) to D
    const inputs = getMemberInputs();
    fireEvent.change(inputs[1], { target: { value: D } });

    expect(getMemberValues()).toEqual([B, D, C, D]);
  });

  it("editing row 1 after removing row 2 does not affect row 3's value", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Remove row 2 (value B) → [A, C, D]
    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[1]);

    // Edit position 1 (value A) to B
    const inputs = getMemberInputs();
    fireEvent.change(inputs[0], { target: { value: B } });

    expect(getMemberValues()).toEqual([B, C, D]);
  });
});

// ─── Accessible names ─────────────────────────────────────────────────────────

describe("Member list — accessible names", () => {
  beforeEach(() => vi.clearAllMocks());

  it("each address input has an accessible name including its position", () => {
    render(<CreateClient />);
    const inputs = getMemberInputs();
    expect(inputs.length).toBe(4);
    inputs.forEach((input, i) => {
      expect(input.getAttribute("aria-label")).toMatch(
        new RegExp(`member ${i + 1} of \\d+`, "i"),
      );
    });
  });

  it("each address input mentions payout position in its accessible name", () => {
    render(<CreateClient />);
    getMemberInputs().forEach((input, i) => {
      expect(input.getAttribute("aria-label")).toMatch(
        new RegExp(`payout position ${i + 1}`, "i"),
      );
    });
  });

  it("each move-up button has an accessible name with the member's position", () => {
    render(<CreateClient />);
    const upBtns = screen.getAllByRole("button", {
      name: /move member \d+ up/i,
    });
    expect(upBtns.length).toBe(4);
    upBtns.forEach((btn, i) => {
      expect(btn.getAttribute("aria-label")).toMatch(
        new RegExp(`move member ${i + 1} up`, "i"),
      );
    });
  });

  it("each move-down button has an accessible name with the member's position", () => {
    render(<CreateClient />);
    const downBtns = screen.getAllByRole("button", {
      name: /move member \d+ down/i,
    });
    expect(downBtns.length).toBe(4);
    downBtns.forEach((btn, i) => {
      expect(btn.getAttribute("aria-label")).toMatch(
        new RegExp(`move member ${i + 1} down`, "i"),
      );
    });
  });

  it("each remove button has an accessible name with the member's position", () => {
    render(<CreateClient />);
    const removeBtns = screen.getAllByRole("button", {
      name: /remove member \d+/i,
    });
    expect(removeBtns.length).toBe(4);
    removeBtns.forEach((btn, i) => {
      expect(btn.getAttribute("aria-label")).toMatch(
        new RegExp(`remove member ${i + 1}`, "i"),
      );
    });
  });

  it("accessible names update after adding a member", () => {
    render(<CreateClient />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add member/i }));
    const inputs = getMemberInputs();
    expect(inputs.length).toBe(5);
    expect(inputs[4].getAttribute("aria-label")).toMatch(/member 5 of 5/i);
  });

  it("accessible names update after removing a member", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const removeBtns = screen.getAllByRole("button", { name: /remove member \d+/i });
    fireEvent.click(removeBtns[1]);

    const inputs = getMemberInputs();
    expect(inputs.length).toBe(3);
    expect(inputs[0].getAttribute("aria-label")).toMatch(/member 1 of 3/i);
    expect(inputs[2].getAttribute("aria-label")).toMatch(/member 3 of 3/i);
  });

  it("member list container has an accessible label", () => {
    render(<CreateClient />);
    const list = screen.getByRole("list", {
      name: /member list — payout rotation order/i,
    });
    expect(list).toBeInTheDocument();
  });
});

// ─── Row key stability ────────────────────────────────────────────────────────

describe("Member list — row key stability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removing a row does not affect the DOM nodes of other rows", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Capture the DOM node for position 3 (value C) before the remove
    const cNode = getMemberInputs()[2]; // holds C

    // Remove row 2 (holds B)
    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[1]);

    // The same DOM node that held C should now be at position 2 and still hold C
    const afterInputs = getMemberInputs();
    expect(afterInputs[1]).toBe(cNode);
    expect((afterInputs[1] as HTMLInputElement).value).toBe(C);
  });

  it("moving a row does not create a new DOM node for it", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Capture the DOM node for position 2 (value B)
    const bNode = getMemberInputs()[1];

    // Move row 1 (A) down → B moves from position 2 to position 1
    const moveDown = screen.getAllByRole("button", {
      name: /move member 1 down/i,
    });
    fireEvent.click(moveDown[0]);

    // After move, position 1 should be B and it should be the SAME DOM node
    const afterInputs = getMemberInputs();
    expect(afterInputs[0]).toBe(bNode);
    expect((afterInputs[0] as HTMLInputElement).value).toBe(B);
  });
});
