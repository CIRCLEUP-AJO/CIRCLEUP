export const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ||
  "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  "Test SDF Network ; September 2015";

export const CIRCLE_FACTORY_ADDRESS =
  process.env.NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS || "";

export const REPUTATION_ADDRESS =
  process.env.NEXT_PUBLIC_REPUTATION_ADDRESS || "";

export const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS || "";

export const INDEXER_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";

/** 1 USDC = 10_000_000 stroops */
export const STROOP = BigInt(10_000_000);

export function usdcToStroops(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10_000_000));
}

export function stroopsToUsdc(stroops: bigint | string | number): string {
  const n = BigInt(stroops.toString());
  const whole = n / STROOP;
  const frac = (n % STROOP).toString().padStart(7, "0");
  return `${whole}.${frac}`.replace(/\.?0+$/, "") || "0";
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 8) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
