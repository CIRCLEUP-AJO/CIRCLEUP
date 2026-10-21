"use client";
import { useEffect, useState } from 'react';
export type DeploymentFact = { name: string; status: 'verified' | 'mismatch' | 'unverifiable' };
let facts: DeploymentFact[] = [];
let checkedAt = 0;
export function deploymentVerified(): boolean { return checkedAt > 0 && Date.now() - checkedAt < 300000 && facts.length > 0 && facts.every(f => f.status === 'verified'); }
export function setDeploymentFacts(next: DeploymentFact[]): void { facts = next; checkedAt = Date.now(); window.dispatchEvent(new Event('circleup:deployment')); }
export function useDeploymentVerified(): boolean {
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    const update = () => setVerified(deploymentVerified());
    update(); window.addEventListener('circleup:deployment', update);
    const timer = setInterval(update, 1000);
    return () => { clearInterval(timer); window.removeEventListener('circleup:deployment', update); };
  }, []);
  return verified;
}
