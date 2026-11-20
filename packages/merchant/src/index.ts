import type { NextFunction, Request, Response } from "express";
import { parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { formatUsd, parseUsd, randomBytes32, txUrl, warrantFactoryAbi, warrantVaultAbi } from "@warrant/sdk";

/** What a 402 response carries. An agent pays `amount` tUSD8 to `payTo` quoting `ref` as the invoice reference. */
export interface Invoice {
  ref: Hex;
  /** decimal tUSD8, e.g. "0.15" */
  amount: string;
  asset: "tUSD8";
  token: Address;
  network: string;
  chainId: number;
  payTo: Address;
  description: string;
  resource: string;
  expiresAt: string;
}

export type Verification =
  | { state: "executed"; vault: Address; agent: Address; mandateId: bigint; gross: bigint; fee: bigint; net: bigint; txHash: Hex; explorerUrl: string }
  | { state: "queued"; vault: Address; pendingId: bigint; txHash: Hex }
  | { state: "invalid"; reason: string };

export interface MerchantConfig {
  publicClient: PublicClient;
  chainId: number;
  factory: Address;
  token: Address;
  /** the address that gets paid (and may rate agents in the registry) */
  payTo: Address;
  explorerUrl?: string;
  /** invoice lifetime in seconds (default 900) */
  invoiceTtl?: number;
  name?: string;
}

interface Stored {
  invoice: Invoice;
  amount: bigint;
  expires: number;
  paidTx?: Hex;
}

/**
 * Issue invoices and verify payment from chain data alone. The merchant never trusts the agent's word:
 * it re-reads the transaction receipt, checks the log came from a vault the Warrant factory deployed,
 * and compares merchant, invoice reference and amount against the invoice it issued.
 * Invoices live in memory; use a database for more than one process.
 */
export function createMerchant(cfg: MerchantConfig) {
  const store = new Map<string, Stored>();
  const ttl = cfg.invoiceTtl ?? 900;
  const isVaultCache = new Set<string>();

  function invoice(a: { amount: string; description: string; resource: string }): Invoice {
    const ref = randomBytes32();
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const inv: Invoice = {
      ref,
      amount: a.amount,
      asset: "tUSD8",
      token: cfg.token,
      network: `eip155:${cfg.chainId}`,
      chainId: cfg.chainId,
      payTo: cfg.payTo,
      description: a.description,
      resource: a.resource,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
    store.set(ref, { invoice: inv, amount: parseUsd(a.amount), expires });
    return inv;
  }

  async function isWarrantVault(vault: Address) {
    if (isVaultCache.has(vault)) return true;
    const ok = await cfg.publicClient.readContract({ address: cfg.factory, abi: warrantFactoryAbi, functionName: "isVault", args: [vault] });
    if (ok) isVaultCache.add(vault);
    return ok;
  }

  async function verify(ref: Hex, txHash: Hex): Promise<Verification> {
    const s = store.get(ref);
    if (!s) return { state: "invalid", reason: "Unknown invoice reference." };
    if (s.expires < Math.floor(Date.now() / 1000) && !s.paidTx) return { state: "invalid", reason: "Invoice expired. Request a new one." };
    let receipt;
    try {
      receipt = await cfg.publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
      return { state: "invalid", reason: "Transaction not found (yet)." };
    }
    if (receipt.status !== "success") return { state: "invalid", reason: "Transaction reverted." };
    const executed = parseEventLogs({ abi: warrantVaultAbi, logs: receipt.logs, eventName: "PaymentExecuted" }).filter(
      (l) => l.args.invoiceRef === ref && l.args.merchant.toLowerCase() === cfg.payTo.toLowerCase(),
    );
    for (const l of executed) {
      if (!(await isWarrantVault(l.address))) continue;
      if (l.args.amount < s.amount) return { state: "invalid", reason: `Paid ${formatUsd(l.args.amount)}, invoice is ${s.invoice.amount}.` };
      s.paidTx = txHash;
      return {
        state: "executed",
        vault: l.address,
        agent: l.args.agent,
        mandateId: l.args.mandateId,
        gross: l.args.amount,
        fee: l.args.fee,
        net: l.args.amount - l.args.fee,
        txHash,
        explorerUrl: txUrl(txHash, cfg.explorerUrl),
      };
    }
    const queued = parseEventLogs({ abi: warrantVaultAbi, logs: receipt.logs, eventName: "PaymentQueued" }).find(
      (l) => l.args.invoiceRef === ref && l.args.merchant.toLowerCase() === cfg.payTo.toLowerCase(),
    );
    if (queued && (await isWarrantVault(queued.address))) {
      return { state: "queued", vault: queued.address, pendingId: queued.args.pendingId, txHash };
    }
    return { state: "invalid", reason: "That transaction does not pay this invoice." };
  }

  /**
   * Express middleware. Unpaid requests get `402 Payment Required` with the invoice; a retry carrying
   * `X-Warrant-Invoice` and `X-Warrant-Tx` is verified on-chain and, if paid, passed to the handler
   * with `res.locals.payment` set.
   */
  function paywall(price: (req: Request) => { amount: string; description: string }) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ref = req.header("x-warrant-invoice") as Hex | undefined;
        const tx = req.header("x-warrant-tx") as Hex | undefined;
        if (ref && tx) {
          const v = await verify(ref, tx);
          if (v.state === "executed") {
            res.locals.payment = v;
            return next();
          }
          if (v.state === "queued") {
            res.status(402).json({
              error: "awaiting_owner_approval",
              message: "Payment is queued for the account owner's approval. Retry with the approval transaction once it is approved.",
              invoice: store.get(ref)?.invoice,
              pendingId: v.pendingId.toString(),
            });
            return;
          }
          res.status(402).json({ error: "payment_not_verified", message: v.reason, invoice: store.get(ref)?.invoice });
          return;
        }
        const p = price(req);
        const inv = invoice({ amount: p.amount, description: p.description, resource: req.originalUrl });
        res.status(402).set("X-Warrant-Invoice", inv.ref).json({
          error: "payment_required",
          message: `${cfg.name ?? "This API"} charges ${inv.amount} tUSD8 for this request.`,
          invoice: inv,
          retry: "Pay the invoice, then repeat the request with headers X-Warrant-Invoice: <invoice.ref> and X-Warrant-Tx: <transaction hash>.",
        });
      } catch (e) {
        next(e);
      }
    };
  }

  return { invoice, verify, paywall, config: cfg };
}

export type Merchant = ReturnType<typeof createMerchant>;
