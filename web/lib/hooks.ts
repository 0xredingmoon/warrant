"use client";
import { useAccount, useWalletClient } from "wagmi";
import type { WalletClient } from "viem";
import type { Clients } from "@warrant/sdk";
import { CHAIN_ID } from "./config";
import { useClient } from "./queries";

/** Clients for writing: only defined when a wallet is connected on the right network. */
export function useClients(): { clients?: Clients; wallet?: WalletClient; ready: boolean; wrongNetwork: boolean } {
  const publicClient = useClient();
  const { data: wallet } = useWalletClient();
  // The account's chainId is the wallet's real network. The wallet client's `chain` is undefined on a network the app
  // doesn't list, which would make a wallet on Ethereum mainnet look fine.
  const { isConnected, chainId: walletChain } = useAccount();
  const wrongNetwork = isConnected && walletChain !== undefined && walletChain !== CHAIN_ID;
  if (!wallet || !wallet.account || wrongNetwork) return { ready: false, wrongNetwork };
  return { clients: { publicClient, walletClient: wallet }, wallet, ready: true, wrongNetwork };
}
