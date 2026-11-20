import { defineChain, formatUnits, parseUnits, type Address, type Chain } from "viem";

/** QDay Aevum testnet. Shanghai EVM, ~1 gwei gas, eth_getLogs limited to 1,000 blocks, no WebSocket RPC. */
export const aevumTestnet: Chain = defineChain({
  id: 44005,
  name: "QDay Aevum",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

/** tUSD8: the test stablecoin on Aevum (6 decimals, EIP-2612 permit, EIP-3009 signed transfers). */
export const TUSD8_ADDRESS: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TUSD8_DECIMALS = 6;
/** tUSD8's EIP-712 domain, as used by `permit` and `receiveWithAuthorization`. */
export const TUSD8_EIP712 = { name: "tUSD8", version: "2" } as const;

export const EXPLORER_URL = "https://explorer-test.qday.info";

export const txUrl = (hash: string, explorer: string = EXPLORER_URL) => `${explorer}/tx/${hash}`;
export const addressUrl = (addr: string, explorer: string = EXPLORER_URL) => `${explorer}/address/${addr}`;

/** "1.5" -> 1_500_000n */
export const parseUsd = (v: string | number): bigint => parseUnits(String(v), TUSD8_DECIMALS);
/** 1_500_000n -> "1.50" (at least two decimals, up to six) */
export const formatUsd = (v: bigint): string => {
  const s = formatUnits(v, TUSD8_DECIMALS);
  const [i, f = ""] = s.split(".");
  return `${i}.${f.padEnd(2, "0")}`;
};
