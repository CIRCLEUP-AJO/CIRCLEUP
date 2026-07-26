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

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { query } from "./db/pool";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function sendError(res: Response, status: number, message: string, details?: unknown) {
  res.status(status).json({
    error: {
      message,
      details: details ?? null,
    },
  });
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    console.info(`[api] ${req.method} ${req.path} started`);

    _res.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      console.info(
        `[api] ${req.method} ${req.path} completed status=${_res.statusCode} duration_ms=${durationMs}`,
      );
    });

    next();
  });

  // ── Health ───────────────────────────────────────────────────────────────────

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ── Circles ──────────────────────────────────────────────────────────────────

  app.get("/circles", async (_req: Request, res: Response) => {
    try {
      const circles = await query(
        `SELECT c.address, c.creator, c.round_amount, c.member_count,
                c.status, c.current_round, c.total_rounds, c.created_ledger,
                c.updated_at
         FROM circles c
         ORDER BY c.created_ledger DESC`,
      );
      res.json({ circles });
    } catch (err) {
      console.error("[api] Failed to list circles", err);
      sendError(res, 500, "Failed to list circles", getErrorMessage(err));
    }
  });

  app.get("/circles/:address", async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const [circle] = await query(
        `SELECT * FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        sendError(res, 404, "Circle not found");
        return;
      }

      const members = await query(
        `SELECT cm.*, r.score as reputation_score
         FROM circle_members cm
         LEFT JOIN reputation r ON r.member_address = cm.member_address
         WHERE cm.circle_address = $1
         ORDER BY cm.payout_order`,
        [address],
      );

      // Attach the latest indexed ledger so the client can derive wall-clock
      // estimates for the deadline countdown without a separate request.
      const [indexerState] = await query<{ last_ledger: string }>(
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
      console.error(`[api] Failed to load circle ${address}`, err);
      sendError(res, 500, "Failed to load circle", getErrorMessage(err));
    }
  });

  app.get("/circles/:address/members", async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const members = await query(
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
      console.error(`[api] Failed to load members for circle ${address}`, err);
      sendError(res, 500, "Failed to load circle members", getErrorMessage(err));
    }
  });

  app.get("/circles/:address/rounds", async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const payouts = await query(
        `SELECT * FROM payouts WHERE circle_address = $1 ORDER BY round_index`,
        [address],
      );
      const contributions = await query(
        `SELECT * FROM contributions WHERE circle_address = $1 ORDER BY round_index, created_at`,
        [address],
      );
      const defaults = await query(
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
      console.error(`[api] Failed to load rounds for circle ${address}`, err);
      sendError(res, 500, "Failed to load circle rounds", getErrorMessage(err));
    }
  });

  // ── Reputation ───────────────────────────────────────────────────────────────

  app.get("/reputation/:member", async (req: Request, res: Response) => {
    const { member } = req.params;
    try {
      const [row] = await query(
        `SELECT * FROM reputation WHERE member_address = $1`,
        [member],
      );
      const contributions = await query(
        `SELECT c.circle_address, COUNT(*) as contributions,
                ci.total_rounds
         FROM contributions c
         JOIN circles ci ON ci.address = c.circle_address
         WHERE c.member_address = $1
         GROUP BY c.circle_address, ci.total_rounds`,
        [member],
      );
      const defaults = await query(
        `SELECT circle_address, COUNT(*) as count
         FROM defaults WHERE member_address = $1
         GROUP BY circle_address`,
        [member],
      );

      res.json({
        member,
        score: row?.score ?? 0,
        contributions,
        defaults,
        updatedAt: row?.updated_at ?? null,
      });
    } catch (err) {
      console.error(`[api] Failed to load reputation for member ${member}`, err);
      sendError(res, 500, "Failed to load reputation", getErrorMessage(err));
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] Unhandled error", err);
    sendError(res, 500, "Internal server error", getErrorMessage(err));
  });

  return app;
}
