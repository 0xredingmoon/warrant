"use client";
import { useAccount, useChainId, useWalletClient } from "wagmi";
import type { WalletClient } from "viem";
import type { Clients } from "@warrant/sdk";
import { CHAIN_ID } from "./config";
import { useClient } from "./queries";

/** Clients for writing: only defined when a wallet is connected on the right network. */
export function useClients(): { clients?: Clients; wallet?: WalletClient; ready: boolean; wrongNetwork: boolean } {
  const publicClient = useClient();
  const { data: wallet } = useWalletClient();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const walletChain = wallet?.chain?.id;
  const wrongNetwork = isConnected && walletChain !== undefined && walletChain !== CHAIN_ID;
  void chainId;
  if (!wallet || !wallet.account || wrongNetwork) return { ready: false, wrongNetwork };
  return { clients: { publicClient, walletClient: wallet }, wallet, ready: true, wrongNetwork };
}
