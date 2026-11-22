import * as dotenv from "dotenv";
dotenv.config();

// Importing ./config validates all required env vars (DATABASE_URL,
// STELLAR_RPC_URL, CIRCLE_FACTORY_ADDRESS, REPUTATION_ADDRESS, USDC_ADDRESS)
// and throws a single clear error listing what's missing if any are unset —
// deliberately before ./db/migrate and ./indexer run so a misconfigured
// deploy fails on boot instead of partway through migrations or polling.
import { PORT, SHUTDOWN_GRACE_PERIOD_MS, DB_CONNECT_MAX_RETRIES, DB_CONNECT_BASE_DELAY_MS } from "./config";
import { connectWithRetry, pool, closePool } from "./db/pool";
import { runMigrations, checkMigrationHealth } from "./db/migrate";
import { startIndexer, stopIndexer } from "./indexer";
import { createApp } from "./api";
import { log } from "./logger";
import type { Server } from "http";

// ── Shutdown coordinator ───────────────────────────────────────────────────────
//
// Coordinates a bounded, idempotent teardown of every long-lived resource the
// entrypoint owns.  The sequence is fixed:
//
//   1. poller  — stop accepting new work and await any in-flight poll cycle so
//                we never exit mid-transaction (commit or roll back cleanly).
//   2. http    — stop accepting new requests and drain/close open sockets.
//   3. pool    — release Postgres connections only after nothing else queries.
//
// A single deadline (SHUTDOWN_GRACE_PERIOD_MS) bounds the whole drain.  If it
// is exceeded the coordinator logs the unfinished phase and exits 1 so a
// deployment system can replace a stuck process.  Repeated signals are ignored
// once teardown has begun, so resources are never double-closed.

type ShutdownPhase = "not_started" | "poller" | "http" | "pool" | "complete";

const PHASE_DESCRIPTIONS: Record<ShutdownPhase, string> = {
  not_started: "shutdown never began",
  poller:      "event poller did not finish in-flight work",
  http:        "HTTP server did not drain open connections",
  pool:        "Postgres pool did not release connections",
  complete:    "unexpected: shutdown appeared complete but timer fired",
};

class ShutdownCoordinator {
  private started = false;
  private phase: ShutdownPhase = "not_started";
  private server: Server | null = null;
  private abortController: AbortController | null = null;
  private forceExitTimer: NodeJS.Timeout | null = null;
  private poolClosed = false;
  private serverClosed = false;

  /** Register the HTTP server so the coordinator can close it during drain. */
  registerServer(server: Server): void {
    this.server = server;
  }

  /** Current phase — exposed for tests and diagnostics. */
  get currentPhase(): ShutdownPhase {
    return this.phase;
  }

  /** True once a shutdown has been initiated (any signal). */
  get isShuttingDown(): boolean {
    return this.started;
  }

  /**
   * Begin (or ignore a repeat of) the shutdown sequence.  Idempotent: the
   * first call wins; subsequent calls log and return without starting a
   * second teardown, so no resource is closed twice.
   */
  async shutdown(signal: string): Promise<void> {
    if (this.started) {
      console.log(
        `[circleup-indexer] ${signal} received but shutdown already in progress (phase: ${this.phase})`,
      );
      return;
    }
    this.started = true;

    console.log(
      `[circleup-indexer] Received ${signal} — shutting down gracefully ` +
        `(grace period: ${SHUTDOWN_GRACE_PERIOD_MS}ms)...`,
    );

    // Hard-kill timer: if graceful teardown hangs past the configured grace
    // period (e.g. an RPC call stuck waiting, a slow DB write, or the HTTP
    // server waiting for a keep-alive connection to drain), force-exit so the
    // process never blocks a rolling deployment indefinitely.
    //
    // The AbortController lets us propagate the deadline into stopIndexer and
    // closePool so a stuck in-flight operation rejects early instead of
    // silently holding open the Postgres connection that pool.end() needs to
    // close.
    //
    // unref() prevents the timer from keeping the event loop alive on its own —
    // if everything closes cleanly before the deadline the process exits 0
    // without waiting for the timer to fire.
    const abortController = new AbortController();
    this.abortController = abortController;
    this.forceExitTimer = setTimeout(() => {
      abortController.abort();
      // Log which phase the shutdown was stuck in so operators know exactly
      // what resource failed to drain within the grace period.
      log("fatal", "indexer_stopped", {
        phase: this.phase,
        detail: PHASE_DESCRIPTIONS[this.phase],
      }, `Shutdown timed out after ${SHUTDOWN_GRACE_PERIOD_MS}ms — stuck at "${this.phase}": ${PHASE_DESCRIPTIONS[this.phase]}. Forcing exit.`);
      process.exit(1);
    }, SHUTDOWN_GRACE_PERIOD_MS);
    this.forceExitTimer.unref();

    try {
      // 1. Stop the poller first: refuse new ticks and wait for any in-flight
      //    ledger ingest to finish so we never exit mid-transaction.  Pass the
      //    AbortSignal so a stuck RPC call does not block past the grace period.
      this.phase = "poller";
      await stopIndexer(abortController.signal);

      // 2. Stop accepting new HTTP requests.  server.close() prevents new
      //    connections but does not terminate existing keep-alive sockets —
      //    those would hold the server open indefinitely.  closeAllConnections()
      //    forces all idle keep-alive sockets closed immediately so active
      //    in-flight requests finish but persistent connections do not stall
      //    the shutdown.
      this.phase = "http";
      await this.closeServer();

      // 3. Release all Postgres connections cleanly via closePool only after
      //    both the poller and the HTTP server have stopped issuing queries.
      this.phase = "pool";
      await this.closePoolOnce(abortController.signal);

      this.phase = "complete";
      if (this.forceExitTimer) {
        clearTimeout(this.forceExitTimer);
        this.forceExitTimer = null;
      }
      console.log("[circleup-indexer] Shutdown complete");
      process.exit(0);
    } catch (err) {
      console.error("[circleup-indexer] Error during graceful shutdown:", err);
      process.exit(1);
    }
  }

  private async closeServer(): Promise<void> {
    if (this.serverClosed || !this.server) {
      return;
    }
    this.serverClosed = true;
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // Close idle keep-alive connections that server.close() leaves open.
    // Available in Node 18.2+; guard so older Node versions don't throw.
    if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === "function") {
      (server as { closeAllConnections: () => void }).closeAllConnections();
    }
    console.log("[circleup-indexer] HTTP server closed");
  }

  private async closePoolOnce(signal: AbortSignal): Promise<void> {
    if (this.poolClosed) {
      return;
    }
    this.poolClosed = true;
    await closePool({ signal });
    console.log("[circleup-indexer] Database pool closed");
  }
}

const shutdownCoordinator = new ShutdownCoordinator();

async function main() {
  log("info", "indexer_started", {
    pollIntervalMs: 0,
    eventsLimit: 0,
    startLedger: 0,
  }, "[circleup-indexer] Booting...");

  // Wait for Postgres to accept connections before migrating — it's common
  // for the DB container to still be starting up at this point.
  // Retry parameters are read from DB_CONNECT_MAX_RETRIES and
  // DB_CONNECT_BASE_DELAY_MS env vars (defaults: 5 retries, 1000 ms base delay).
  log("info", "indexer_started", {
    pollIntervalMs: 0,
    eventsLimit: 0,
    startLedger: 0,
  }, `[circleup-indexer] Connecting to Postgres (max ${DB_CONNECT_MAX_RETRIES} attempt(s), base delay ${DB_CONNECT_BASE_DELAY_MS}ms)...`);
  await connectWithRetry();

  // Apply DB schema and all pending additive migrations.
  await runMigrations();

  // Post-migration health check.  runMigrations() applies every pending
  // migration, so the only non-clean states that can appear here are:
  //   drifted — a migration was applied in this environment but the file has
  //             since been deleted or renamed.  The indexer can still start
  //             (the tables exist), but the discrepancy should be investigated.
  //   partial — pending files AND missing-on-disk entries exist simultaneously.
  //             This is unusual and warrants immediate attention.
  //
  // Neither state aborts the process — the indexer is conservative and keeps
  // serving data rather than going down hard in ambiguous situations.  The
  // warning is prominent enough for ops tooling (log alerts, /health endpoint)
  // to surface it.
  const health = await checkMigrationHealth();
  if (health.state === "drifted" || health.state === "partial") {
    console.warn(
      `[circleup-indexer] SCHEMA WARNING (${health.state.toUpperCase()}): ${health.summary}`,
    );
    console.warn(
      "[circleup-indexer] The indexer will continue, but investigate the schema drift before the next deploy.",
    );
  } else {
    console.log(`[circleup-indexer] Schema health: ${health.summary}`);
  }

  // Start REST API — pass the migration health result so the /health endpoint
  // can surface schema drift without re-running the migration scan on every
  // health poll request.
  const app = createApp({ cachedMigrationHealth: health });
  const server = app.listen(PORT, () => {
    console.log(`[circleup-indexer] API listening on http://localhost:${PORT}`);
  });

  // Hand the server to the coordinator so it can be closed during drain.
  shutdownCoordinator.registerServer(server);

  // Register signal handlers before startIndexer so a SIGTERM that races
  // the very first poll tick is still caught and handled cleanly rather than
  // being delivered to a process with no handler registered yet.
  //
  // process.on (not process.once) so a second SIGTERM/SIGINT — which the OS or
  // a deployment system may send if the first doesn't produce a prompt exit —
  // is also received.  The coordinator is idempotent: repeated calls log
  // "already in progress" and return without starting a second teardown, so
  // resources are never double-closed and in-flight rollback is not skipped.
  process.on("SIGTERM", () => {
    void shutdownCoordinator.shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdownCoordinator.shutdown("SIGINT");
  });

  // Start event indexer after signal handlers are in place.
  await startIndexer();
}

// ── Unhandled error capture ────────────────────────────────────────────────────
//
// Catch any error that escapes all other handlers so they land in structured
// logs rather than crashing silently or printing a raw stack trace.
process.on("uncaughtException", (err) => {
  log("fatal", "indexer_stopped", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }, `[circleup-indexer] Uncaught exception: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log("fatal", "indexer_stopped", {
    error: msg,
    stack: reason instanceof Error ? reason.stack : undefined,
  }, `[circleup-indexer] Unhandled promise rejection: ${msg}`);
  process.exit(1);
});

main().catch((err) => {
  log("fatal", "indexer_stopped", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }, `[circleup-indexer] Fatal error during startup: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
