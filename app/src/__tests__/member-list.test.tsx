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
 *                     — remove button has accessible name (including at-min state)
 *                     — address input has accessible name with position info
 *                     — editing a value after reorder updates the correct row
 *
 * Runner: vitest + @testing-library/react (jsdom, globals: true)
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import {
  reorderMembers,
  createMemberRow,
  type MemberRow,
} from "../app/create/CreateClient";

// ─── Mock heavy dependencies so the component renders without a real wallet ──

vi.mock("@/lib/stellar", () => ({
  getWalletAddress: vi.fn().mockResolvedValue(null),
  invokeContract:   vi.fn(),
  WalletError: class WalletError extends Error {
    constructor(public reason: string, message: string) {
      super(message);
      this.name = "WalletError";
    }
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    CIRCLE_FACTORY_ADDRESS: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    ACTIVE_NETWORK: "testnet",
    getExplorerLink: () => null,
  };
});

import CreateClient from "../app/create/CreateClient";

// ─── Address fixtures ─────────────────────────────────────────────────────────

const A = "G" + "A".repeat(55);
const B = "G" + "B".repeat(55);
const C = "G" + "C".repeat(55);
const D = "G" + "D".repeat(55);

// ─── reorderMembers ───────────────────────────────────────────────────────────

describe("reorderMembers()", () => {
  const arr = ["a", "b", "c", "d"];

  it("returns the array unchanged when fromIndex === toIndex", () => {
    expect(reorderMembers(arr, 1, 1)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns the original reference when fromIndex === toIndex", () => {
    expect(reorderMembers(arr, 2, 2)).toBe(arr);
  });

  it("returns original when fromIndex is out of range", () => {
    expect(reorderMembers(arr, -1, 0)).toBe(arr);
    expect(reorderMembers(arr, 4,  0)).toBe(arr);
  });

  it("returns original when toIndex is out of range", () => {
    expect(reorderMembers(arr, 0, -1)).toBe(arr);
    expect(reorderMembers(arr, 0,  4)).toBe(arr);
  });

  it("moves first element to last (move down through list)", () => {
    expect(reorderMembers(arr, 0, 3)).toEqual(["b", "c", "d", "a"]);
  });

  it("moves last element to first (move up through list)", () => {
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
    // Simulates: [A,B,C,D] → move D to 0 → [D,A,B,C] → move B to 3 → [D,A,C,B]
    const step1 = reorderMembers(arr, 3, 0);
    expect(step1).toEqual(["d", "a", "b", "c"]);
    const step2 = reorderMembers(step1, 2, 3);
    expect(step2).toEqual(["d", "a", "c", "b"]);
  });
});

// ─── createMemberRow ──────────────────────────────────────────────────────────

describe("createMemberRow()", () => {
  it("creates a row with an empty value by default", () => {
    const row = createMemberRow();
    expect(row.value).toBe("");
  });

  it("creates a row with the supplied value", () => {
    const row = createMemberRow(A);
    expect(row.value).toBe(A);
  });

  it("each call produces a unique id", () => {
    const ids = new Set(Array.from({ length: 20 }, () => createMemberRow().id));
    expect(ids.size).toBe(20);
  });

  it("id format is a non-empty string", () => {
    const row = createMemberRow();
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
  });
});

// ─── Component: helpers ───────────────────────────────────────────────────────

/**
 * Fill all four default member inputs with the given values and return the
 * live list of member address inputs.
 */
function fillMembers(values: string[]) {
  const inputs = screen.getAllByRole("textbox", {
    name: /member \d+ of \d+ — stellar address/i,
  });
  values.forEach((v, i) => {
    if (inputs[i]) fireEvent.change(inputs[i], { target: { value: v } });
  });
  return inputs;
}

/** Return current values of all member address inputs in DOM order. */
function getMemberValues(): string[] {
  return screen
    .getAllByRole("textbox", { name: /member \d+ of \d+ — stellar address/i })
    .map((el) => (el as HTMLInputElement).value);
}

// ─── Component: remove behaviour ─────────────────────────────────────────────

describe("Member list — remove", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removing a middle row never shifts another row's value into the wrong slot", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Remove row 2 (value B, 0-indexed position 1)
    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[1]); // removes member at position 2

    // Remaining values must be exactly [A, C, D] — B gone, no contamination
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

  it("remove button is visually disabled at minimum member count", () => {
    render(<CreateClient />);
    // Default starts with 4 rows; remove down to 2 (MIN_MEMBERS)
    const remove = () =>
      screen.getAllByRole("button", { name: /remove member|cannot remove/i })[0];

    fireEvent.click(remove());
    fireEvent.click(remove());
    // Now at MIN_MEMBERS — button should be aria-disabled
    const btns = screen.getAllByRole("button", { name: /cannot remove/i });
    expect(btns.length).toBeGreaterThan(0);
    btns.forEach((btn) => expect(btn).toHaveAttribute("aria-disabled", "true"));
  });

  it("remove button accessible name mentions minimum when at minimum", () => {
    render(<CreateClient />);
    const remove = () =>
      screen.getAllByRole("button", { name: /remove member|cannot remove/i })[0];

    fireEvent.click(remove());
    fireEvent.click(remove());

    const btns = screen.getAllByRole("button", { name: /cannot remove/i });
    btns.forEach((btn) => {
      expect(btn.getAttribute("aria-label")).toMatch(/at least \d+ member/i);
    });
  });
});

// ─── Component: reorder behaviour ────────────────────────────────────────────

describe("Member list — reorder (move up / move down)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("move-down on first row swaps with second row", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // "Move member 1 down"
    const moveDownBtns = screen.getAllByRole("button", { name: /move member \d+ down/i });
    fireEvent.click(moveDownBtns[0]);

    expect(getMemberValues()).toEqual([B, A, C, D]);
  });

  it("move-up on second row swaps with first row", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveUpBtns = screen.getAllByRole("button", { name: /move member \d+ up/i });
    fireEvent.click(moveUpBtns[1]); // move member 2 up

    expect(getMemberValues()).toEqual([B, A, C, D]);
  });

  it("move-down on last row is disabled", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveDownBtns = screen.getAllByRole("button", { name: /move member \d+ down/i });
    const last = moveDownBtns[moveDownBtns.length - 1];
    expect(last).toBeDisabled();
  });

  it("move-up on first row is disabled", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveUpBtns = screen.getAllByRole("button", { name: /move member \d+ up/i });
    expect(moveUpBtns[0]).toBeDisabled();
  });

  it("moving a row to the bottom puts it last in the submitted order", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Move row 0 (A) down three times → A should end up at position 3
    const getFirst = () =>
      screen.getAllByRole("button", { name: /move member 1 down/i })[0];

    fireEvent.click(getFirst()); // [B, A, C, D]
    fireEvent.click(getFirst()); // [B, C, A, D]
    fireEvent.click(getFirst()); // [B, C, D, A]

    expect(getMemberValues()).toEqual([B, C, D, A]);
  });

  it("interleaved move-up and move-down produce the expected order", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Move C (position 3) up to position 1: [A, C, B, D]
    const moveUp = () =>
      screen.getAllByRole("button", { name: /move member \d+ up/i });

    fireEvent.click(moveUp()[2]); // move position 3 up → [A, B, C, D] → C,B swap: [A, C, B, D]

    expect(getMemberValues()).toEqual([A, C, B, D]);

    // Move A (still position 1) down to position 2: [C, A, B, D]
    const moveDown = () =>
      screen.getAllByRole("button", { name: /move member \d+ down/i });

    fireEvent.click(moveDown()[0]); // move position 1 down

    expect(getMemberValues()).toEqual([C, A, B, D]);
  });

  it("reorder does not lose values — all original addresses still present", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const moveDownBtns = () =>
      screen.getAllByRole("button", { name: /move member \d+ down/i });

    // Arbitrary sequence of moves
    fireEvent.click(moveDownBtns()[0]);
    fireEvent.click(moveDownBtns()[1]);
    fireEvent.click(moveDownBtns()[0]);

    const vals = getMemberValues();
    expect(vals).toHaveLength(4);
    expect(vals).toContain(A);
    expect(vals).toContain(B);
    expect(vals).toContain(C);
    expect(vals).toContain(D);
  });
});

// ─── Component: editing after reorder ────────────────────────────────────────

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

    // Now edit position 2 (which is A)
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    fireEvent.change(inputs[1], { target: { value: D } });

    // Position 1 = B (unchanged), position 2 = D (edited from A), rest intact
    expect(getMemberValues()).toEqual([B, D, C, D]);
  });

  it("editing row 1 after removing row 2 does not affect row 3's value", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Remove row 2 (value B) → [A, C, D]
    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[1]);

    // Edit position 1 (value A) to something new
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    fireEvent.change(inputs[0], { target: { value: B } });

    // Row 1 = B (edited), row 2 = C (was row 3 before remove — untouched), row 3 = D
    expect(getMemberValues()).toEqual([B, C, D]);
  });
});

// ─── Component: accessible names ─────────────────────────────────────────────

describe("Member list — accessible names", () => {
  beforeEach(() => vi.clearAllMocks());

  it("each address input has an accessible name that includes its position", () => {
    render(<CreateClient />);
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    // Default renders 4 rows
    expect(inputs.length).toBe(4);
    inputs.forEach((input, i) => {
      const label = input.getAttribute("aria-label") ?? "";
      expect(label).toMatch(new RegExp(`member ${i + 1} of \\d+`, "i"));
    });
  });

  it("each address input mentions payout position in its accessible name", () => {
    render(<CreateClient />);
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    inputs.forEach((input, i) => {
      expect(input.getAttribute("aria-label")).toMatch(
        new RegExp(`payout position ${i + 1}`, "i"),
      );
    });
  });

  it("each move-up button has an accessible name with the member's position", () => {
    render(<CreateClient />);
    const upBtns = screen.getAllByRole("button", { name: /move member \d+ up/i });
    expect(upBtns.length).toBe(4);
    upBtns.forEach((btn, i) => {
      expect(btn.getAttribute("aria-label")).toMatch(
        new RegExp(`move member ${i + 1} up`, "i"),
      );
    });
  });

  it("each move-down button has an accessible name with the member's position", () => {
    render(<CreateClient />);
    const downBtns = screen.getAllByRole("button", { name: /move member \d+ down/i });
    expect(downBtns.length).toBe(4);
    downBtns.forEach((btn, i) => {
      expect(btn.getAttribute("aria-label")).toMatch(
        new RegExp(`move member ${i + 1} down`, "i"),
      );
    });
  });

  it("each remove button has an accessible name with the member's position", () => {
    render(<CreateClient />);
    // At 4 rows (> MIN_MEMBERS) all remove buttons show the position name
    const removeBtns = screen.getAllByRole("button", { name: /remove member \d+/i });
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
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    expect(inputs.length).toBe(5);
    // Last input should say "member 5 of 5"
    expect(inputs[4].getAttribute("aria-label")).toMatch(/member 5 of 5/i);
  });

  it("accessible names update after removing a member", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Remove middle row → 3 rows remain, positions should be 1-of-3, 2-of-3, 3-of-3
    const removeBtns = screen.getAllByRole("button", { name: /remove member \d+/i });
    fireEvent.click(removeBtns[1]);

    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
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

// ─── Component: row identity (key stability) ──────────────────────────────────

describe("Member list — row key stability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removing a row does not affect the DOM nodes of other rows", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Capture the DOM node for position 3 (value C) before the remove
    const beforeInputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    const cNode = beforeInputs[2]; // currently holds C

    // Remove row 2 (holds B)
    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[1]);

    // After remove, "C" should now be at position 2
    const afterInputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });

    // The same DOM node that held C should still hold C (not recycled)
    expect(afterInputs[1]).toBe(cNode);
    expect((afterInputs[1] as HTMLInputElement).value).toBe(C);
  });

  it("moving a row does not create a new DOM node for it", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Capture the DOM node for position 2 (value B)
    const beforeInputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    const bNode = beforeInputs[1];

    // Move row 1 (A) down → B moves from position 2 to position 1
    const moveDown = screen.getAllByRole("button", { name: /move member 1 down/i });
    fireEvent.click(moveDown[0]);

    // After move, position 1 should be B, and it should be the SAME DOM node
    const afterInputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    expect(afterInputs[0]).toBe(bNode);
    expect((afterInputs[0] as HTMLInputElement).value).toBe(B);
  });
});
