"use client";
import { useQuery } from "@tanstack/react-query";
import { getAddress, type Address, type Hash } from "viem";
import { warrantVaultAbi } from "@warrant/sdk";
import { publicClient } from "./chain";
import { EXPLORER } from "./config";

/**
 * The two agent runtimes that the same vault has held a mandate for. Every hash here is immutable history: it was
 * mined once and cannot change. The counts and balances beside them are read live from the chain, so a visitor who
 * clicks the attack panel cannot make this section lie.
 */
export interface Runtime {
  /** "eoa" | "smart" */
  kind: "eoa" | "smart";
  /** the address that signs the payment: an EOA or an ERC-4337 smart account */
  agent: Address;
  mandateId: bigint;
  label: string;
  /** one line on why this runtime is interesting */
  note: string;
  /** the contract refused this attempt; the transaction succeeded and recorded the refusal */
  refused?: { txHash: Hash; amount: string; reason: string; reasonCode: number };
  /** the contract allowed this one, inside the same limits */
  paid?: { txHash: Hash; amount: string };
}

export const PROOF_VAULT: Address = getAddress("0xC3Cd5BEF962C78e5f673386f808046E9812e905e");

/** Read from deployments/kernel-account-demo.json and the two attack transactions. Do not edit without a new tx. */
export const RUNTIMES: Runtime[] = [
  {
    kind: "eoa",
    agent: getAddress("0x917F7b87012734bD6bbDa7f6CC1d67103C86E6E3"),
    mandateId: 1n,
    label: "Plain key (EOA)",
    note: "The agent the landing page demonstrates with. It signs with an ordinary secp256k1 key.",
    refused: {
      txHash: "0xbf60d1765e24e25807f75175974fe3785c87dac92b5b0520a297e2373dea90c6",
      amount: "250.00",
      reason: "ExceedsPerTxCap",
      reasonCode: 9,
    },
  },
  {
    kind: "smart",
    agent: getAddress("0xA2eA6Be31038eE2282FBB8a9d5FFECc06d095c2c"),
    mandateId: 2n,
    label: "ERC-4337 smart account",
    note: "A Kernel v3.1 account whose spending policy is this same mandate. It acts through a bundler, and the vault treats it exactly like the key above.",
    refused: {
      txHash: "0xfeb0767cf6a2cc1ad3c3d21a5d59d56ad19c2424bd653f1d116de1f664517157",
      amount: "250.00",
      reason: "ExceedsPerTxCap",
      reasonCode: 9,
    },
    paid: {
      txHash: "0x83ca30591b3e900baf72f6a0979d5755a92ae6c02eb0af7a69e3c3f1f356eef5",
      amount: "0.05",
    },
  },
];

export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;

const read = (functionName: string, args: readonly unknown[] = []) =>
  publicClient.readContract({ address: PROOF_VAULT, abi: warrantVaultAbi, functionName, args } as never) as Promise<any>;

export interface ProofState {
  balance: bigint;
  frozen: boolean;
  /** refusalCount per mandate id, from the contract's own counter */
  refusals: bigint[];
  /** lifetime spend per mandate, as the contract books it */
  spent: bigint[];
  /** the agent address the vault has on file for each mandate; proves the account really is the agent */
  agents: Address[];
}

/** Live state for the proof section. Reads the demo vault directly, so no relayer or indexer is involved. */
export function useProofState() {
  return useQuery<ProofState>({
    queryKey: ["proof", PROOF_VAULT],
    queryFn: async () => {
      const ids = RUNTIMES.map((r) => r.mandateId);
      const [balance, frozen, agents, spent, refusals] = await Promise.all([
        read("balance") as Promise<bigint>,
        read("frozen") as Promise<boolean>,
        Promise.all(ids.map((id) => read("getMandate", [id]).then((m: any) => m.params.agent as Address))),
        Promise.all(ids.map((id) => read("getMandate", [id]).then((m: any) => m.spentTotal as bigint))),
        Promise.all(ids.map((id) => read("refusalCount", [id]) as Promise<bigint>)),
      ]);
      return { balance, frozen, agents, spent, refusals };
    },
    refetchInterval: 15_000,
  });
}

/** The two calls that make the account's identity checkable from the explorer, not just from its address. */
export function useKernelIdentity() {
  const account = RUNTIMES[1].agent;
  return useQuery({
    queryKey: ["kernel-identity", account],
    queryFn: async () => {
      const abi = [
        { type: "function", name: "accountId", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
        { type: "function", name: "rootValidator", stateMutability: "view", inputs: [], outputs: [{ type: "bytes21" }] },
      ] as const;
      const [id, validator] = await Promise.all([
        publicClient.readContract({ address: account, abi, functionName: "accountId" }) as Promise<string>,
        publicClient.readContract({ address: account, abi, functionName: "rootValidator" }) as Promise<string>,
      ]);
      return { accountId: id, rootValidator: validator };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
