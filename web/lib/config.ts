import { getAddress, type Address } from "viem";
import { DEPLOYMENT } from "./deployment";

/**
 * Settings, highest priority first:
 *  1. window.__WARRANT__ from /config.js (written at deploy time, so one static build serves any relayer),
 *  2. NEXT_PUBLIC_* variables at build time,
 *  3. the committed deployment (web/lib/deployment.ts, generated from deployments/aevum.json).
 */
type Runtime = Partial<{ relayerUrl: string; rpcUrl: string; explorer: string; indexerUrl: string; factory: string; registry: string; deployBlock: string }>;
const rt: Runtime = (typeof window !== "undefined" && (window as unknown as { __WARRANT__?: Runtime }).__WARRANT__) || {};
const pick = (runtime: string | undefined, build: string | undefined, fallback: string) => (runtime && runtime.length > 0 ? runtime : build && build.length > 0 ? build : fallback);

/** Trim a path prefix such as `/warrant` used on GitHub Pages. Empty when the app is served from the domain root. */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
export const asset = (path: string) => `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;

/** Values that must not be baked in as a live relayer URL (placeholder Actions variable, leftover localhost). */
export function configuredRelayerUrl(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  const lower = v.toLowerCase();
  if (lower === "pending" || lower === "placeholder" || lower === "unset" || lower === "none") return undefined;
  try {
    const u = new URL(v);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") return undefined;
  } catch {
    return undefined;
  }
  return v.replace(/\/$/, "");
}

export const CHAIN_ID = Number(pick(undefined, process.env.NEXT_PUBLIC_CHAIN_ID, String(DEPLOYMENT.chainId)));
export const RPC_URL = pick(rt.rpcUrl, process.env.NEXT_PUBLIC_RPC_URL, "https://rpc-test.qday.info");
export const EXPLORER = pick(rt.explorer, process.env.NEXT_PUBLIC_EXPLORER, "https://explorer-test.qday.info");
/** Blockscout-compatible index used to load a vault's history in one request (the RPC is the fallback). Empty string disables it. */
export const INDEXER_URL: string | undefined = pick(rt.indexerUrl, process.env.NEXT_PUBLIC_INDEXER_URL, EXPLORER) || undefined;
export const FACTORY: Address = getAddress(pick(rt.factory, process.env.NEXT_PUBLIC_FACTORY, DEPLOYMENT.factory));
export const REGISTRY: Address = getAddress(pick(rt.registry, process.env.NEXT_PUBLIC_REGISTRY, DEPLOYMENT.registry));
export const DEPLOY_BLOCK = BigInt(pick(rt.deployBlock, process.env.NEXT_PUBLIC_DEPLOY_BLOCK, String(DEPLOYMENT.deployBlock)));
export const RELAYER_URL: string | undefined = configuredRelayerUrl(pick(rt.relayerUrl, process.env.NEXT_PUBLIC_RELAYER_URL, ""));
export const TOKEN: Address = getAddress(DEPLOYMENT.token);
