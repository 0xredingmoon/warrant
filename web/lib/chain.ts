import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { CHAIN_ID, EXPLORER, RPC_URL } from "./config";

export const aevum = defineChain({
  id: CHAIN_ID,
  name: "QDay Aevum testnet",
  nativeCurrency: { name: "QDay", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

/**
 * Reads go straight to the Aevum RPC, whatever network the wallet is on. Contract reads made in the same moment are
 * bundled into one Multicall3 call (a vault view is about 20 reads: one round trip instead of 20 queued behind the
 * browser's connection limit). Log queries are not bundled; the RPC's eth_getLogs limits are strict.
 */
export const publicClient = createPublicClient({
  chain: aevum,
  batch: { multicall: { wait: 16 } },
  transport: http(RPC_URL, { timeout: 20_000, retryCount: 3, retryDelay: 300 }),
}) as PublicClient;
