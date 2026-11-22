import * as fs from "fs";
import * as path from "path";
import { redactSecrets } from "./redact";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Deterministic, non-secret identifiers used to recognise a prior demo deployment.
 * These are derived from public values only (never from secret keys) so they can be
 * safely written on-chain and looked up again on a later run.
 */
export const DEMO_SEED_TAG = "soroban-demo-seed-v1";
export const DEMO_CIRCLE_MEMO = "demo-circle";

export function deriveDemoIdentity(members: string[]): string {
  const normalized = [...members].map((member) => member.trim()).sort();
  return `${DEMO_SEED_TAG}:${normalized.join(",")}`;
}

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

export type SeedStepStatus = "completed" | "unresolved" | "pending";

export interface SeedStepReport {
  step: string;
  status: SeedStepStatus;
  detail?: string;
  hash?: string;
}

export interface SeedPreflightReport {
  network: string;
  rpcUrl: string;
  identity: string;
  dryRun: true;
  steps: SeedStepReport[];
  priorCircleAddress?: string;
  priorRunId?: string;
  /** True when a prior create_circle may have succeeded and must not be repeated. */
  createBlocked: boolean;
  /** True when a prior create_circle timed out and its outcome is unknown. */
  createUnresolved: boolean;
}

export interface SeedPreflightOptions {
  network: string;
  rpcUrl: string;
  manifest: SeedManifestNetwork;
  members: string[];
  priorJournal?: SeedJournal;
  /** Looks up an existing demo circle by deterministic identity. */
  findCircle?: (identity: string) => Promise<string | undefined>;
  /** Looks up a transaction by hash to resolve a previously ambiguous timeout. */
  lookupTransaction?: (hash: string) => Promise<SeedTransaction["status"] | undefined>;
}

function isCreateStep(step: string): boolean {
  return step === "create_circle" || step.startsWith("create_circle");
}

/**
 * Inspects current testnet state before any write. Never treats a timeout as proof
 * that a prior call failed: timeouts are reported as "unresolved".
 */
export async function preflightSeed(options: SeedPreflightOptions): Promise<SeedPreflightReport> {
  const { network, rpcUrl, manifest, members, priorJournal } = options;

  if (network !== "testnet") {
    throw new Error(`[seed] Refusing writes on network '${network}'; this demo seeder only supports testnet.`);
  }
  if (manifest.network !== network || manifest.networkPassphrase !== TESTNET_PASSPHRASE) {
    throw new Error("[seed] Deployment manifest does not match the selected testnet; refusing preflight.");
  }

  const identity = deriveDemoIdentity(members);
  const steps: SeedStepReport[] = [];
  let createBlocked = false;
  let createUnresolved = false;
  let priorCircleAddress: string | undefined;
  let priorRunId: string | undefined;

  if (priorJournal) {
    priorRunId = priorJournal.runId;
    if (priorJournal.circleAddress) {
      priorCircleAddress = priorJournal.circleAddress;
    }
    for (const transaction of priorJournal.transactions) {
      let status: SeedStepStatus;
      if (transaction.status === "confirmed") {
        status = "completed";
      } else if (transaction.status === "failed") {
        status = "pending";
      } else {
        // pending / submitted / timeout: outcome unknown, must not be retried blindly.
        status = "unresolved";
        if (options.lookupTransaction) {
          const resolved = await options.lookupTransaction(transaction.hash);
          if (resolved === "confirmed") {
            status = "completed";
          } else if (resolved === "failed") {
            status = "pending";
          }
        }
      }
      if (isCreateStep(transaction.step)) {
        if (status === "completed") {
          createBlocked = true;
        } else if (status === "unresolved") {
          createUnresolved = true;
        }
      }
      steps.push({ step: transaction.step, status, hash: transaction.hash });
    }
  }

  if (options.findCircle) {
    const found = await options.findCircle(identity);
    if (found) {
      priorCircleAddress = found;
      createBlocked = true;
      if (!steps.some((step) => isCreateStep(step.step) && step.status === "completed")) {
        steps.push({ step: "create_circle", status: "completed", detail: "matching circle found on-chain" });
      }
    }
  }

  if (!steps.some((step) => step.step === "create_circle")) {
    steps.push({ step: "create_circle", status: createBlocked ? "completed" : "pending" });
  }

  return {
    network,
    rpcUrl,
    identity,
    dryRun: true,
    steps,
    priorCircleAddress,
    priorRunId,
    createBlocked,
    createUnresolved,
  };
}

/**
 * Decides whether a create_circle write may proceed. Only allowed when no prior
 * matching state exists and no unresolved create is recorded.
 */
export function canCreateCircle(report: SeedPreflightReport): boolean {
  return !report.createBlocked && !report.createUnresolved;
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