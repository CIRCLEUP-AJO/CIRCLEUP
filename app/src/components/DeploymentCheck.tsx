"use client";
import { useState } from 'react';
import { verifyConfiguredDeployment } from '@/lib/stellar';
import { useDeploymentVerified, type DeploymentFact } from '@/lib/deploymentState';
export function DeploymentCheck() {
  const [facts, setFacts] = useState<DeploymentFact[]>([]);
  const [busy, setBusy] = useState(false);
  const verified = useDeploymentVerified();
  return <aside className="max-w-5xl mx-auto px-4 pt-4 text-sm space-y-2">
    <p>Deployment checks: {verified ? 'passed (valid for five minutes)' : 'verification required before writes'}. Browsing remains available.</p>
    <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { setFacts(await verifyConfiguredDeployment()); } finally { setBusy(false); } }}>{busy ? 'Checking…' : 'Verify deployment'}</button>
    <ul aria-live="polite">{facts.map(f => <li key={f.name}>{f.name}: {f.status}</li>)}</ul>
    <p>Checks compare the RPC network and factory links with configuration, probe the reputation getter, and check token decimals. They do not prove code provenance, token issuer identity, or release authenticity. Operators can compare a manifest’s circle WASM hash with the SDK’s verifyDeployment option.</p>
  </aside>;
}
