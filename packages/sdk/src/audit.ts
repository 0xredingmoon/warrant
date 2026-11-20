import { parseEventLogs, type Address, type Hash, type Log, type PublicClient } from "viem";
import { warrantVaultAbi } from "./abis";
import { formatUsd } from "./chain";
import { reasonName } from "./reasons";

/** Aevum's RPC rejects eth_getLogs over more than 1,000 blocks. */
export const MAX_LOG_RANGE = 1000n;

/**
 * eth_getLogs in chunks of at most `chunk` blocks (default 1,000, inclusive range of 1,000 blocks), oldest first.
 * If a chunk still fails (RPC limits vary) it is split in half and retried.
 */
export async function getLogsChunked(args: {
  publicClient: PublicClient;
  address: Address | Address[];
  fromBlock: bigint;
  toBlock: bigint;
  chunk?: bigint;
  onProgress?: (done: bigint, total: bigint) => void;
}): Promise<Log[]> {
  const chunk = args.chunk && args.chunk < MAX_LOG_RANGE ? args.chunk : MAX_LOG_RANGE;
  const out: Log[] = [];
  const total = args.toBlock - args.fromBlock + 1n;
  const fetchRange = async (from: bigint, to: bigint): Promise<Log[]> => {
    try {
      return await args.publicClient.getLogs({ address: args.address, fromBlock: from, toBlock: to });
    } catch (e) {
      if (from >= to) throw e;
      const mid = from + (to - from) / 2n;
      return [...(await fetchRange(from, mid)), ...(await fetchRange(mid + 1n, to))];
    }
  };
  for (let from = args.fromBlock; from <= args.toBlock; from += chunk) {
    const to = from + chunk - 1n < args.toBlock ? from + chunk - 1n : args.toBlock;
    out.push(...(await fetchRange(from, to)));
    args.onProgress?.(to - args.fromBlock + 1n, total);
  }
  return out;
}

export type AuditKind =
  | "MandateCreated"
  | "MerchantRuleSet"
  | "MandateRevoked"
  | "VaultFrozen"
  | "VaultUnfrozen"
  | "GuardianSet"
  | "NonceInvalidated"
  | "Deposited"
  | "Withdrawn"
  | "PaymentExecuted"
  | "PaymentQueued"
  | "PendingApproved"
  | "PendingRejected"
  | "PendingExpired"
  | "ReceiptNotRecorded";

export interface AuditEntry {
  kind: AuditKind;
  /** one-line, human-readable */
  summary: string;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hash;
  args: Record<string, unknown>;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function summarize(kind: AuditKind, a: any): string {
  switch (kind) {
    case "MandateCreated":
      return `Mandate #${a.mandateId} created for agent ${short(a.agent)} (≤ ${formatUsd(a.params.perTxCap)} per payment, ${formatUsd(a.params.periodCap)} per period, ${formatUsd(a.params.totalCap)} total)`;
    case "MerchantRuleSet":
      return `Mandate #${a.mandateId}: merchant ${short(a.merchant)} ${a.allowed ? "allowed" : "removed"}`;
    case "MandateRevoked":
      return `Mandate #${a.mandateId} revoked by ${short(a.by)}`;
    case "VaultFrozen":
      return `Vault frozen by ${short(a.by)}`;
    case "VaultUnfrozen":
      return `Vault unfrozen by ${short(a.by)}`;
    case "GuardianSet":
      return a.guardian === "0x0000000000000000000000000000000000000000" ? "No guardian set" : `Guardian set to ${short(a.guardian)}`;
    case "NonceInvalidated":
      return `Mandate #${a.mandateId}: intent nonce cancelled by ${short(a.by)}`;
    case "Deposited":
      return `${formatUsd(a.amount)} tUSD8 deposited by ${short(a.from)}`;
    case "Withdrawn":
      return `${formatUsd(a.amount)} tUSD8 withdrawn to ${short(a.to)}`;
    case "PaymentExecuted":
      return `Paid ${formatUsd(a.amount)} tUSD8 to ${short(a.merchant)} under mandate #${a.mandateId}${a.fee ? ` (fee ${formatUsd(a.fee)})` : ""}`;
    case "PaymentQueued":
      return `Queued ${formatUsd(a.amount)} tUSD8 to ${short(a.merchant)} for owner approval (#${a.pendingId})`;
    case "PendingApproved":
      return `Queued payment #${a.pendingId} approved by ${short(a.by)}`;
    case "PendingRejected":
      return `Queued payment #${a.pendingId} rejected by ${short(a.by)}`;
    case "PendingExpired":
      return `Queued payment #${a.pendingId} expired`;
    case "ReceiptNotRecorded":
      return `Registry receipt not recorded for mandate #${a.mandateId}`;
  }
}

/** Decode raw logs from a vault into audit entries (unknown logs are skipped). */
export function decodeAuditLogs(logs: Log[]): AuditEntry[] {
  const parsed = parseEventLogs({ abi: warrantVaultAbi, logs: logs as any, strict: false });
  const out: AuditEntry[] = [];
  for (const l of parsed as any[]) {
    if (!l.eventName) continue;
    const kind = l.eventName as AuditKind;
    out.push({
      kind,
      summary: summarize(kind, l.args),
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      txHash: l.transactionHash,
      args: l.args,
    });
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

/**
 * A vault's constructor emits `GuardianSet` first. For a log read from the vault's creation block, present that first
 * entry as the creation event instead of "guardian set".
 */
export function markCreation(entries: AuditEntry[]): AuditEntry[] {
  return entries.map((e, i) => {
    if (i !== 0 || e.kind !== "GuardianSet") return e;
    const g = String((e.args as any).guardian);
    const none = g === "0x0000000000000000000000000000000000000000";
    return { ...e, summary: none ? "Vault created, no guardian" : `Vault created with guardian ${short(g)}` };
  });
}

/**
 * Full audit trail of a vault from `fromBlock` (use the block the vault was created in) to `toBlock` (default: latest).
 * Reads in ≤1,000-block chunks.
 */
export async function getAuditLog(args: {
  publicClient: PublicClient;
  vault: Address;
  fromBlock: bigint;
  toBlock?: bigint;
  onProgress?: (done: bigint, total: bigint) => void;
}): Promise<AuditEntry[]> {
  const toBlock = args.toBlock ?? (await args.publicClient.getBlockNumber());
  if (toBlock < args.fromBlock) return [];
  const logs = await getLogsChunked({
    publicClient: args.publicClient,
    address: args.vault,
    fromBlock: args.fromBlock,
    toBlock,
    onProgress: args.onProgress,
  });
  return decodeAuditLogs(logs);
}

/**
 * Poll for new audit entries (Aevum has no WebSocket RPC). Returns a function that stops watching.
 * Starts after `fromBlock` (default: the current block), so it only reports new activity.
 */
export function watchAudit(args: {
  publicClient: PublicClient;
  vault: Address;
  onEntries: (entries: AuditEntry[]) => void;
  onError?: (e: unknown) => void;
  fromBlock?: bigint;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let cursor: bigint | undefined = args.fromBlock;
  const tick = async () => {
    try {
      const head = await args.publicClient.getBlockNumber();
      if (cursor === undefined) cursor = head + 1n;
      if (head >= cursor) {
        const entries = await getAuditLog({ publicClient: args.publicClient, vault: args.vault, fromBlock: cursor, toBlock: head });
        cursor = head + 1n;
        if (entries.length) args.onEntries(entries);
      }
    } catch (e) {
      args.onError?.(e);
    }
    if (!stopped) setTimeout(tick, args.intervalMs ?? 2000);
  };
  void tick();
  return () => {
    stopped = true;
  };
}

export { reasonName };
