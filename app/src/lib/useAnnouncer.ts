/**
 * useAnnouncer — reusable accessible live-region announcement hook.
 *
 * Screen-reader users need concise announcements for meaningful state changes.
 * This hook manages a pair of polite/assertive live regions and ensures:
 *
 *   - Each unique state change is announced exactly once.
 *   - Repeated polling updates (e.g. every-5s data refresh) do not flood
 *     assistive technology unless the underlying state actually changed.
 *   - Focus is never moved programmatically by the announcer; focus management
 *     remains the responsibility of the calling component.
 *   - Assertive announcements are reserved for errors (transaction failure,
 *     wallet rejection) — they interrupt ongoing speech.
 *   - Polite announcements are used for progress (submitting, confirming,
 *     refresh complete) — they wait for a natural speech pause.
 *
 * Usage:
 *   const { announce, AnnouncerPortal } = useAnnouncer();
 *   // In render: <AnnouncerPortal />
 *   // On state change: announce("Transaction confirmed.", "polite");
 *
 * The AnnouncerPortal renders two visually-hidden <span> elements that are
 * always in the DOM so screen readers have a stable region to watch. Text is
 * written into them and cleared after CLEAR_DELAY_MS so the same message can
 * be re-announced on a subsequent identical event (e.g. a second refresh
 * completing successfully).
 */

"use client";
import { useCallback, useRef, useState } from "react";

// Time after announcing before the live region is cleared.
// Long enough for a screen reader to finish reading, short enough that an
// identical subsequent announcement will still be noticed.
const CLEAR_DELAY_MS = 3_000;

export type Politeness = "polite" | "assertive";

export interface AnnouncerControls {
  /**
   * Announce a message to screen readers.
   *
   * @param message    The text to announce. Empty strings are silently ignored.
   * @param politeness "polite" for progress/success (default), "assertive" for errors.
   */
  announce: (message: string, politeness?: Politeness) => void;
  /**
   * Render this component once in your tree (ideally near the root of the
   * component that owns the announcer). It is visually hidden and does not
   * affect layout.
   */
  AnnouncerPortal: React.FC;
}

export function useAnnouncer(): AnnouncerControls {
  const [politeText,    setPoliteText]    = useState("");
  const [assertiveText, setAssertiveText] = useState("");

  // Track the last announced message per politeness level so that repeated
  // identical state changes (e.g. "Data refreshed." fired every 5 s when
  // nothing changed) do not re-announce.
  const lastPoliteRef    = useRef("");
  const lastAssertiveRef = useRef("");

  // Timer refs for clearing the live regions after the delay.
  const politeTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assertiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback((message: string, politeness: Politeness = "polite") => {
    if (!message || !message.trim()) return;

    if (politeness === "assertive") {
      // Skip if this exact message was just announced (within the clear window).
      if (message === lastAssertiveRef.current) return;
      lastAssertiveRef.current = message;

      if (assertiveTimerRef.current) clearTimeout(assertiveTimerRef.current);
      setAssertiveText(message);
      assertiveTimerRef.current = setTimeout(() => {
        setAssertiveText("");
        lastAssertiveRef.current = "";
      }, CLEAR_DELAY_MS);
    } else {
      if (message === lastPoliteRef.current) return;
      lastPoliteRef.current = message;

      if (politeTimerRef.current) clearTimeout(politeTimerRef.current);
      setPoliteText(message);
      politeTimerRef.current = setTimeout(() => {
        setPoliteText("");
        lastPoliteRef.current = "";
      }, CLEAR_DELAY_MS);
    }
  }, []);

  const AnnouncerPortal: React.FC = useCallback(() => {
    return (
      <>
        {/*
          Polite region — announces when the user is idle.
          Used for: transaction submitted, transaction confirmed, data refreshed.
        */}
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {politeText}
        </span>
        {/*
          Assertive region — interrupts ongoing speech immediately.
          Used for: transaction failure, wallet rejection, critical errors.
        */}
        <span
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="sr-only"
        >
          {assertiveText}
        </span>
      </>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [politeText, assertiveText]);

  return { announce, AnnouncerPortal };
}

// ── Announcement policy constants ─────────────────────────────────────────────
//
// Centralised here so the create and circle-detail flows use identical
// message text and politeness levels. Consistent wording prevents duplicate
// or contradictory announcements when multiple components mount at the same
// time.

export const ANNOUNCEMENTS = {
  // ── Transaction lifecycle ──────────────────────────────────────────────────
  txSubmitting:       { message: "Submitting transaction, please wait.",       politeness: "polite"    as Politeness },
  txSubmitted:        { message: "Transaction submitted. Waiting for confirmation.", politeness: "polite" as Politeness },
  txConfirmed:        (label: string) => ({
    message:    `Transaction confirmed: ${label}.`,
    politeness: "polite" as Politeness,
  }),
  txFailed:           (reason: string) => ({
    message:    `Transaction failed: ${reason}`,
    politeness: "assertive" as Politeness,
  }),
  txCancelled:        { message: "Transaction cancelled.",                      politeness: "assertive" as Politeness },

  // ── Wallet ─────────────────────────────────────────────────────────────────
  walletConnected:    (address: string) => ({
    message:    `Wallet connected: ${address}.`,
    politeness: "polite" as Politeness,
  }),
  walletError:        (reason: string) => ({
    message:    `Wallet error: ${reason}`,
    politeness: "assertive" as Politeness,
  }),

  // ── Data refresh ───────────────────────────────────────────────────────────
  refreshing:         { message: "Refreshing circle data.",                    politeness: "polite"    as Politeness },
  // Only announced when the refresh actually changes visible state (status or
  // round), not on every polling cycle.
  refreshedChanged:   (what: string) => ({
    message:    `Circle data updated: ${what}.`,
    politeness: "polite" as Politeness,
  }),
  refreshError:       { message: "Could not refresh circle data. Try again.",  politeness: "assertive" as Politeness },

  // ── Circle create ──────────────────────────────────────────────────────────
  circleCreated:      { message: "Circle created successfully. Redirecting to home page.", politeness: "polite" as Politeness },
  circleCreateFailed: (reason: string) => ({
    message:    `Circle creation failed: ${reason}`,
    politeness: "assertive" as Politeness,
  }),

  // ── Indexer refresh ────────────────────────────────────────────────────────
  indexerIndexed:     { message: "Indexer has processed the latest transaction.", politeness: "polite" as Politeness },
} as const;
