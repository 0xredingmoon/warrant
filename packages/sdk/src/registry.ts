import { parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { agentRegistryAbi } from "./abis";
import type { TypedDataSigner } from "./intents";
import { writeLegacy, type Clients, type TxResult } from "./tx";

export const registryDomain = (chainId: number, registry: Address) =>
  ({ name: "WarrantAgentRegistry", version: "1", chainId, verifyingContract: registry }) as const;

export const agentWalletTypes = {
  AgentWalletSet: [
    { name: "agentId", type: "uint256" },
    { name: "newWallet", type: "address" },
    { name: "owner", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Register an agent identity (ERC-8004-shaped ERC-721). `agentURI` points at the agent card (JSON). */
export async function registerAgent(args: { clients: Clients; registry: Address; agentURI: string }): Promise<TxResult & { agentId: bigint }> {
  const res = await writeLegacy(args.clients, {
    address: args.registry,
    abi: agentRegistryAbi,
    functionName: "register",
    args: [args.agentURI],
  });
  const ev = parseEventLogs({ abi: agentRegistryAbi, logs: res.receipt.logs, eventName: "Registered" })[0];
  if (!ev) throw new Error("Registered event not found");
  return { ...res, agentId: ev.args.agentId };
}

/** The new wallet (the agent's key) proves control by signing; the agent's owner then submits `setAgentWallet`. */
export function signAgentWallet(args: {
  signer: TypedDataSigner;
  chainId: number;
  registry: Address;
  agentId: bigint;
  newWallet: Address;
  owner: Address;
  deadline: bigint;
}): Promise<Hex> {
  return args.signer.signTypedData({
    domain: registryDomain(args.chainId, args.registry),
    types: agentWalletTypes,
    primaryType: "AgentWalletSet",
    message: { agentId: args.agentId, newWallet: args.newWallet, owner: args.owner, deadline: args.deadline },
  });
}

export const setAgentWallet = (args: {
  clients: Clients;
  registry: Address;
  agentId: bigint;
  newWallet: Address;
  deadline: bigint;
  signature: Hex;
}) =>
  writeLegacy(args.clients, {
    address: args.registry,
    abi: agentRegistryAbi,
    functionName: "setAgentWallet",
    args: [args.agentId, args.newWallet, args.deadline, args.signature],
  });

/** The paid merchant rates the agent for one payment. `value` is fixed-point with `valueDecimals` (87 with 0 = "87/100"). */
export const giveFeedback = (args: {
  clients: Clients;
  registry: Address;
  receiptId: Hex;
  value: bigint;
  valueDecimals?: number;
  tag1?: string;
  tag2?: string;
  feedbackURI?: string;
  feedbackHash?: Hex;
}) =>
  writeLegacy(args.clients, {
    address: args.registry,
    abi: agentRegistryAbi,
    functionName: "giveFeedback",
    args: [
      args.receiptId,
      args.value,
      args.valueDecimals ?? 0,
      args.tag1 ?? "",
      args.tag2 ?? "",
      args.feedbackURI ?? "",
      args.feedbackHash ?? (("0x" + "00".repeat(32)) as Hex),
    ],
  });

export const revokeFeedback = (clients: Clients, registry: Address, receiptId: Hex) =>
  writeLegacy(clients, { address: registry, abi: agentRegistryAbi, functionName: "revokeFeedback", args: [receiptId] });

export const receiptIdOf = (publicClient: PublicClient, registry: Address, vault: Address, merchant: Address, invoiceRef: Hex) =>
  publicClient.readContract({
    address: registry,
    abi: agentRegistryAbi,
    functionName: "receiptIdOf",
    args: [vault, merchant, invoiceRef],
  }) as Promise<Hex>;

export interface AgentReputation {
  agentId: bigint;
  owner: Address;
  agentURI: string;
  wallet: Address;
  feedbackCount: number;
  /** average feedback value (18-decimal fixed point converted to a JS number, e.g. 95) */
  averageValue: number;
  paymentCount: number;
  /** verified volume paid to merchants through vaults, in tUSD8 units */
  verifiedVolume: bigint;
}

export async function getAgentReputation(publicClient: PublicClient, registry: Address, agentId: bigint): Promise<AgentReputation> {
  const [owner, agentURI, wallet, summary] = await Promise.all([
    publicClient.readContract({ address: registry, abi: agentRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    publicClient.readContract({ address: registry, abi: agentRegistryAbi, functionName: "agentURI", args: [agentId] }),
    publicClient.readContract({ address: registry, abi: agentRegistryAbi, functionName: "getAgentWallet", args: [agentId] }),
    publicClient.readContract({ address: registry, abi: agentRegistryAbi, functionName: "getSummary", args: [agentId] }),
  ]);
  const [feedbackCount, averageValue, paymentCount, verifiedVolume] = summary as readonly [bigint, bigint, bigint, bigint];
  return {
    agentId,
    owner: owner as Address,
    agentURI: agentURI as string,
    wallet: wallet as Address,
    feedbackCount: Number(feedbackCount),
    averageValue: Number(averageValue) / 1e18,
    paymentCount: Number(paymentCount),
    verifiedVolume,
  };
}

export async function getReceipt(publicClient: PublicClient, registry: Address, receiptId: Hex) {
  const r = (await publicClient.readContract({
    address: registry,
    abi: agentRegistryAbi,
    functionName: "getReceipt",
    args: [receiptId],
  })) as any;
  return r as { agentId: bigint; vault: Address; merchant: Address; amount: bigint; paidAt: number; invoiceRef: Hex; exists: boolean };
}
