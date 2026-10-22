import { setDeploymentFacts } from "./deploymentState";
/** A provider transition invalidates prepared actions synchronously. */
let revision = 0;
export function walletRevision(): number { return revision; }
export function invalidateWalletIdentity(): void {
  revision++;
  setDeploymentFacts([]);
  window.dispatchEvent(new Event('circleup:wallet-change'));
}
export function observeWalletChanges(onChange: () => void): () => void {
  const w = window as unknown as { freighter?: Provider; freighterApi?: Provider };
  const provider = w.freighter ?? w.freighterApi;
  const change = () => invalidateWalletIdentity();
  provider?.addEventListener?.('accountChanged', change);
  provider?.addEventListener?.('networkChanged', change);
  window.addEventListener('circleup:wallet-change', onChange);
  return () => {
    provider?.removeEventListener?.('accountChanged', change);
    provider?.removeEventListener?.('networkChanged', change);
    window.removeEventListener('circleup:wallet-change', onChange);
  };
}
interface Provider {
  addEventListener?: (event: string, callback: () => void) => void;
  removeEventListener?: (event: string, callback: () => void) => void;
}
