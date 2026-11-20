import type { NextFunction, Request, Response } from "express";
import { parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { openDb } from "@warrant/store";
import {
  X402_HEADERS,
  decodeHeader,
  encodeHeader,
  formatUsd,
  intentFromPayload,
  paymentRequired,
  parseUsd,
  payloadNetwork,
  randomBytes32,
  readPaymentHeader,
  requirementsV1,
  requirementsV2,
  txUrl,
  warrantFactoryAbi,
  warrantVaultAbi,
  type InvoiceTerms,
  type PaymentPayload,
  type SettleResponse,
  type VerifyResponse,
} from "@warrant/sdk";
import { SqliteInvoiceStore, type Invoice, type InvoiceStore, type StoredInvoice } from "./invoices";

export { SqliteInvoiceStore, type Invoice, type InvoiceStore, type StoredInvoice } from "./invoices";

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
  /** SQLite file for invoices (survive restarts). Default ":memory:". Ignored if `store` is given. */
  dbPath?: string;
  /** bring your own invoice store */
  store?: InvoiceStore;
}

export interface PaywallOptions {
  /**
   * Accept x402 payments (`X-PAYMENT` / `PAYMENT-SIGNATURE`) and settle them through this facilitator
   * (`POST /verify`, `POST /settle`), for example a Warrant relayer's base URL. Without it only the native
   * flow (pay yourself, then send `X-Warrant-Invoice` + `X-Warrant-Tx`) is accepted.
   */
  facilitatorUrl?: string;
  facilitatorApiKey?: string;
  /** replace fetch (tests) */
  fetch?: typeof fetch;
}

/**
 * Issue invoices and verify payment from chain data alone. The merchant never trusts the agent's word, or the
 * facilitator's: it re-reads the transaction receipt, checks the log came from a vault the Warrant factory deployed,
 * and compares merchant, invoice reference and amount against the invoice it issued.
 */
export function createMerchant(cfg: MerchantConfig) {
  const store: InvoiceStore = cfg.store ?? new SqliteInvoiceStore(openDb(cfg.dbPath ?? ":memory:"));
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
    store.put({ invoice: inv, amount: parseUsd(a.amount), expires });
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
      (l) => l.args.invoiceRef.toLowerCase() === ref.toLowerCase() && l.args.merchant.toLowerCase() === cfg.payTo.toLowerCase(),
    );
    for (const l of executed) {
      if (!(await isWarrantVault(l.address))) continue;
      if (l.args.amount < s.amount) return { state: "invalid", reason: `Paid ${formatUsd(l.args.amount)}, invoice is ${s.invoice.amount}.` };
      store.markPaid(ref, txHash);
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
      (l) => l.args.invoiceRef.toLowerCase() === ref.toLowerCase() && l.args.merchant.toLowerCase() === cfg.payTo.toLowerCase(),
    );
    if (queued && (await isWarrantVault(queued.address))) {
      return { state: "queued", vault: queued.address, pendingId: queued.args.pendingId, txHash };
    }
    return { state: "invalid", reason: "That transaction does not pay this invoice." };
  }

  const termsOf = (s: StoredInvoice): InvoiceTerms => ({
    invoiceRef: s.invoice.ref,
    amount: s.amount,
    payTo: cfg.payTo,
    token: cfg.token,
    chainId: cfg.chainId,
    resource: s.invoice.resource,
    description: s.invoice.description,
    ttlSeconds: ttl,
  });

  /**
   * Express middleware. Unpaid requests get `402 Payment Required` carrying the invoice in three forms: the native
   * JSON (`invoice`), the x402 v1 body (`accepts`) and the x402 v2 `PAYMENT-REQUIRED` header. A retry is served when
   * it carries either
   *   - `X-Warrant-Invoice` + `X-Warrant-Tx`: the agent paid on-chain itself and proves it, or
   *   - an x402 payment header (`X-PAYMENT` / `PAYMENT-SIGNATURE`): the merchant has the facilitator settle it.
   * Either way the payment is re-verified on-chain before `res.locals.payment` is set and the handler runs.
   */
  function paywall(price: (req: Request) => { amount: string; description: string }, opts: PaywallOptions = {}) {
    const doFetch = opts.fetch ?? fetch;

    const challenge = (req: Request, res: Response) => {
      const p = price(req);
      const inv = invoice({ amount: p.amount, description: p.description, resource: absoluteUrl(req) });
      const terms = termsOf(store.get(inv.ref)!);
      const x402 = opts.facilitatorUrl ? paymentRequired(terms) : undefined;
      res.status(402).set("X-Warrant-Invoice", inv.ref);
      if (x402) res.set(x402.headers);
      res.json({
        ...(x402?.body ?? {}),
        error: "payment_required",
        message: `${cfg.name ?? "This API"} charges ${inv.amount} tUSD8 for this request.`,
        invoice: inv,
        retry: opts.facilitatorUrl
          ? "Pay with x402 (scheme \"warrant\"), or pay the invoice yourself and repeat the request with headers X-Warrant-Invoice and X-Warrant-Tx."
          : "Pay the invoice, then repeat the request with headers X-Warrant-Invoice: <invoice.ref> and X-Warrant-Tx: <transaction hash>.",
      });
    };

    const serve = (res: Response, next: NextFunction, ref: string, v: Verification & { state: "executed" }) => {
      if (!store.consume(ref)) {
        res.status(402).json({ error: "invoice_already_used", message: "This invoice already bought a response. Request a new one.", invoice: store.get(ref)?.invoice });
        return;
      }
      res.locals.payment = v;
      next();
    };

    async function facilitator(path: "verify" | "settle", body: unknown) {
      const res = await doFetch(`${opts.facilitatorUrl!.replace(/\/$/, "")}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.facilitatorApiKey ? { authorization: `Bearer ${opts.facilitatorApiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`facilitator ${path} answered ${res.status}`);
      return (await res.json()) as any;
    }

    async function handleX402(req: Request, res: Response, next: NextFunction, payment: PaymentPayload) {
      const version = payment.x402Version === 1 ? 1 : 2;
      const respHeader = version === 1 ? X402_HEADERS.v1.response : X402_HEADERS.v2.response;
      const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}, settle?: SettleResponse) => {
        if (settle) res.set(respHeader, encodeHeader(settle));
        res.status(status).json({ x402Version: version, error, message, ...extra });
      };

      const ref = payment.payload.intent.invoiceRef as Hex;
      const s = store.get(ref);
      if (!s) return fail(402, "unknown_invoice", "Unknown invoice reference.");
      if (s.consumedAt) return fail(402, "invoice_already_used", "This invoice already bought a response. Request a new one.");
      if (s.expires < Math.floor(Date.now() / 1000) && !s.paidTx) return fail(402, "invoice_expired", "Invoice expired. Request a new one.");
      // the intent is checked against what WE issued, never against what the client says it owes
      const intent = intentFromPayload(payment.payload);
      if (intent.merchant.toLowerCase() !== cfg.payTo.toLowerCase() || intent.amount !== s.amount) {
        return fail(402, "payment_mismatch", "The payment does not match the invoice.");
      }
      const terms = termsOf(s);
      const requirements = version === 1 ? requirementsV1(terms) : requirementsV2(terms);
      const net = payloadNetwork(payment);
      if (net !== requirements.network) return fail(402, "invalid_network", `This server takes ${requirements.network}.`);
      const body = { x402Version: version, paymentPayload: payment, paymentRequirements: requirements };

      let v: VerifyResponse;
      let settle: SettleResponse;
      try {
        v = await facilitator("verify", body);
        if (!v.isValid) return fail(402, v.invalidReason ?? "invalid_payment", v.invalidMessage ?? "The facilitator could not verify the payment.", { reason: v.invalidReason });
        settle = await facilitator("settle", body);
      } catch (e) {
        return fail(502, "facilitator_unavailable", `Could not reach the payment facilitator: ${(e as Error).message}`);
      }
      if (!settle.success) {
        const pending = settle.errorReason === "approval_required";
        return fail(
          402,
          pending ? "approval_required" : (settle.errorReason ?? "settlement_failed"),
          settle.errorMessage ?? "Payment was not settled.",
          {
            ...(settle.pendingId ? { pendingId: settle.pendingId } : {}),
            ...(settle.refusalTransaction ? { refusalTransaction: settle.refusalTransaction } : {}),
            ...(pending ? { retry: "Repeat this request with the same payment header once the owner has approved." } : {}),
          },
          settle,
        );
      }
      // do not take the facilitator's word for it
      const onchain = await verify(ref, settle.transaction as Hex);
      if (onchain.state !== "executed") return fail(502, "settlement_not_verified", onchain.state === "invalid" ? onchain.reason : "The settlement could not be verified on-chain.");
      res.set(respHeader, encodeHeader(settle));
      serve(res, next, ref, onchain);
    }

    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // x402
        let x402Payment: PaymentPayload | undefined;
        if (opts.facilitatorUrl) {
          try {
            x402Payment = readPaymentHeader((n) => req.header(n));
          } catch {
            res.status(400).json({ error: "malformed_payment_header", message: "The payment header is not valid base64 JSON." });
            return;
          }
          if (x402Payment) return await handleX402(req, res, next, x402Payment);
        }

        // native flow
        const ref = req.header("x-warrant-invoice") as Hex | undefined;
        const tx = req.header("x-warrant-tx") as Hex | undefined;
        if (ref && tx) {
          const v = await verify(ref, tx);
          if (v.state === "executed") return serve(res, next, ref, v);
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
        challenge(req, res);
      } catch (e) {
        next(e);
      }
    };
  }

  return { invoice, verify, paywall, store, config: cfg };
}

export type Merchant = ReturnType<typeof createMerchant>;

function absoluteUrl(req: Request) {
  const host = req.get("host");
  return host ? `${req.protocol}://${host}${req.originalUrl}` : req.originalUrl;
}
