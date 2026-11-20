"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address, PublicClient } from "viem";
import { publicClient } from "./chain";
import {
  getAgentReputation,
  getAuditLog,
  getTokenBalance,
  getVaultCreatedBlock,
  getVaultState,
  getVaultsOf,
  randomBytes32,
  CREATE_VAULT_GAS_LIMIT,
  warrantFactoryAbi,
  getWindow,
  listMandates,
  listPending,
  type AuditEntry,
  type WindowState,
} from "@warrant/sdk";
import { zeroAddress } from "viem";
import { DEPLOY_BLOCK, FACTORY, INDEXER_URL, REGISTRY, TOKEN } from "./config";

const POLL = 4000;

export function useClient(): PublicClient {
  return publicClient;
}

/** tQDAY balance on Aevum (gas), for the connected address. */
export function useGasBalance(owner?: Address) {
  return useQuery({
    queryKey: ["gas", owner],
    enabled: !!owner,
    queryFn: () => publicClient.getBalance({ address: owner! }),
    refetchInterval: 10_000,
  });
}

export function useVaults(owner?: Address) {
  const client = useClient();
  return useQuery({
    queryKey: ["vaults", owner],
    enabled: !!owner,
    queryFn: () => getVaultsOf(client, FACTORY, owner!),
    refetchInterval: POLL * 2,
  });
}

export function useVault(vault?: Address) {
  const client = useClient();
  return useQuery({
    queryKey: ["vault", vault],
    enabled: !!vault,
    queryFn: async () => {
      const [state, mandates, pending] = await Promise.all([
        getVaultState(client, vault!),
        listMandates(client, vault!),
        listPending(client, vault!, { onlyOpen: true }),
      ]);
      const windows = new Map<string, WindowState>(
        await Promise.all(mandates.map(async (m) => [m.id.toString(), await getWindow(client, vault!, m.id)] as const)),
      );
      return { state, mandates, pending, windows };
    },
    refetchInterval: POLL,
  });
}

export function useWalletTokenBalance(owner?: Address) {
  const client = useClient();
  return useQuery({
    queryKey: ["tusd8", owner],
    enabled: !!owner,
    queryFn: () => getTokenBalance(client, TOKEN, owner!),
    refetchInterval: POLL * 2,
  });
}

interface Cached {
  last: string;
  entries: (Omit<AuditEntry, "blockNumber" | "args"> & { blockNumber: string; args: Record<string, string> })[];
}
const cacheKey = (vault: string) => `warrant:audit:v2:${FACTORY}:${vault}`;

function readCache(vault: string): { last: bigint; entries: AuditEntry[] } | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(vault));
    if (!raw) return undefined;
    const c = JSON.parse(raw) as Cached;
    return {
      last: BigInt(c.last),
      entries: c.entries.map((e) => ({ ...e, blockNumber: BigInt(e.blockNumber), args: revive(e.args) })),
    };
  } catch {
    return undefined;
  }
}
// bigint values are stored as "bigint:123" so they survive JSON
const revive = (a: Record<string, string>) => JSON.parse(JSON.stringify(a), (_k, v) => (typeof v === "string" && v.startsWith("bigint:") ? BigInt(v.slice(7)) : v));
const freeze = (a: Record<string, unknown>) => JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `bigint:${v}` : v)));

/**
 * Audit trail from the vault's creation block (`createdAtBlock`, stored in the contract; older vaults fall back to the
 * deployment block). The first load asks the explorer's index for the whole history and reads only the newest blocks
 * from the RPC; if the explorer is down it reads the RPC in chunks of at most 1,000 blocks (Aevum's eth_getLogs limit).
 * The result is cached per vault in localStorage, so later refreshes only read the blocks since.
 */
export function useAudit(vault?: Address) {
  const client = useClient();
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["audit", vault],
    enabled: !!vault,
    queryFn: async () => {
      const cached = readCache(vault!);
      const head = await client.getBlockNumber();
      const from = cached ? cached.last + 1n : await getVaultCreatedBlock(client, vault!).catch(() => DEPLOY_BLOCK);
      let fresh: AuditEntry[] = [];
      if (head >= from) {
        fresh = await getAuditLog({
          publicClient: client,
          vault: vault!,
          fromBlock: from,
          toBlock: head,
          indexerUrl: cached ? undefined : INDEXER_URL,
          onSource: cached ? undefined : (s) => qc.setQueryData(["audit-source", vault], s),
          onProgress: (done, total) => qc.setQueryData(["audit-progress", vault], Number((done * 100n) / total)),
        });
      }
      const all = [...(cached?.entries ?? []), ...fresh];
      try {
        localStorage.setItem(
          cacheKey(vault!),
          JSON.stringify({
            last: head.toString(),
            entries: all.map((e) => ({ ...e, blockNumber: e.blockNumber.toString(), args: freeze(e.args) })),
          }),
        );
      } catch {
        /* storage full or blocked: the log just reloads next time */
      }
      qc.setQueryData(["audit-progress", vault], 100);
      return all;
    },
    refetchInterval: POLL,
    structuralSharing: false,
  });
}

export function useAuditSource(vault?: Address) {
  return useQuery<"indexer" | "rpc" | undefined>({ queryKey: ["audit-source", vault], queryFn: () => undefined, enabled: false, initialData: undefined }).data;
}

export function useAuditProgress(vault?: Address) {
  return useQuery<number>({ queryKey: ["audit-progress", vault], queryFn: () => 0, enabled: false, initialData: 0 }).data;
}

export function useReputation(agentId?: bigint) {
  const client = useClient();
  return useQuery({
    queryKey: ["reputation", agentId?.toString()],
    enabled: agentId !== undefined && agentId > 0n,
    queryFn: () => getAgentReputation(client, REGISTRY, agentId!),
    refetchInterval: POLL * 3,
  });
}

/**
 * What creating a vault costs in gas right now: the gas the call needs times the gas price the SDK sends with it
 * (the node's price plus 20%), and the most a wallet will show for it (gas limit times that price).
 */
export function useCreateVaultFee(account?: Address) {
  return useQuery({
    queryKey: ["create-vault-fee", account],
    enabled: !!account,
    staleTime: 30_000,
    queryFn: async () => {
      const [gas, price] = await Promise.all([
        publicClient.estimateContractGas({ address: FACTORY, abi: warrantFactoryAbi, functionName: "createVault", args: [zeroAddress, randomBytes32()], account: account! }),
        publicClient.getGasPrice(),
      ]);
      const sent = (price * 12n) / 10n;
      return { expected: gas * sent, most: CREATE_VAULT_GAS_LIMIT * sent };
    },
  });
}
