import { setDeploymentFacts } from "./deploymentState";
/** A provider transition invalidates prepared actions synchronously. */
let revision = 0;
export function walletRevision(): number { return revision; }
export function invalidateWalletIdentity(): void {
  revision++;
  setDeploymentFacts([]);
  window.dispatchEvent(new Event('circleup:wallet-change'));
}

/**
 * Returns true when the injected provider has exposed `addEventListener`,
 * meaning the app can subscribe to `accountChanged`/`networkChanged` events
 * and detect identity transitions continuously.
 *
 * When this returns false the app cannot receive push notifications from the
 * wallet. Any write action must perform an explicit identity re-check at the
 * action boundary — and the UI must not claim that account changes are
 * monitored continuously.
 *
 * SSR-safe: returns false when `window` is not defined.
 */
export function providerHasChangeListeners(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { freighter?: Provider; freighterApi?: Provider };
  const provider = w.freighter ?? w.freighterApi;
  return typeof provider?.addEventListener === 'function';
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
