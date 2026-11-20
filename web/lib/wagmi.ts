import { createConfig, http, injected } from "wagmi";
import { defineChain } from "viem";
import { CHAIN_ID, EXPLORER, RPC_URL } from "./config";

export const aevum = defineChain({
  id: CHAIN_ID,
  name: "QDay Aevum testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [aevum],
  connectors: [injected()],
  transports: { [aevum.id]: http(RPC_URL) },
  ssr: true,
  // eth_getLogs and batching limits on Aevum are strict; keep JSON-RPC calls unbatched.
  batch: undefined,
});
