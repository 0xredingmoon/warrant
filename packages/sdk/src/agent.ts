import type { Address, Hex, PublicClient } from "viem";
import { formatUsd, parseUsd, txUrl } from "./chain";
import { buildIntent, signIntent, type TypedDataSigner } from "./intents";
import { relayPay } from "./relayer-client";
import { Reason, toCheckResult, type CheckResult } from "./reasons";
import type { Clients } from "./tx";
import { WarrantRejected } from "./tx";
import { check, checkTerms, getMandate, getMerchantRule, getRemainingAllowance, pay } from "./vault";

export interface WarrantAgentConfig {
  /** the agent's key (a viem local account). It only ever signs intents: it needs no gas. */
  signer: TypedDataSigner & { address: Address };
  publicClient: PublicClient;
  chainId: number;
  vault: Address;
  mandateId: bigint;
  /** submit through this relayer (recommended: the agent pays no gas) */
  relayerUrl?: string;
  relayerApiKey?: string;
  /** without a relayer the agent submits itself and needs a wallet client with gas */
  clients?: Clients;
  explorerUrl?: string;
}

export interface AgentPayResult {
  status: "executed" | "queued" | "rejected";
  check: CheckResult;
  /** the agent's own words for the owner/merchant */
  message: string;
  amount: string;
  merchant: Address;
  invoiceRef: Hex;
  txHash?: Hex;
  explorerUrl?: string;
  pendingId?: string;
}

/** The agent-side handle on one mandate: ask "can I pay this?" and pay, with plain-language answers. */
export class WarrantAgent {
  constructor(public readonly cfg: WarrantAgentConfig) {}

  get address() {
    return this.cfg.signer.address;
  }

  /** What this mandate allows and what is left, optionally for a specific merchant. */
  async describe(merchant?: Address) {
    const { publicClient, vault, mandateId } = this.cfg;
    const m = await getMandate(publicClient, vault, mandateId);
    const p = m.params;
    const now = Math.floor(Date.now() / 1000);
    const base = {
      mandateId: mandateId.toString(),
      agent: p.agent,
      revoked: m.revoked,
      perPaymentCap: formatUsd(p.perTxCap),
      periodCap: formatUsd(p.periodCap),
      periodSpent: formatUsd(m.periodSpent),
      totalCap: formatUsd(p.totalCap),
      totalSpent: formatUsd(m.spentTotal),
      approvalRequiredAtOrAbove: p.approvalThreshold === 0n ? null : formatUsd(p.approvalThreshold),
      validFrom: new Date(p.validAfter * 1000).toISOString(),
      expires: new Date(p.expiry * 1000).toISOString(),
      active: !m.revoked && now >= p.validAfter && now < p.expiry,
    };
    if (!merchant) return base;
    const [rule, remaining] = await Promise.all([
      getMerchantRule(publicClient, vault, mandateId, merchant),
      getRemainingAllowance(publicClient, vault, mandateId, merchant),
    ]);
    return { ...base, merchant, merchantAllowed: rule.allowed, remainingForThisMerchant: formatUsd(remaining) };
  }

  /** Dry run, no signature, no gas. `amount` is a decimal string like "4.50". */
  async check(args: { merchant: Address; amount: string | bigint; invoiceRef?: Hex }): Promise<CheckResult> {
    return checkTerms({
      publicClient: this.cfg.publicClient,
      vault: this.cfg.vault,
      mandateId: this.cfg.mandateId,
      merchant: args.merchant,
      amount: typeof args.amount === "bigint" ? args.amount : parseUsd(args.amount),
      invoiceRef: args.invoiceRef,
    });
  }

  /**
   * Sign and submit a payment. Never throws for a refusal: look at `status` ("executed" | "queued" | "rejected")
   * and `message`. `context` (why the agent is paying) is hashed on-chain as `intentHash`.
   * Pass the same `invoiceRef` when retrying: an invoice can never be paid twice.
   */
  async pay(args: { merchant: Address; amount: string | bigint; invoiceRef?: Hex; context?: string | Record<string, unknown> }): Promise<AgentPayResult> {
    const amount = typeof args.amount === "bigint" ? args.amount : parseUsd(args.amount);
    const intent = buildIntent({ mandateId: this.cfg.mandateId, merchant: args.merchant, amount, invoiceRef: args.invoiceRef, context: args.context });
    const base = { amount: formatUsd(amount), merchant: args.merchant, invoiceRef: intent.invoiceRef };
    const signature = await signIntent({ signer: this.cfg.signer, chainId: this.cfg.chainId, vault: this.cfg.vault, intent });

    const rejected = (c: CheckResult): AgentPayResult => ({ ...base, status: "rejected", check: c, message: `Payment blocked: ${c.message}` });

    // free pre-flight (the relayer repeats it): a refusal never costs gas
    const pre = await check({ publicClient: this.cfg.publicClient, vault: this.cfg.vault, intent, signature });
    if (!pre.accepted) return rejected(pre);

    if (this.cfg.relayerUrl) {
      const r = await relayPay({ relayerUrl: this.cfg.relayerUrl, vault: this.cfg.vault, intent, signature, apiKey: this.cfg.relayerApiKey });
      if (r.status === "rejected") return rejected(r.check);
      return {
        ...base,
        status: r.status,
        check: r.check,
        message: r.status === "queued" ? "Payment is waiting for the owner's approval." : "Payment sent.",
        txHash: r.txHash,
        explorerUrl: r.explorerUrl,
        pendingId: r.pendingId,
      };
    }
    if (!this.cfg.clients) throw new Error("WarrantAgent needs either relayerUrl or clients (a funded wallet client) to submit");
    try {
      const o = await pay({ clients: this.cfg.clients, vault: this.cfg.vault, intent, signature });
      return {
        ...base,
        status: o.status,
        check: toCheckResult(o.status === "queued" ? Reason.ApprovalRequired : Reason.Ok),
        message: o.status === "queued" ? "Payment is waiting for the owner's approval." : "Payment sent.",
        txHash: o.hash,
        explorerUrl: txUrl(o.hash, this.cfg.explorerUrl),
        pendingId: o.pendingId?.toString(),
      };
    } catch (e) {
      if (e instanceof WarrantRejected) return rejected(toCheckResult(e.code));
      throw e;
    }
  }
}
