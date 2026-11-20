import { CHAIN_ID, EXPLORER, RPC_URL } from "./config";

interface Eip1193 {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/** What `wallet_addEthereumChain` needs for QDay Aevum testnet. */
export const AEVUM_CHAIN_PARAMS = {
  chainId: `0x${CHAIN_ID.toString(16)}`,
  chainName: "QDay Aevum testnet",
  nativeCurrency: { name: "QDay", symbol: "tQDAY", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER],
} as const;

export type SwitchResult = { ok: true } | { ok: false; reason: "rejected" | "failed"; message: string };

/**
 * Ask the wallet to switch to Aevum, adding the network first if it doesn't know it (error 4902).
 * A "no" in the wallet is reported as `rejected`, not as an error.
 */
export async function ensureAevum(provider: Eip1193 | undefined = (typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum) : undefined)): Promise<SwitchResult> {
  if (!provider) return { ok: false, reason: "failed", message: "No browser wallet found." };
  const code = (e: unknown) => (e as { code?: number; data?: { originalError?: { code?: number } } })?.code ?? (e as any)?.data?.originalError?.code;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: AEVUM_CHAIN_PARAMS.chainId }] });
    return { ok: true };
  } catch (e) {
    if (code(e) === 4001) return { ok: false, reason: "rejected", message: "You declined the network switch in your wallet." };
    if (code(e) !== 4902 && code(e) !== -32603) return { ok: false, reason: "failed", message: (e as Error).message?.split("\n")[0] ?? "Could not switch network." };
  }
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [AEVUM_CHAIN_PARAMS] });
    return { ok: true };
  } catch (e) {
    if (code(e) === 4001) return { ok: false, reason: "rejected", message: "You declined adding the network in your wallet." };
    return { ok: false, reason: "failed", message: (e as Error).message?.split("\n")[0] ?? "Could not add the network." };
  }
}
