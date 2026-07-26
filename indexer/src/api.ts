/**
 * CircleUp REST API
 *
 * GET /circles                         → list all circles
 * GET /circles/:address                → circle detail + members + rounds
 * GET /circles/:address/members        → members with contribution status
 * GET /circles/:address/rounds         → all rounds (payouts + defaults)
 * GET /reputation/:member              → member reputation score
 * GET /health                          → health check
 */

import express, { Request, Response } from "express";
import cors from "cors";
import { query } from "./db/pool";

interface CircleRow {
  address: string;
  creator: string;
  round_amount: string;
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: string;
  round_deadline_ledgers: number | null;
  updated_at: string;
}

interface CircleMemberRow {
  circle_address: string;
  member_address: string;
  payout_order: number;
  collateral: string;
  defaults: number;
  joined_at: string | null;
  reputation_score: number | null;
}

interface CircleMemberWithContributionsRow extends CircleMemberRow {
  total_contributions: string;
}

interface ContributionRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface PayoutRow {
  circle_address: string;
  recipient: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface DefaultRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  penalty: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface ReputationRow {
  member_address: string;
  score: number;
  updated_at: string;
}

interface ReputationContributionSummaryRow {
  circle_address: string;
  contributions: string;
  total_rounds: number;
}

interface ReputationDefaultSummaryRow {
  circle_address: string;
  count: string;
}

interface IndexerStateRow {
  last_ledger: string;
}

/** Returns a trimmed, non-empty version of a route param, or null if it's missing/blank. */
function nonBlankParam(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── Health ───────────────────────────────────────────────────────────────────

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ── Circles ──────────────────────────────────────────────────────────────────

  app.get("/circles", async (_req: Request, res: Response) => {
    try {
      const circles = await query<
        Pick<
          CircleRow,
          | "address"
          | "creator"
          | "round_amount"
          | "member_count"
          | "status"
          | "current_round"
          | "total_rounds"
          | "created_ledger"
          | "updated_at"
        >
      >(
        `SELECT c.address, c.creator, c.round_amount, c.member_count,
                c.status, c.current_round, c.total_rounds, c.created_ledger,
                c.updated_at
         FROM circles c
         ORDER BY c.created_ledger DESC`,
      );
      res.json({ circles });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/circles/:address", async (req: Request, res: Response) => {
    const address = nonBlankParam(req.params.address);
    if (!address) {
      res.status(400).json({ error: "Circle address is required" });
      return;
    }
    try {
      const [circle] = await query<CircleRow>(
        `SELECT * FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({ error: `Circle '${address}' not found` });
        return;
      }

      const members = await query<CircleMemberRow>(
        `SELECT cm.*, r.score as reputation_score
         FROM circle_members cm
         LEFT JOIN reputation r ON r.member_address = cm.member_address
         WHERE cm.circle_address = $1
         ORDER BY cm.payout_order`,
        [address],
      );

      // Attach the latest indexed ledger so the client can derive wall-clock
      // estimates for the deadline countdown without a separate request.
      const [indexerState] = await query<IndexerStateRow>(
        `SELECT last_ledger FROM indexer_state WHERE id = 1`,
      );
      const latestLedger = indexerState ? Number(indexerState.last_ledger) : null;

      // Compute deadline_ledger for the current active round when we have
      // enough data.  Formula:
      //   deadline = created_ledger
      //            + (current_round + 1) * round_deadline_ledgers
      //
      // This is an approximation based on the creation ledger; the contract
      // sets the exact deadline per-round, but the indexer does not yet store
      // the per-round deadline_ledger from contract state.
      let deadlineLedger: number | null = null;
      if (
        circle.round_deadline_ledgers != null &&
        circle.created_ledger != null &&
        circle.status === "Active"
      ) {
        deadlineLedger =
          Number(circle.created_ledger) +
          (Number(circle.current_round) + 1) *
            Number(circle.round_deadline_ledgers);
      }

      res.json({
        circle: {
          ...circle,
          deadline_ledger: deadlineLedger,
        },
        members,
        latestLedger,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/circles/:address/members", async (req: Request, res: Response) => {
    const address = nonBlankParam(req.params.address);
    if (!address) {
      res.status(400).json({ error: "Circle address is required" });
      return;
    }
    try {
      const [circle] = await query<Pick<CircleRow, "address">>(
        `SELECT address FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({ error: `Circle '${address}' not found` });
        return;
      }

      const members = await query<CircleMemberWithContributionsRow>(
        `SELECT cm.member_address, cm.payout_order, cm.collateral,
                cm.defaults, cm.joined_at,
                r.score as reputation_score,
                (
                  SELECT COUNT(*) FROM contributions c2
                  WHERE c2.circle_address = cm.circle_address
                    AND c2.member_address = cm.member_address
                ) as total_contributions
         FROM circle_members cm
         LEFT JOIN reputation r ON r.member_address = cm.member_address
         WHERE cm.circle_address = $1
         ORDER BY cm.payout_order`,
        [address],
      );
      res.json({ members });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/circles/:address/rounds", async (req: Request, res: Response) => {
    const address = nonBlankParam(req.params.address);
    if (!address) {
      res.status(400).json({ error: "Circle address is required" });
      return;
    }
    try {
      const [circle] = await query<Pick<CircleRow, "address">>(
        `SELECT address FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({ error: `Circle '${address}' not found` });
        return;
      }

      const payouts = await query<PayoutRow>(
        `SELECT * FROM payouts WHERE circle_address = $1 ORDER BY round_index`,
        [address],
      );
      const contributions = await query<ContributionRow>(
        `SELECT * FROM contributions WHERE circle_address = $1 ORDER BY round_index, created_at`,
        [address],
      );
      const defaults = await query<DefaultRow>(
        `SELECT * FROM defaults WHERE circle_address = $1 ORDER BY round_index`,
        [address],
      );

      // Group contributions and defaults by round
      const rounds = payouts.map((p) => ({
        roundIndex: p.round_index,
        recipient: p.recipient,
        amount: p.amount,
        txHash: p.tx_hash,
        ledger: p.ledger,
        contributions: contributions.filter(
          (c) => c.round_index === p.round_index,
        ),
        defaults: defaults.filter((d) => d.round_index === p.round_index),
      }));

      res.json({ rounds, pendingDefaults: defaults.filter(
        (d) => !payouts.find((p) => p.round_index === d.round_index)
      )});
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Reputation ───────────────────────────────────────────────────────────────

  app.get("/reputation/:member", async (req: Request, res: Response) => {
    const member = nonBlankParam(req.params.member);
    if (!member) {
      res.status(400).json({ error: "Member address is required" });
      return;
    }
    try {
      const [row] = await query<ReputationRow>(
        `SELECT * FROM reputation WHERE member_address = $1`,
        [member],
      );
      const contributions = await query<ReputationContributionSummaryRow>(
        `SELECT c.circle_address, COUNT(*) as contributions,
                ci.total_rounds
         FROM contributions c
         JOIN circles ci ON ci.address = c.circle_address
         WHERE c.member_address = $1
         GROUP BY c.circle_address, ci.total_rounds`,
        [member],
      );
      const defaults = await query<ReputationDefaultSummaryRow>(
        `SELECT circle_address, COUNT(*) as count
         FROM defaults WHERE member_address = $1
         GROUP BY circle_address`,
        [member],
      );

      // A missing reputation row is not an error — it just means this member
      // has no recorded activity yet, so a fresh score of 0 is returned.
      // `found` lets clients distinguish that from a member with a real,
      // explicitly-tracked zero score.
      res.json({
        member,
        found: row != null,
        score: row?.score ?? 0,
        contributions,
        defaults,
        updatedAt: row?.updated_at ?? null,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
