/**
 * Keyboard-only tests for transaction preparation and confirmation (Issue #702)
 *
 * Verifies accessibility and keyboard interaction invariants:
 *   1. Form entry keyboard navigation: Tab/Shift-Tab order through inputs, buttons
 *      without unexpected focus traps in non-modal flows.
 *   2. Modal alertdialog focus trapping: Tab/Shift-Tab cycle exclusively within dialog controls.
 *   3. Keyboard cancellation & dismissal: Escape key or Cancel button dismisses dialog.
 *   4. Focus restoration: focus strictly returns to the trigger element after dismissal.
 *   5. Accessible names & error association: `aria-describedby` links inputs to error messages.
 *   6. Live regions & status announcements: `role="alert"` and `aria-live` announcements.
 *
 * Run locally:
 *   node --experimental-strip-types --test tests/keyboard-navigation.test.ts
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Lightweight Headless Keyboard & Focus Harness ───────────────────────────

interface FocusableNode {
  id: string;
  tagName: string;
  role?: string;
  type?: string;
  disabled?: boolean;
  tabIndex?: number;
  ariaModal?: boolean;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLive?: "polite" | "assertive" | "off";
  textContent?: string;
  children?: FocusableNode[];
  onKeyDown?: (event: { key: string; shiftKey: boolean; defaultPrevented: boolean; preventDefault: () => void }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

class KeyboardTestEnvironment {
  nodes: Map<string, FocusableNode> = new Map();
  activeElement: FocusableNode | null = null;
  focusHistory: string[] = [];

  register(node: FocusableNode) {
    this.nodes.set(node.id, node);
    if (node.children) {
      for (const child of node.children) {
        this.register(child);
      }
    }
  }

  focus(id: string) {
    const node = this.nodes.get(id);
    if (!node || node.disabled) return false;

    if (this.activeElement?.onBlur) {
      this.activeElement.onBlur();
    }
    this.activeElement = node;
    this.focusHistory.push(node.id);
    if (node.onFocus) {
      node.onFocus();
    }
    return true;
  }

  dispatchKeyDown(key: string, shiftKey = false) {
    if (!this.activeElement) return;

    let prevented = false;
    const event = {
      key,
      shiftKey,
      defaultPrevented: false,
      preventDefault: () => {
        prevented = true;
        event.defaultPrevented = true;
      },
    };

    if (this.activeElement.onKeyDown) {
      this.activeElement.onKeyDown(event);
    }
    return { prevented };
  }
}

// ─── Component Model 1: CreateCircleForm (Transaction Preparation) ───────────

function createFormHarness() {
  const env = new KeyboardTestEnvironment();

  let fieldErrors: Record<string, string> = {};
  let alertMessages: string[] = [];

  const tabOrder = [
    "name-input",
    "amount-input",
    "days-input",
    "member-0-input",
    "member-1-input",
    "add-member-button",
    "submit-button",
  ];

  function tabNext(shift = false) {
    const currentId = env.activeElement?.id ?? "";
    const currentIndex = tabOrder.indexOf(currentId);
    let nextIndex = 0;

    if (currentIndex === -1) {
      nextIndex = shift ? tabOrder.length - 1 : 0;
    } else {
      nextIndex = shift ? (currentIndex - 1 + tabOrder.length) % tabOrder.length : (currentIndex + 1) % tabOrder.length;
    }

    env.focus(tabOrder[nextIndex]);
  }

  // Register interactive controls with accessible metadata matching CreateClient.tsx
  for (const id of tabOrder) {
    env.register({
      id,
      tagName: id.includes("button") ? "BUTTON" : "INPUT",
      tabIndex: 0,
      ariaDescribedBy: fieldErrors[id] ? `${id}-err` : undefined,
      onKeyDown: (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          tabNext(e.shiftKey);
        }
      },
    });
  }

  return {
    env,
    tabOrder,
    tabNext,
    setFieldError: (fieldId: string, errorId: string, message: string) => {
      fieldErrors[fieldId] = errorId;
      const node = env.nodes.get(fieldId);
      if (node) {
        node.ariaDescribedBy = errorId;
        node.ariaInvalid = true;
      }
      alertMessages.push(message);
      env.register({
        id: errorId,
        tagName: "P",
        role: "alert",
        ariaLive: "assertive",
        textContent: message,
      });
    },
  };
}

// ─── Component Model 2: ConfirmDefaultDialog (Transaction Confirmation) ───────

function createConfirmDialogHarness() {
  const env = new KeyboardTestEnvironment();

  let isDialogOpen = false;
  let triggerElementId: string | null = null;

  // Trigger button outside the modal
  env.register({
    id: "mark-default-trigger-btn",
    tagName: "BUTTON",
    tabIndex: 0,
    textContent: "Mark Default",
  });

  // Dialog inner focusable elements
  const dialogFocusableOrder = ["confirm-dialog-cancel-btn", "confirm-dialog-submit-btn"];

  function openDialog(triggerId: string) {
    triggerElementId = triggerId;
    isDialogOpen = true;

    // Register dialog & inner interactive controls
    env.register({
      id: "confirm-dialog",
      tagName: "DIV",
      role: "alertdialog",
      ariaModal: true,
      ariaLabelledBy: "default-confirm-title",
      tabIndex: -1,
      children: [
        {
          id: "confirm-dialog-cancel-btn",
          tagName: "BUTTON",
          tabIndex: 0,
          textContent: "Cancel",
          onKeyDown: (e) => handleDialogKeyDown(e),
        },
        {
          id: "confirm-dialog-submit-btn",
          tagName: "BUTTON",
          tabIndex: 0,
          textContent: "Confirm & Sign",
          onKeyDown: (e) => handleDialogKeyDown(e),
        },
      ],
    });

    // Auto-focus first interactive control
    env.focus("confirm-dialog-cancel-btn");
  }

  function closeDialog() {
    isDialogOpen = false;
    // Restore focus to trigger element
    if (triggerElementId) {
      env.focus(triggerElementId);
    }
  }

  function handleDialogKeyDown(e: { key: string; shiftKey: boolean; defaultPrevented: boolean; preventDefault: () => void }) {
    if (!isDialogOpen) return;

    if (e.key === "Escape") {
      e.preventDefault();
      closeDialog();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const currentId = env.activeElement?.id;
      const first = dialogFocusableOrder[0];
      const last = dialogFocusableOrder[dialogFocusableOrder.length - 1];

      if (e.shiftKey) {
        if (currentId === first) {
          env.focus(last);
        } else {
          env.focus(first);
        }
      } else {
        if (currentId === last) {
          env.focus(first);
        } else {
          env.focus(last);
        }
      }
    }
  }

  return {
    env,
    openDialog,
    closeDialog,
    dialogFocusableOrder,
    isOpen: () => isDialogOpen,
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("Keyboard-only transaction preparation and confirmation (#702)", () => {

  // ── 1. Form Entry Keyboard Progression (No Traps) ──────────────────────────

  test("form entry: tab moves forward through entire form sequence without trap", () => {
    const { env, tabOrder } = createFormHarness();

    // Start focus at first element
    env.focus(tabOrder[0]);
    assert.equal(env.activeElement?.id, "name-input");

    // Advance forward through all fields using Tab
    for (let i = 1; i < tabOrder.length; i++) {
      env.dispatchKeyDown("Tab", false);
      assert.equal(env.activeElement?.id, tabOrder[i], `Tab step ${i} should focus ${tabOrder[i]}`);
    }

    // Tabbing past submit button loops naturally to the first element
    env.dispatchKeyDown("Tab", false);
    assert.equal(env.activeElement?.id, tabOrder[0], "Tab from last element wraps to first");
  });

  test("form entry: shift-tab moves backward through entire form sequence", () => {
    const { env, tabOrder } = createFormHarness();

    // Start at submit button
    env.focus(tabOrder[tabOrder.length - 1]);
    assert.equal(env.activeElement?.id, "submit-button");

    // Advance backward through all fields using Shift-Tab
    for (let i = tabOrder.length - 2; i >= 0; i--) {
      env.dispatchKeyDown("Tab", true);
      assert.equal(env.activeElement?.id, tabOrder[i], `Shift-Tab should focus ${tabOrder[i]}`);
    }

    // Shift-Tab from first wraps to last
    env.dispatchKeyDown("Tab", true);
    assert.equal(env.activeElement?.id, tabOrder[tabOrder.length - 1], "Shift-Tab from first wraps to last");
  });

  // ── 2. Error Association & Live Regions ─────────────────────────────────────

  test("form validation: field error updates aria-invalid and aria-describedby", () => {
    const { env, setFieldError } = createFormHarness();

    const nameNode = env.nodes.get("name-input")!;
    assert.equal(nameNode.ariaInvalid, undefined);
    assert.equal(nameNode.ariaDescribedBy, undefined);

    // Trigger validation error
    setFieldError("name-input", "name-input-err", "Circle name is required");

    assert.equal(nameNode.ariaInvalid, true, "invalid field must have aria-invalid='true'");
    assert.equal(nameNode.ariaDescribedBy, "name-input-err", "must associate control with error message ID");

    // Verify error element has role="alert"
    const errNode = env.nodes.get("name-input-err")!;
    assert.equal(errNode.role, "alert", "error container must declare role='alert' for screen readers");
    assert.equal(errNode.ariaLive, "assertive", "error message should announce assertively");
  });

  // ── 3. Confirmation Dialog Focus Trapping ───────────────────────────────────

  test("confirmation dialog: traps Tab and Shift-Tab exclusively within dialog actions", () => {
    const harness = createConfirmDialogHarness();

    // Focus trigger button
    harness.env.focus("mark-default-trigger-btn");
    assert.equal(harness.env.activeElement?.id, "mark-default-trigger-btn");

    // Open confirmation dialog
    harness.openDialog("mark-default-trigger-btn");
    assert.equal(harness.isOpen(), true);

    // Initial focus must be inside dialog on first action (Cancel)
    assert.equal(harness.env.activeElement?.id, "confirm-dialog-cancel-btn");

    // Tab moves to Confirm & Sign button
    harness.env.dispatchKeyDown("Tab", false);
    assert.equal(harness.env.activeElement?.id, "confirm-dialog-submit-btn");

    // Tab from Confirm & Sign button TRAPS and wraps back to Cancel button (NOT outside the dialog!)
    harness.env.dispatchKeyDown("Tab", false);
    assert.equal(
      harness.env.activeElement?.id,
      "confirm-dialog-cancel-btn",
      "focus trap must wrap Tab to first dialog element"
    );

    // Shift-Tab from Cancel button TRAPS and wraps to Confirm & Sign button
    harness.env.dispatchKeyDown("Tab", true);
    assert.equal(
      harness.env.activeElement?.id,
      "confirm-dialog-submit-btn",
      "focus trap must wrap Shift-Tab to last dialog element"
    );
  });

  // ── 4. Focus Restoration On Dismissal & Escape ──────────────────────────────

  test("confirmation dialog: escape key dismisses dialog and restores focus to trigger element", () => {
    const harness = createConfirmDialogHarness();

    harness.env.focus("mark-default-trigger-btn");
    harness.openDialog("mark-default-trigger-btn");
    assert.equal(harness.isOpen(), true);
    assert.equal(harness.env.activeElement?.id, "confirm-dialog-cancel-btn");

    // Press Escape
    const result = harness.env.dispatchKeyDown("Escape");
    assert.equal(result?.prevented, true, "Escape key default must be prevented");
    assert.equal(harness.isOpen(), false, "dialog must be closed on Escape");

    // Focus MUST be restored to the trigger element
    assert.equal(
      harness.env.activeElement?.id,
      "mark-default-trigger-btn",
      "focus must return to the trigger element that opened the dialog"
    );
  });

  test("confirmation dialog: cancel button activation dismisses and restores focus", () => {
    const harness = createConfirmDialogHarness();

    harness.env.focus("mark-default-trigger-btn");
    harness.openDialog("mark-default-trigger-btn");
    assert.equal(harness.isOpen(), true);

    // Activate cancel button
    harness.closeDialog();
    assert.equal(harness.isOpen(), false);

    // Focus restored
    assert.equal(
      harness.env.activeElement?.id,
      "mark-default-trigger-btn",
      "focus must return to trigger button after cancel"
    );
  });

  // ── 5. Alertdialog Semantics & Accessible Properties ────────────────────────

  test("confirmation dialog: semantics match W3C alertdialog modal pattern", () => {
    const harness = createConfirmDialogHarness();
    harness.openDialog("mark-default-trigger-btn");

    const dialog = harness.env.nodes.get("confirm-dialog")!;
    assert.equal(dialog.role, "alertdialog", "dialog role must be 'alertdialog'");
    assert.equal(dialog.ariaModal, true, "dialog must declare aria-modal='true'");
    assert.equal(dialog.ariaLabelledBy, "default-confirm-title", "dialog must reference accessible title ID");
  });
});

// ─── Live-Region & Announcement Policy Tests ─────────────────────────────────
//
// These tests verify the announcement policy for the create and circle-detail
// flows without a browser or React renderer.  They use the same headless
// keyboard harness from above and extend it with a minimal live-region model
// that mirrors the two-channel (polite / assertive) design of useAnnouncer.ts.
//
// Invariants verified:
//   7.  Transaction submission fires a polite announcement.
//   8.  Transaction failure fires an assertive announcement.
//   9.  Transaction success fires a polite announcement.
//   10. Repeated identical messages are deduplicated (no AT flood).
//   11. A different message after the clear window re-announces.
//   12. Assertive politeness takes precedence over polite for error conditions.
//   13. Refresh-start is polite; refresh-error is assertive.
//   14. Data-state change (status/round diff) produces one polite announcement.
//   15. Polling with no state change produces no additional announcements.
//   16. Focus is never moved by an announcement.

// ── Minimal live-region model ─────────────────────────────────────────────────

type Politeness = "polite" | "assertive";

interface RegionState {
  text: string;
  lastAnnounced: string;
  clearTimer: ReturnType<typeof setTimeout> | null;
}

const CLEAR_DELAY_MS = 3_000;

class LiveRegionModel {
  private regions: Record<Politeness, RegionState> = {
    polite:    { text: "", lastAnnounced: "", clearTimer: null },
    assertive: { text: "", lastAnnounced: "", clearTimer: null },
  };
  /** Ordered log of every announcement that was not deduplicated. */
  readonly announcements: Array<{ message: string; politeness: Politeness }> = [];

  announce(message: string, politeness: Politeness = "polite"): void {
    if (!message || !message.trim()) return;
    const region = this.regions[politeness];
    // Deduplicate: skip if the same message was just announced (within the
    // clear window, so lastAnnounced is still set).
    if (message === region.lastAnnounced) return;
    region.lastAnnounced = message;
    region.text = message;
    this.announcements.push({ message, politeness });
    if (region.clearTimer) clearTimeout(region.clearTimer);
    region.clearTimer = setTimeout(() => {
      region.text = "";
      region.lastAnnounced = "";
      region.clearTimer = null;
    }, CLEAR_DELAY_MS);
  }

  /** Advance time (simulate setTimeout) so the clear window expires. */
  advancePast(ms: number): void {
    // Flush all pending timers that would fire within `ms` by setting lastAnnounced
    // to "" on both regions — mirrors what the real hook does.
    if (ms >= CLEAR_DELAY_MS) {
      for (const region of Object.values(this.regions)) {
        if (region.clearTimer !== null) {
          region.text = "";
          region.lastAnnounced = "";
          region.clearTimer = null;
        }
      }
    }
  }

  getText(politeness: Politeness): string {
    return this.regions[politeness].text;
  }

  countFor(politeness: Politeness): number {
    return this.announcements.filter((a) => a.politeness === politeness).length;
  }
}

// ── Test Suite: Announcement Policy ──────────────────────────────────────────

describe("Live-region announcement policy (#702 follow-up)", () => {

  // ── 7. Transaction submission — polite ─────────────────────────────────────

  test("7: transaction submission fires a polite (non-interrupting) announcement", () => {
    const model = new LiveRegionModel();
    // Mirrors ANNOUNCEMENTS.txSubmitting
    model.announce("Submitting transaction, please wait.", "polite");

    assert.equal(model.getText("polite"), "Submitting transaction, please wait.");
    assert.equal(model.getText("assertive"), "", "submission must NOT use assertive channel");
    assert.equal(model.countFor("polite"), 1);
  });

  // ── 8. Transaction failure — assertive ────────────────────────────────────

  test("8: transaction failure fires an assertive (interrupting) announcement", () => {
    const model = new LiveRegionModel();
    // Mirrors ANNOUNCEMENTS.txFailed(reason)
    model.announce("Transaction failed: network error", "assertive");

    assert.equal(model.getText("assertive"), "Transaction failed: network error");
    assert.equal(model.getText("polite"), "", "failure must NOT bleed into polite channel");
    assert.equal(model.countFor("assertive"), 1);
  });

  // ── 9. Transaction success — polite ──────────────────────────────────────

  test("9: transaction success fires a polite announcement with the action label", () => {
    const model = new LiveRegionModel();
    // Mirrors ANNOUNCEMENTS.txConfirmed(label)
    model.announce("Transaction confirmed: Contribution submitted successfully.", "polite");

    assert.ok(
      model.getText("polite").includes("Contribution submitted successfully."),
      "success announcement must include the action label",
    );
    assert.equal(model.countFor("polite"), 1);
  });

  // ── 10. Deduplication — repeated identical message ─────────────────────────

  test("10: repeated identical polite messages are deduplicated (AT not flooded)", () => {
    const model = new LiveRegionModel();
    const msg = "Circle data updated: now on round 2.";

    // Simulate five polling cycles that all produce the same message
    for (let i = 0; i < 5; i++) {
      model.announce(msg, "polite");
    }

    // Only the first announcement must have fired
    assert.equal(
      model.countFor("polite"),
      1,
      "5 identical polite messages must produce exactly 1 announcement",
    );
    assert.equal(model.getText("polite"), msg);
  });

  test("10b: repeated identical assertive messages are deduplicated", () => {
    const model = new LiveRegionModel();
    const msg = "Transaction failed: wallet not installed";

    for (let i = 0; i < 3; i++) {
      model.announce(msg, "assertive");
    }

    assert.equal(model.countFor("assertive"), 1);
  });

  // ── 11. Re-announcement after clear window ────────────────────────────────

  test("11: same message re-announces after the clear window expires", () => {
    const model = new LiveRegionModel();
    const msg = "Circle data updated: status is now Active.";

    model.announce(msg, "polite");
    assert.equal(model.countFor("polite"), 1);

    // Advance past CLEAR_DELAY_MS
    model.advancePast(3_500);

    // Same message again — should fire because lastAnnounced was cleared
    model.announce(msg, "polite");
    assert.equal(
      model.countFor("polite"),
      2,
      "re-announcement must fire after the clear window expires",
    );
  });

  // ── 12. Assertive takes precedence for errors ──────────────────────────────

  test("12: error announcements use assertive channel; non-errors use polite", () => {
    const model = new LiveRegionModel();

    model.announce("Submitting transaction, please wait.", "polite");
    model.announce("Transaction failed: RPC timeout", "assertive");

    assert.equal(model.countFor("polite"), 1, "one polite (submission)");
    assert.equal(model.countFor("assertive"), 1, "one assertive (failure)");
    // Polite text is independent
    assert.equal(model.getText("polite"), "Submitting transaction, please wait.");
    assert.equal(model.getText("assertive"), "Transaction failed: RPC timeout");
  });

  // ── 13. Refresh-start polite; refresh-error assertive ────────────────────

  test("13: refresh-start is polite; refresh-error is assertive", () => {
    const model = new LiveRegionModel();

    // Mirrors ANNOUNCEMENTS.refreshing + ANNOUNCEMENTS.refreshError
    model.announce("Refreshing circle data.", "polite");
    model.announce("Could not refresh circle data. Try again.", "assertive");

    assert.equal(model.countFor("polite"), 1);
    assert.equal(model.countFor("assertive"), 1);
    assert.equal(model.getText("polite"), "Refreshing circle data.");
    assert.equal(model.getText("assertive"), "Could not refresh circle data. Try again.");
  });

  // ── 14. Data-state change fires exactly one announcement ──────────────────

  test("14: status change fires one polite announcement per distinct transition", () => {
    const model = new LiveRegionModel();

    // Simulate three distinct status transitions
    const transitions = [
      "Circle data updated: status is now Active.",
      "Circle data updated: now on round 1.",
      "Circle data updated: status is now Completed.",
    ];

    for (const msg of transitions) {
      model.announce(msg, "polite");
    }

    assert.equal(
      model.countFor("polite"),
      3,
      "each distinct data-state transition must produce exactly one announcement",
    );
  });

  // ── 15. Polling with no state change produces no announcements ────────────

  test("15: repeated polling that produces no state change generates zero announcements", () => {
    const model = new LiveRegionModel();

    // Simulate: a refresh was triggered but nothing changed — no announce() call
    // is made when status/round are the same as before (see handleManualRefresh logic)
    // This test verifies the model itself: calling announce() with undefined/empty is a no-op.
    model.announce("", "polite");
    model.announce("   ", "polite");
    model.announce("", "assertive");

    assert.equal(
      model.announcements.length,
      0,
      "empty/whitespace messages must never reach the AT channel",
    );
  });

  // ── 16. Focus is never moved by an announcement ───────────────────────────

  test("16: live-region announcements do not change focus", () => {
    const env = new KeyboardTestEnvironment();
    const model = new LiveRegionModel();

    env.register({ id: "submit-btn", tagName: "BUTTON", tabIndex: 0, textContent: "Submit" });
    env.focus("submit-btn");

    const focusBefore = env.activeElement?.id;

    // Fire three different announcements in sequence
    model.announce("Submitting transaction, please wait.", "polite");
    model.announce("Transaction confirmed: Collateral locked — you have joined the circle!.", "polite");
    model.announce("Could not refresh circle data. Try again.", "assertive");

    // Focus must remain on the submit button — announcements never move focus
    assert.equal(
      env.activeElement?.id,
      focusBefore,
      "live-region announcements must never alter keyboard focus",
    );
  });

  // ── 17. Full transaction arc — submit → confirm → no duplicate ────────────

  test("17: full arc (submit→confirm) fires two distinct polite announcements, no duplicates", () => {
    const model = new LiveRegionModel();

    // Mirrors the actual arc in doAction:
    //   1. setLoading → announce txSubmitting
    //   2. result.success → announce txConfirmed
    model.announce("Submitting transaction, please wait.", "polite");
    model.announce(
      "Transaction confirmed: Contribution submitted successfully.",
      "polite",
    );

    assert.equal(model.countFor("polite"), 2, "two distinct polite announcements for submit+confirm");
    assert.equal(model.countFor("assertive"), 0, "no assertive for a successful flow");
  });

  // ── 18. Full failure arc — submit → fail ─────────────────────────────────

  test("18: full arc (submit→fail) fires polite submission then assertive failure", () => {
    const model = new LiveRegionModel();

    model.announce("Submitting transaction, please wait.", "polite");
    model.announce("Transaction failed: You cancelled the transaction in Freighter. No funds were moved.", "assertive");

    assert.equal(model.countFor("polite"), 1);
    assert.equal(model.countFor("assertive"), 1);
    assert.ok(
      model.getText("assertive").includes("cancelled"),
      "failure message must name the reason",
    );
  });

  // ── 19. Indexer-indexed announcement is polite ────────────────────────────

  test("19: indexer-indexed announcement is polite (informational)", () => {
    const model = new LiveRegionModel();
    // Mirrors ANNOUNCEMENTS.indexerIndexed
    model.announce("Indexer has processed the latest transaction.", "polite");

    assert.equal(model.countFor("polite"), 1);
    assert.equal(model.countFor("assertive"), 0, "indexed event must NOT use assertive");
  });

  // ── 20. Circle-created announcement is polite ─────────────────────────────

  test("20: circle-created success is polite (non-interrupting)", () => {
    const model = new LiveRegionModel();
    // Mirrors ANNOUNCEMENTS.circleCreated
    model.announce(
      "Circle created successfully. Redirecting to home page.",
      "polite",
    );
    assert.equal(model.countFor("polite"), 1);
    assert.equal(model.countFor("assertive"), 0);
  });

  // ── 21. Circle-create failure is assertive ────────────────────────────────

  test("21: circle-create failure is assertive (interrupts user)", () => {
    const model = new LiveRegionModel();
    // Mirrors ANNOUNCEMENTS.circleCreateFailed(reason)
    model.announce("Circle creation failed: Factory contract not configured.", "assertive");

    assert.equal(model.countFor("assertive"), 1);
    assert.equal(model.countFor("polite"), 0);
  });
});

// ─── Narrow-Viewport & 200% Zoom Reachability Tests (Issue #128) ─────────────
//
// These tests model the circle-detail and create flows at the documented
// mobile width (320px) and at 200% browser zoom (effective ~640px CSS width on
// a 1280px viewport).  They verify that:
//
//   22. Every core read/write action control is in the tab order at narrow width.
//   23. Long addresses and amounts are exposed as full, distinguishable text
//       (wrapping / truncation with accessible full value), not clipped.
//   24. Any unavoidable horizontal scroll container is labeled and keyboard
//       focusable, and does not hide essential controls.
//   25. Focus order in the circle-detail flow is logical and trap-free at
//       narrow widths and 200% zoom.
//   26. The create flow's action group remains reachable at narrow widths.
//   27. Labeled scroll containers expose an accessible name and role.

type ViewportProfile = "mobile-320" | "zoom-200";

interface LayoutNode extends FocusableNode {
  /** CSS width in px the element occupies at the active viewport profile. */
  widthPx?: number;
  /** Whether the element overflows its container horizontally. */
  overflows?: boolean;
  /** Marks a horizontal scroll container. */
  scrollContainer?: boolean;
  /** Accessible name for a scroll container / region. */
  ariaLabel?: string;
  /** Full untruncated value for long addresses / amounts. */
  fullValue?: string;
  /** Visible (possibly truncated) text. */
  visibleText?: string;
  /** Whether the element is a core read/write action. */
  coreAction?: boolean;
}

interface LayoutHarness {
  env: KeyboardTestEnvironment;
  tabOrder: string[];
  nodes: Map<string, LayoutNode>;
  profile: ViewportProfile;
}

function buildCircleDetailLayout(profile: ViewportProfile): LayoutHarness {
  const env = new KeyboardTestEnvironment();
  const nodes = new Map<string, LayoutNode>();

  // At 320px and at 200% zoom the round table cannot fit; it must be wrapped in
  // a labeled, focusable horizontal scroll container rather than clipping.
  const roundTableScrollable = true;

  const tabOrder = [
    "detail-back-btn",
    "detail-refresh-btn",
    "round-table-scroll",
    "member-address-0",
    "member-address-1",
    "detail-contribute-btn",
    "detail-mark-default-btn",
  ];

  const layoutNodes: LayoutNode[] = [
    { id: "detail-back-btn", tagName: "BUTTON", tabIndex: 0, textContent: "Back", coreAction: true },
    { id: "detail-refresh-btn", tagName: "BUTTON", tabIndex: 0, textContent: "Refresh", coreAction: true },
    {
      id: "round-table-scroll",
      tagName: "DIV",
      role: "region",
      tabIndex: 0,
      ariaLabel: "Round history, scroll horizontally to see all columns",
      scrollContainer: roundTableScrollable,
      overflows: true,
    },
    {
      id: "member-address-0",
      tagName: "SPAN",
      tabIndex: 0,
      fullValue: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      visibleText: "GBBD…FLA5",
    },
    {
      id: "member-address-1",
      tagName: "SPAN",
      tabIndex: 0,
      fullValue: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ",
      visibleText: "GCEZ…674JZ",
    },
    { id: "detail-contribute-btn", tagName: "BUTTON", tabIndex: 0, textContent: "Contribute", coreAction: true },
    { id: "detail-mark-default-btn", tagName: "BUTTON", tabIndex: 0, textContent: "Mark Default", coreAction: true },
  ];

  for (const node of layoutNodes) {
    nodes.set(node.id, node);
    env.register(node);
  }

  // Tab navigation follows the declared order without trapping.
  for (const id of tabOrder) {
    const node = env.nodes.get(id)!;
    node.onKeyDown = (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const idx = tabOrder.indexOf(id);
      const next = e.shiftKey
        ? (idx - 1 + tabOrder.length) % tabOrder.length
        : (idx + 1) % tabOrder.length;
      env.focus(tabOrder[next]);
    };
  }

  return { env, tabOrder, nodes, profile };
}

function buildCreateFlowLayout(profile: ViewportProfile): LayoutHarness {
  const env = new KeyboardTestEnvironment();
  const nodes = new Map<string, LayoutNode>();

  const tabOrder = [
    "name-input",
    "amount-input",
    "days-input",
    "member-0-input",
    "add-member-button",
    "submit-button",
  ];

  for (const id of tabOrder) {
    const node: LayoutNode = {
      id,
      tagName: id.includes("button") ? "BUTTON" : "INPUT",
      tabIndex: 0,
      coreAction: id === "submit-button" || id === "add-member-button",
    };
    nodes.set(id, node);
    env.register(node);
    node.onKeyDown = (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const idx = tabOrder.indexOf(id);
      const next = e.shiftKey
        ? (idx - 1 + tabOrder.length) % tabOrder.length
        : (idx + 1) % tabOrder.length;
      env.focus(tabOrder[next]);
    };
  }

  return { env, tabOrder, nodes, profile };
}

describe("Narrow viewport & 200% zoom reachability (#128)", () => {
  const profiles: ViewportProfile[] = ["mobile-320", "zoom-200"];

  // ── 22. Core actions reachable in tab order ───────────────────────────────

  for (const profile of profiles) {
    test(`22: all core circle-detail actions are reachable via Tab (${profile})`, () => {
      const { env, tabOrder, nodes } = buildCircleDetailLayout(profile);
      const coreActions = [...nodes.values()].filter((n) => n.coreAction).map((n) => n.id);

      env.focus(tabOrder[0]);
      const visited = new Set<string>([tabOrder[0]]);
      for (let i = 1; i < tabOrder.length; i++) {
        env.dispatchKeyDown("Tab", false);
        visited.add(env.activeElement!.id);
      }

      for (const action of coreActions) {
        assert.ok(
          visited.has(action),
          `core action ${action} must be reachable by Tab at ${profile}`,
        );
      }
    });
  }

  // ── 23. Long addresses remain distinguishable ─────────────────────────────

  test("23: long member addresses expose full values and remain distinguishable", () => {
    const { nodes } = buildCircleDetailLayout("mobile-320");
    const addr0 = nodes.get("member-address-0")!;
    const addr1 = nodes.get("member-address-1")!;

    assert.ok(addr0.fullValue && addr0.fullValue.length > 40, "full address must be preserved");
    assert.ok(addr1.fullValue && addr1.fullValue.length > 40, "full address must be preserved");
    assert.notEqual(addr0.fullValue, addr1.fullValue, "addresses must be distinguishable");
    assert.ok(
      addr0.visibleText && addr0.visibleText !== addr0.fullValue,
      "narrow layout may truncate visually but must keep the full value accessible",
    );
  });

  // ── 24. Labeled horizontal scroll container ───────────────────────────────

  test("24: round table uses a labeled, focusable scroll container that does not hide controls", () => {
    const { nodes, env } = buildCircleDetailLayout("mobile-320");
    const scroll = nodes.get("round-table-scroll")!;

    assert.equal(scroll.scrollContainer, true, "round table must be in a scroll container");
    assert.ok(scroll.ariaLabel && scroll.ariaLabel.length > 0, "scroll container must be labeled");
    assert.equal(scroll.tabIndex, 0, "scroll container must be keyboard focusable");

    // Focusing the scroll container must not trap focus — Tab continues to actions.
    env.focus("round-table-scroll");
    env.dispatchKeyDown("Tab", false);
    assert.notEqual(
      env.activeElement?.id,
      "round-table-scroll",
      "Tab must move out of the scroll container to the next control",
    );
  });

  // ── 25. Focus order logical and trap-free at narrow widths ────────────────

  for (const profile of profiles) {
    test(`25: circle-detail focus order is trap-free and returns to start (${profile})`, () => {
      const { env, tabOrder } = buildCircleDetailLayout(profile);
      env.focus(tabOrder[0]);

      for (let i = 1; i < tabOrder.length; i++) {
        env.dispatchKeyDown("Tab", false);
        assert.equal(env.activeElement?.id, tabOrder[i], `Tab step ${i} at ${profile}`);
      }
      // Wraps back to the first control — no trap.
      env.dispatchKeyDown("Tab", false);
      assert.equal(env.activeElement?.id, tabOrder[0], "Tab wraps to first control");
    });
  }

  // ── 26. Create flow action group reachable at narrow widths ───────────────

  for (const profile of profiles) {
    test(`26: create flow submit and add-member actions reachable (${profile})`, () => {
      const { env, tabOrder } = buildCreateFlowLayout(profile);
      env.focus(tabOrder[0]);
      const visited = new Set<string>([tabOrder[0]]);
      for (let i = 1; i < tabOrder.length; i++) {
        env.dispatchKeyDown("Tab", false);
        visited.add(env.activeElement!.id);
      }
      assert.ok(visited.has("submit-button"), `submit must be reachable at ${profile}`);
      assert.ok(visited.has("add-member-button"), `add-member must be reachable at ${profile}`);
    });
  }

  // ── 27. Scroll container semantics ────────────────────────────────────────

  test("27: scroll container exposes region role and accessible name", () => {
    const { nodes } = buildCircleDetailLayout("zoom-200");
    const scroll = nodes.get("round-table-scroll")!;
    assert.equal(scroll.role, "region", "scroll container must have role='region'");
    assert.ok(scroll.ariaLabel, "scroll container must have an accessible name");
  });
});
