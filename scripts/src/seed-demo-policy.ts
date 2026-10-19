import * as fs from "fs";
import * as path from "path";
import { redactSecrets } from "./redact";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export function redactSeedError(message: string): string {
  return redactSecrets(message)
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|token|secret|password|credential|authorization)["']?\s*[:=]\s*["']?)[^"'`,\s}]+/gi, "$1[REDACTED]");
}

export interface SeedManifestNetwork {
  network: string;
  networkPassphrase: string;
}

export interface SeedTransaction {
  step: string;
  hash: string;
  status: "pending" | "submitted" | "confirmed" | "failed" | "timeout";
}

export interface SeedJournal {
  runId: string;
  status: "in_progress" | "completed" | "failed";
  network: string;
  members: string[];
  completedSteps: string[];
  transactions: SeedTransaction[];
  startedAt: string;
  updatedAt: string;
  currentStep?: string;
  circleAddress?: string;
  completedAt?: string;
  failure?: string;
}

export function assertAlwaysCreate(args: string[]): void {
  if (!args.includes("--always-create")) {
    throw new Error(
      "Refusing to create a new on-chain demo circle. Reruns always create new state; pass --always-create to confirm.",
    );
  }
}

export function assertSeedNetwork(
  network: string,
  configuredPassphrase: string,
  rpcPassphrase: string,
  manifest: SeedManifestNetwork,
): void {
  if (network !== "testnet") {
    throw new Error(`[seed] Refusing writes on network '${network}'; this demo seeder only supports testnet.`);
  }
  if (
    configuredPassphrase !== TESTNET_PASSPHRASE ||
    rpcPassphrase !== TESTNET_PASSPHRASE ||
    manifest.network !== network ||
    manifest.networkPassphrase !== TESTNET_PASSPHRASE
  ) {
    throw new Error("[seed] Network, RPC, or deployment manifest mismatch; refusing funding and contract writes.");
  }
}

export function recordSeedTransaction(
  journal: SeedJournal,
  step: string,
  hash: string,
  status: SeedTransaction["status"],
): void {
  const existing = journal.transactions.find((transaction) => transaction.hash === hash);
  if (existing) {
    existing.status = status;
  } else {
    journal.transactions.push({ step, hash, status });
  }
  journal.updatedAt = new Date().toISOString();
}

export function writeSeedJournal(outputPath: string, journal: SeedJournal): void {
  journal.updatedAt = new Date().toISOString();
  let runs: unknown[] = [];
  if (fs.existsSync(outputPath)) {
    const previous: unknown = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if (typeof previous === "object" && previous !== null && "runs" in previous && Array.isArray(previous.runs)) {
      runs = previous.runs;
    } else {
      runs = [previous];
    }
  }
  const runIndex = runs.findIndex(
    (entry) => typeof entry === "object" && entry !== null && "runId" in entry && entry.runId === journal.runId,
  );
  if (runIndex === -1) {
    runs.push(journal);
  } else {
    runs[runIndex] = journal;
  }
  const temporaryPath = path.join(path.dirname(outputPath), `.seeded-${process.pid}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, outputPath);
}