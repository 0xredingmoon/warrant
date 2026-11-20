import { erc20Abi, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { agentRegistryAbi, warrantFactoryAbi, warrantVaultAbi } from "./abis";
import { reasonMessage, reasonName, toCheckResult, type CheckResult, type ReasonName } from "./reasons";
import { decodeRejection, writeLegacy, type Clients, type TxResult } from "./tx";
import type {
  InvoiceState,
  Mandate,
  MandateParams,
  MerchantRule,
  PaymentIntent,
  Pending,
  PendingStatus,
  WindowState,
} from "./types";

const PENDING_STATUS: PendingStatus[] = ["None", "Open", "Approved", "Rejected", "Expired"];
const INVOICE_STATE: InvoiceState[] = ["None", "Pending", "Paid"];

/* ------------------------------------------------------------------ factory */

/** Gas limit createVault sends. Wallets show limit x price as the most the transaction can cost; the charge is what it uses (about 3.9M). */
export const CREATE_VAULT_GAS_LIMIT = 4_500_000n;

/** Deploy the caller's vault through the factory. Returns the vault address. */
export async function createVault(args: {
  clients: Clients;
  factory: Address;
  /** optional risk-reduction key: can freeze and revoke, never move funds. Default: none. */
  guardian?: Address;
  salt?: Hex;
}): Promise<TxResult & { vault: Address }> {
  const zero32 = ("0x" + "00".repeat(32)) as Hex;
  const res = await writeLegacy(args.clients, {
    address: args.factory,
    abi: warrantFactoryAbi,
    functionName: "createVault",
    args: [args.guardian ?? "0x0000000000000000000000000000000000000000", args.salt ?? zero32],
    gas: CREATE_VAULT_GAS_LIMIT,
  });
  const logs = parseEventLogs({ abi: warrantFactoryAbi, logs: res.receipt.logs, eventName: "VaultCreated" });
  const vault = logs[0]?.args.vault;
  if (!vault) throw new Error("VaultCreated event not found");
  return { ...res, vault };
}

export const getVaultsOf = (publicClient: PublicClient, factory: Address, owner: Address) =>
  publicClient.readContract({ address: factory, abi: warrantFactoryAbi, functionName: "vaultsOf", args: [owner] }) as Promise<
    readonly Address[]
  >;

export async function getFactoryInfo(publicClient: PublicClient, factory: Address) {
  const [feeBps, treasury] = (await publicClient.readContract({
    address: factory,
    abi: warrantFactoryAbi,
    functionName: "feeConfig",
  })) as readonly [number, Address];
  const registry = (await publicClient.readContract({
    address: factory,
    abi: warrantFactoryAbi,
    functionName: "registry",
  })) as Address;
  const token = (await publicClient.readContract({ address: factory, abi: warrantFactoryAbi, functionName: "token" })) as Address;
  return { feeBps, treasury, registry, token };
}

/* ------------------------------------------------------------------ reads */

export interface VaultState {
  address: Address;
  owner: Address;
  guardian: Address;
  frozen: boolean;
  token: Address;
  registry: Address;
  balance: bigint;
  mandateCount: bigint;
  pendingCount: bigint;
  /** block the vault was created in: where its audit log starts */
  createdAtBlock: bigint;
}

export async function getVaultState(publicClient: PublicClient, vault: Address): Promise<VaultState> {
  const read = (functionName: string) =>
    publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName } as any) as Promise<any>;
  const [owner, guardian, frozen, token, registry, balance, mandateCount, pendingCount, createdAtBlock] = await Promise.all([
    read("owner"),
    read("guardian"),
    read("frozen"),
    read("token"),
    read("registry"),
    read("balance"),
    read("mandateCount"),
    read("pendingCount"),
    read("createdAtBlock"),
  ]);
  return { address: vault, owner, guardian, frozen, token, registry, balance, mandateCount, pendingCount, createdAtBlock };
}

export async function getMandate(publicClient: PublicClient, vault: Address, id: bigint): Promise<Mandate> {
  const m = (await publicClient.readContract({
    address: vault,
    abi: warrantVaultAbi,
    functionName: "getMandate",
    args: [id],
  })) as any;
  return {
    id,
    params: {
      agent: m.params.agent,
      agentId: m.params.agentId,
      perTxCap: m.params.perTxCap,
      periodCap: m.params.periodCap,
      totalCap: m.params.totalCap,
      periodLength: Number(m.params.periodLength),
      validAfter: Number(m.params.validAfter),
      expiry: Number(m.params.expiry),
      approvalThreshold: m.params.approvalThreshold,
      approvalWindow: Number(m.params.approvalWindow),
    },
    spentTotal: m.spentTotal,
    revoked: m.revoked,
  };
}

/** Rolling-window usage of a mandate's period cap, and when the oldest counted spend frees up. */
export async function getWindow(publicClient: PublicClient, vault: Address, id: bigint): Promise<WindowState> {
  const [spent, next] = await Promise.all([
    publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "periodSpent", args: [id] }) as Promise<bigint>,
    publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "nextRelease", args: [id] }) as Promise<readonly [bigint, bigint]>,
  ]);
  return { spent, nextReleaseAmount: next[0], nextReleaseAt: Number(next[1]) };
}

export async function listMandates(publicClient: PublicClient, vault: Address): Promise<Mandate[]> {
  const count = (await publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "mandateCount" })) as bigint;
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  return Promise.all(ids.map((id) => getMandate(publicClient, vault, id)));
}

export async function getMerchantRule(publicClient: PublicClient, vault: Address, id: bigint, merchant: Address): Promise<MerchantRule> {
  const r = (await publicClient.readContract({
    address: vault,
    abi: warrantVaultAbi,
    functionName: "getMerchantRule",
    args: [id, merchant],
  })) as any;
  return { allowed: r.allowed, perTxCap: r.perTxCap, totalCap: r.totalCap };
}

/** The most the agent could pay `merchant` right now under this mandate (ignores balance and approvals). */
export const getRemainingAllowance = (publicClient: PublicClient, vault: Address, id: bigint, merchant: Address) =>
  publicClient.readContract({
    address: vault,
    abi: warrantVaultAbi,
    functionName: "remainingAllowance",
    args: [id, merchant],
  }) as Promise<bigint>;

export async function getPending(publicClient: PublicClient, vault: Address, id: bigint): Promise<Pending> {
  const q = (await publicClient.readContract({
    address: vault,
    abi: warrantVaultAbi,
    functionName: "getPending",
    args: [id],
  })) as any;
  return {
    id,
    mandateId: q.mandateId,
    merchant: q.merchant,
    amount: q.amount,
    createdAt: Number(q.createdAt),
    expiresAt: Number(q.expiresAt),
    status: PENDING_STATUS[Number(q.status)] ?? "None",
    invoiceRef: q.invoiceRef,
    intentHash: q.intentHash,
  };
}

/** Queued payments, newest first. `onlyOpen` (default) hides approved/rejected/expired ones. */
export async function listPending(publicClient: PublicClient, vault: Address, opts: { onlyOpen?: boolean } = {}): Promise<Pending[]> {
  const count = (await publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "pendingCount" })) as bigint;
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const all = await Promise.all(ids.map((id) => getPending(publicClient, vault, id)));
  return all.filter((p) => (opts.onlyOpen ?? true ? p.status === "Open" : true)).reverse();
}

export async function getInvoiceState(publicClient: PublicClient, vault: Address, merchant: Address, invoiceRef: Hex): Promise<InvoiceState> {
  const s = (await publicClient.readContract({
    address: vault,
    abi: warrantVaultAbi,
    functionName: "invoiceState",
    args: [merchant, invoiceRef],
  })) as number;
  return INVOICE_STATE[Number(s)] ?? "None";
}

export const getTokenBalance = (publicClient: PublicClient, token: Address, who: Address) =>
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

/* ------------------------------------------------------------------ dry runs */

/** Dry-run a signed intent. Never reverts: returns the on-chain reason plus a plain-language message. */
export async function check(args: {
  publicClient: PublicClient;
  vault: Address;
  intent: PaymentIntent;
  signature: Hex;
}): Promise<CheckResult> {
  const code = (await args.publicClient.readContract({
    address: args.vault,
    abi: warrantVaultAbi,
    functionName: "check",
    args: [args.intent, args.signature],
  })) as number;
  return toCheckResult(Number(code));
}

/** Dry-run the terms only (no signature, nonce or deadline). Good for an agent that wants to plan a spend. */
export async function checkTerms(args: {
  publicClient: PublicClient;
  vault: Address;
  mandateId: bigint;
  merchant: Address;
  amount: bigint;
  invoiceRef?: Hex;
}): Promise<CheckResult> {
  const code = (await args.publicClient.readContract({
    address: args.vault,
    abi: warrantVaultAbi,
    functionName: "checkTerms",
    args: [args.mandateId, args.merchant, args.amount, args.invoiceRef ?? (("0x" + "00".repeat(32)) as Hex)],
  })) as number;
  return toCheckResult(Number(code));
}

/* ------------------------------------------------------------------ owner actions */

export async function createMandate(args: {
  clients: Clients;
  vault: Address;
  params: MandateParams;
  merchants: { address: Address; rule?: Partial<MerchantRule> }[];
}): Promise<TxResult & { mandateId: bigint }> {
  const rules: MerchantRule[] = args.merchants.map((m) => ({
    allowed: m.rule?.allowed ?? true,
    perTxCap: m.rule?.perTxCap ?? 0n,
    totalCap: m.rule?.totalCap ?? 0n,
  }));
  const res = await writeLegacy(args.clients, {
    address: args.vault,
    abi: warrantVaultAbi,
    functionName: "createMandate",
    args: [args.params, args.merchants.map((m) => m.address), rules],
  });
  const logs = parseEventLogs({ abi: warrantVaultAbi, logs: res.receipt.logs, eventName: "MandateCreated" });
  const mandateId = logs[0]?.args.mandateId;
  if (mandateId === undefined) throw new Error("MandateCreated event not found");
  return { ...res, mandateId };
}

const ownerCall = (clients: Clients, vault: Address, functionName: string, args: readonly unknown[] = []) =>
  writeLegacy(clients, { address: vault, abi: warrantVaultAbi, functionName, args });

export const setMerchantRule = (clients: Clients, vault: Address, mandateId: bigint, merchant: Address, rule: MerchantRule) =>
  ownerCall(clients, vault, "setMerchantRule", [mandateId, merchant, rule]);
/** One transaction, takes effect immediately and permanently. Owner or guardian. */
export const revokeMandate = (clients: Clients, vault: Address, mandateId: bigint) => ownerCall(clients, vault, "revokeMandate", [mandateId]);
/** Panic switch: nothing can be paid or approved until the owner unfreezes. Owner or guardian. */
export const freezeAll = (clients: Clients, vault: Address) => ownerCall(clients, vault, "freezeAll");
/** Only the owner can lift a freeze. */
export const unfreeze = (clients: Clients, vault: Address) => ownerCall(clients, vault, "unfreeze");
export const setGuardian = (clients: Clients, vault: Address, guardian: Address) => ownerCall(clients, vault, "setGuardian", [guardian]);
export const withdraw = (clients: Clients, vault: Address, to: Address, amount: bigint) => ownerCall(clients, vault, "withdraw", [to, amount]);
/** Owner approves a queued payment. It is re-validated against the mandate at this moment. */
export const approvePending = (clients: Clients, vault: Address, pendingId: bigint) => ownerCall(clients, vault, "approve", [pendingId]);
/** Same as `approvePending` with an owner signature (see `signApproval`); anyone can submit it. */
export const approvePendingBySig = (clients: Clients, vault: Address, pendingId: bigint, deadline: bigint, signature: Hex) =>
  ownerCall(clients, vault, "approveBySig", [pendingId, deadline, signature]);
export const rejectPending = (clients: Clients, vault: Address, pendingId: bigint) => ownerCall(clients, vault, "reject", [pendingId]);
export const expirePending = (clients: Clients, vault: Address, pendingId: bigint) => ownerCall(clients, vault, "expirePending", [pendingId]);
export const invalidateNonce = (clients: Clients, vault: Address, mandateId: bigint, nonce: Hex) =>
  ownerCall(clients, vault, "invalidateNonce", [mandateId, nonce]);

/** Fund the vault with an allowance: approve (if needed) then deposit. Two transactions from the depositor. */
export async function deposit(args: { clients: Clients; vault: Address; token: Address; amount: bigint }): Promise<TxResult> {
  const { clients, vault, token, amount } = args;
  const owner = clients.walletClient.account!.address;
  const allowance = await clients.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, vault],
  });
  if (allowance < amount) {
    await writeLegacy(clients, { address: token, abi: erc20Abi, functionName: "approve", args: [vault, amount] });
  }
  return ownerCall(clients, vault, "deposit", [amount]);
}

/** Submit an EIP-3009 deposit yourself (a relayer normally does this, see the relayer's /v1/deposit). */
export const depositWithAuthorization = (
  clients: Clients,
  vault: Address,
  a: { from: Address; amount: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; signature: Hex },
) => {
  const sig = a.signature.slice(2);
  const r = ("0x" + sig.slice(0, 64)) as Hex;
  const s = ("0x" + sig.slice(64, 128)) as Hex;
  const v = parseInt(sig.slice(128, 130), 16);
  return ownerCall(clients, vault, "depositWithAuthorization", [a.from, a.amount, a.validAfter, a.validBefore, a.nonce, v, r, s]);
};

/* ------------------------------------------------------------------ payments */

export interface PayOutcome extends TxResult {
  /** "executed": money moved. "queued": waiting for owner approval (see `pendingId`). */
  status: "executed" | "queued";
  pendingId?: bigint;
}

/**
 * Submit a signed intent yourself (you pay the gas). Normally a relayer does this: see `relayPay`.
 * Throws `WarrantRejected` with the on-chain reason if the vault refuses.
 */
export async function pay(args: { clients: Clients; vault: Address; intent: PaymentIntent; signature: Hex }): Promise<PayOutcome> {
  let res: TxResult;
  try {
    res = await writeLegacy(args.clients, {
      address: args.vault,
      abi: warrantVaultAbi,
      functionName: "pay",
      args: [args.intent, args.signature],
      gas: 600_000n,
    });
  } catch (e) {
    throw decodeRejection(e) ?? e;
  }
  const queued = parseEventLogs({ abi: warrantVaultAbi, logs: res.receipt.logs, eventName: "PaymentQueued" })[0];
  return queued ? { ...res, status: "queued", pendingId: queued.args.pendingId } : { ...res, status: "executed" };
}

export interface SubmitOutcome extends TxResult {
  /** "executed": money moved. "queued": waiting for owner approval. "refused": the rules said no and the refusal is on-chain. */
  status: "executed" | "queued" | "refused";
  pendingId?: bigint;
  /** set when `status` is "refused" */
  refusal?: { code: number; reason: ReasonName; message: string };
}

/**
 * Like `pay`, but a refused payment is recorded on-chain (`PaymentRefused`, no funds move) instead of reverting.
 * The intent must still carry the agent's valid signature and be unexpired and unused, otherwise this throws
 * `WarrantRejected` exactly like `pay`. This is what the relayer submits.
 */
export async function payOrRefuse(args: { clients: Clients; vault: Address; intent: PaymentIntent; signature: Hex }): Promise<SubmitOutcome> {
  let res: TxResult;
  try {
    res = await writeLegacy(args.clients, {
      address: args.vault,
      abi: warrantVaultAbi,
      functionName: "payOrRefuse",
      args: [args.intent, args.signature],
      gas: 600_000n,
    });
  } catch (e) {
    throw decodeRejection(e) ?? e;
  }
  const logs = parseEventLogs({ abi: warrantVaultAbi, logs: res.receipt.logs });
  const refused = logs.find((l) => l.eventName === "PaymentRefused") as any;
  if (refused) {
    const code = Number(refused.args.reason);
    return { ...res, status: "refused", refusal: { code, reason: reasonName(code), message: reasonMessage(code) } };
  }
  const queued = logs.find((l) => l.eventName === "PaymentQueued") as any;
  return queued ? { ...res, status: "queued", pendingId: queued.args.pendingId } : { ...res, status: "executed" };
}

export { agentRegistryAbi };
