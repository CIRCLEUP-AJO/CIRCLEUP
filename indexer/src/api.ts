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
import rateLimit from "express-rate-limit";
import { query } from "./db/pool";

// ── CORS ─────────────────────────────────────────────────────────────────────
//
// ALLOWED_ORIGINS is a comma-separated allow-list, e.g.
// "https://app.circleup.xyz,https://staging.circleup.xyz". If unset, every
// origin is allowed (useful for local dev) but a warning is logged so this
// isn't mistaken for a deliberate production setting.
function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function buildCorsOptions(
  allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
): cors.CorsOptions {
  if (allowedOrigins.length === 0) {
    console.warn(
      "[api] ALLOWED_ORIGINS is not set — allowing all origins. " +
        "Set ALLOWED_ORIGINS to a comma-separated list in production.",
    );
    return { origin: true };
  }

  return {
    origin(origin, callback) {
      // requests with no Origin header (curl, server-to-server, health checks)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed`));
    },
  };
}

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Applies to every route including /health. Defaults to 100 requests per
// minute per IP; both are configurable so ops can tune per-deployment without
// a code change.
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100", 10);

const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

export function createApp() {
  const app = express();
  app.use(cors(buildCorsOptions()));
  app.use(apiRateLimiter);
  app.use(express.json());

  // cors() calls next(err) for rejected origins instead of sending a response
  // itself — without this handler, Express's default error page would leak a
  // stack trace instead of a clean 403.
  app.use(
    (err: Error, _req: Request, res: Response, next: express.NextFunction) => {
      if (err.message.startsWith("Origin ")) {
        res.status(403).json({ error: err.message });
        return;
      }
      next(err);
    },
  );

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
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
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
        res.status(404).json({ error: "Circle not found" });
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
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
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
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
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
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
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
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
