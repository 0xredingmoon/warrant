"use client";
import type { WalletClient } from "viem";
import type { Clients } from "@warrant/sdk";
import { publicClient } from "./chain";
import { useWallet } from "./wallet";

/** Clients for writing: only defined when a wallet is connected and on the right network. */
export function useClients(): { clients?: Clients; wallet?: WalletClient; ready: boolean; wrongNetwork: boolean } {
  const { walletClient, wrongNetwork } = useWallet();
  if (!walletClient || !walletClient.account) return { ready: false, wrongNetwork };
  return { clients: { publicClient, walletClient }, wallet: walletClient, ready: true, wrongNetwork };
}
