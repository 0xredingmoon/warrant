import type { Address, Hex } from "viem";

export interface RelayerConfig {
  rpcUrl: string;
  chainId: number;
  /** hot key that pays gas. Use a fresh testnet key holding only a little tQDAY. */
  privateKey: Hex;
  /** WarrantFactory address: the relayer only ever touches vaults this factory deployed */
  factory: Address;
  explorerUrl: string;
  /** optional bearer token required on every POST */
  apiKey?: string;
  /** requests per minute per client IP (default 60) */
  ratePerMinuteIp: number;
  /** pay requests per minute per vault (default 30) */
  ratePerMinuteVault: number;
  /** hard cap on transactions the relayer will send per UTC day (default 500) */
  dailyTxCap: number;
  /** SQLite file for rate limits, daily budgets and x402 settlements. ":memory:" forgets everything on restart. */
  dbPath: string;
  /** on-chain refusals (`PaymentRefused`) the relayer pays for, per vault per hour (default 20) */
  refusalsPerHourVault: number;
  /** hard cap on recorded refusals per UTC day across all vaults (default 200) */
  dailyRefusalCap: number;
  /** Blockscout-compatible explorer used to find past logs quickly (optional; the RPC is the fallback) */
  indexerUrl?: string;
  /** header carrying the real client IP when behind a proxy (e.g. x-forwarded-for). Default: socket address. */
  trustedIpHeader?: string;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing required env var ${k}`);
    return v;
  };
  return {
    rpcUrl: env.RPC_URL ?? "https://rpc-test.qday.info",
    chainId: Number(env.CHAIN_ID ?? 44005),
    privateKey: need("RELAYER_PRIVATE_KEY") as Hex,
    factory: need("FACTORY_ADDRESS") as Address,
    explorerUrl: env.EXPLORER_URL ?? "https://explorer-test.qday.info",
    apiKey: env.RELAYER_API_KEY || undefined,
    ratePerMinuteIp: Number(env.RATE_PER_MINUTE_IP ?? 60),
    ratePerMinuteVault: Number(env.RATE_PER_MINUTE_VAULT ?? 30),
    dailyTxCap: Number(env.DAILY_TX_CAP ?? 500),
    dbPath: env.DATABASE_PATH ?? "./data/relayer.db",
    refusalsPerHourVault: Number(env.REFUSALS_PER_HOUR_VAULT ?? 20),
    dailyRefusalCap: Number(env.DAILY_REFUSAL_CAP ?? 200),
    indexerUrl: env.INDEXER_URL || env.EXPLORER_URL || "https://explorer-test.qday.info",
    trustedIpHeader: env.TRUSTED_IP_HEADER || undefined,
  };
}

/** anvil/hardhat well-known keys: never allowed against a non-local RPC. */
export const PUBLIC_DEV_KEYS = new Set(
  [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0xac1e735be8536c6534bb4f17f06f6afc73b2b5ba84ac2cfb12f7461b20c0bbe3",
  ].map((k) => k.toLowerCase()),
);

export const isLocalRpc = (url: string) => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
};
