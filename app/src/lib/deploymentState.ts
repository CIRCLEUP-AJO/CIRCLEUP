"use client";
import { useEffect, useState } from 'react';

export type DeploymentFact = { name: string; status: 'verified' | 'mismatch' | 'unverifiable' };

/**
 * Field-level validation failure surfaced by the manifest schema validator.
 * `path` is a dotted path into the manifest (e.g. "contracts.circle.id").
 */
export type DeploymentFieldError = { path: string; message: string };

/**
 * Versioned manifest shape consumed by the app. Mirrors the runtime schema
 * defined for each supported manifest version. Unknown/unsupported versions
 * are represented by `supported: false` and must never be treated as verified.
 */
export type DeploymentManifest = {
  version: number;
  supported: boolean;
  network?: string;
  contracts?: Record<string, { id?: string; hash?: string }>;
  build?: { commit?: string; checksum?: string };
  errors: DeploymentFieldError[];
};

let facts: DeploymentFact[] = [];
let manifest: DeploymentManifest | null = null;
let checkedAt = 0;

const VERIFIED_WINDOW_MS = 300000;

function manifestIsUsable(m: DeploymentManifest | null): boolean {
  if (!m) return false;
  if (!m.supported) return false;
  if (!Array.isArray(m.errors) || m.errors.length > 0) return false;
  return true;
}

export function deploymentVerified(): boolean {
  return (
    checkedAt > 0 &&
    Date.now() - checkedAt < VERIFIED_WINDOW_MS &&
    manifestIsUsable(manifest) &&
    facts.length > 0 &&
    facts.every(f => f.status === 'verified')
  );
}

export function setDeploymentFacts(next: DeploymentFact[]): void {
  facts = next;
  checkedAt = Date.now();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('circleup:deployment'));
}

/**
 * Accepts the versioned manifest (or null when absent). A partial, malformed,
 * or unsupported manifest is retained for inspection but never counts toward
 * verification. Field-level errors are surfaced via `getDeploymentManifest`.
 */
export function setDeploymentManifest(next: DeploymentManifest | null): void {
  manifest = next;
  checkedAt = Date.now();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('circleup:deployment'));
}

export function getDeploymentManifest(): DeploymentManifest | null {
  return manifest;
}

export function getDeploymentFieldErrors(): DeploymentFieldError[] {
  if (!manifest) return [];
  if (!manifest.supported) {
    return [{ path: 'version', message: `Unsupported manifest version: ${String(manifest.version)}` }];
  }
  return Array.isArray(manifest.errors) ? manifest.errors : [];
}

export function useDeploymentVerified(): boolean {
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    const update = () => setVerified(deploymentVerified());
    update();
    window.addEventListener('circleup:deployment', update);
    const timer = setInterval(update, 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('circleup:deployment', update);
    };
  }, []);
  return verified;
}

export function useDeploymentFieldErrors(): DeploymentFieldError[] {
  const [errors, setErrors] = useState<DeploymentFieldError[]>([]);
  useEffect(() => {
    const update = () => setErrors(getDeploymentFieldErrors());
    update();
    window.addEventListener('circleup:deployment', update);
    return () => {
      window.removeEventListener('circleup:deployment', update);
    };
  }, []);
  return errors;
}