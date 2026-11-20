import type { Express, NextFunction, Request, Response } from "express";
import { getAddress, isAddress, isHex, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import {
  WARRANT_SCHEME,
  chainIdFromNetwork,
  getAuditLog,
  getMandate,
  getPending,
  intentFromPayload,
  reasonMessage,
  reasonName,
  snake,
  warrantVaultAbi,
  x402Network,
  type PaymentIntent,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@warrant/sdk";
import type { RelayerConfig } from "./config";
import type { SettlementStore } from "./settlements";
import type { SubmitResult } from "./app";

const addr = z.string().refine(isAddress, "invalid address");
const hex32 = z.string().refine((s) => isHex(s) && s.length === 66, "must be 32 bytes");
const uintStr = z.string().regex(/^\d+$/, "must be a decimal integer");

const warrantPayload = z.object({
  vault: addr,
  intent: z.object({ mandateId: uintStr, merchant: addr, amount: uintStr, invoiceRef: hex32, intentHash: hex32, nonce: hex32, deadline: uintStr }),
  signature: z.string().refine(isHex, "invalid hex"),
});

const extra = z.object({ invoiceRef: hex32 }).passthrough();

const requirementsSchema = z
  .object({
    scheme: z.string(),
    network: z.string(),
    payTo: addr,
    asset: addr,
    extra,
    maxAmountRequired: uintStr.optional(), // v1
    amount: uintStr.optional(), // v2
  })
  .passthrough();

const bodySchema = z.object({
  x402Version: z.number().int().optional(),
  paymentPayload: z
    .object({
      x402Version: z.number().int(),
      scheme: z.string().optional(), // v1
      network: z.string().optional(), // v1
      accepted: requirementsSchema.optional(), // v2
      payload: warrantPayload,
    })
    .passthrough(),
  paymentRequirements: requirementsSchema,
});

export interface FacilitatorCtx {
  cfg: RelayerConfig;
  publicClient: PublicClient;
  relayerAddress: Address;
  assertWarrantVault: (vault: Address) => Promise<void>;
  submitIntent: (vault: Address, intent: PaymentIntent, signature: Hex) => Promise<SubmitResult>;
  settlements: SettlementStore;
  wrap: (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void;
}

type Parsed = z.infer<typeof bodySchema>;

interface Checked {
  vault: Address;
  intent: PaymentIntent;
  signature: Hex;
  network: string;
  payer?: Address;
}

/**
 * x402 facilitator endpoints (`GET /supported`, `POST /verify`, `POST /settle`) for the `warrant` scheme.
 * `verify` never sends a transaction; `settle` submits the agent's intent through `payOrRefuse` and answers the
 * x402 way: `success` plus the settlement transaction, or `success:false` with an `errorReason`. Settling the same
 * payment twice is idempotent (the first outcome is stored in SQLite), which is how a payment that waited for the
 * owner's approval is collected afterwards.
 */
export function mountFacilitator(app: Express, ctx: FacilitatorCtx) {
  const { cfg, publicClient } = ctx;
  const tokenOf = new Map<string, Address>();
  const inflight = new Map<string, Promise<SettleResponse>>();

  app.get("/supported", (_req, res) => {
    const body: SupportedResponse = {
      kinds: [
        { x402Version: 1, scheme: WARRANT_SCHEME, network: x402Network(cfg.chainId, 1) },
        { x402Version: 2, scheme: WARRANT_SCHEME, network: x402Network(cfg.chainId, 2) },
      ],
      extensions: [],
      signers: { [`eip155:${cfg.chainId}`]: [ctx.relayerAddress] },
    };
    res.json(body);
  });

  /** Structural checks shared by verify and settle. Returns an invalid reason or the parsed payment. */
  async function inspect(raw: unknown): Promise<{ ok: false; reason: string; message: string } | { ok: true; c: Checked; amount: bigint }> {
    const parsedBody = bodySchema.safeParse(raw);
    if (!parsedBody.success) return { ok: false, reason: "invalid_payload", message: parsedBody.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") };
    const b: Parsed = parsedBody.data;
    const req = b.paymentRequirements;
    const pp = b.paymentPayload;
    const bad = (reason: string, message: string) => ({ ok: false as const, reason, message });

    const version = pp.x402Version;
    if (version !== 1 && version !== 2) return bad("invalid_x402_version", `x402Version ${version} is not supported (1 or 2).`);
    if (req.scheme !== WARRANT_SCHEME || (version === 1 && pp.scheme !== WARRANT_SCHEME)) return bad("invalid_scheme", `Only the "${WARRANT_SCHEME}" scheme is supported here.`);
    const network = version === 1 ? pp.network : pp.accepted?.network;
    if (network !== req.network || chainIdFromNetwork(req.network) !== cfg.chainId || req.network !== x402Network(cfg.chainId, version as 1 | 2)) {
      return bad("invalid_network", `This facilitator settles ${x402Network(cfg.chainId, version as 1 | 2)} only.`);
    }
    const amountText = version === 1 ? req.maxAmountRequired : req.amount;
    if (!amountText) return bad("invalid_requirements", version === 1 ? "maxAmountRequired is missing." : "amount is missing.");

    const vault = getAddress(pp.payload.vault);
    const intent = intentFromPayload(pp.payload as any);
    if (getAddress(intent.merchant) !== getAddress(req.payTo)) return bad("recipient_mismatch", "The payment is not addressed to payTo.");
    if (intent.amount !== BigInt(amountText)) return bad("amount_mismatch", `The payment is for ${intent.amount} but ${amountText} is required.`);
    if (intent.invoiceRef.toLowerCase() !== String(req.extra.invoiceRef).toLowerCase()) return bad("invoice_mismatch", "The payment settles a different invoice.");

    try {
      await ctx.assertWarrantVault(vault);
    } catch {
      return bad("unknown_vault", "That address is not a vault deployed by the Warrant factory.");
    }
    let token = tokenOf.get(vault);
    if (!token) {
      token = (await publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "token" })) as Address;
      tokenOf.set(vault, token);
    }
    if (getAddress(req.asset) !== getAddress(token)) return bad("asset_mismatch", "The vault does not hold the requested asset.");
    return { ok: true, c: { vault, intent, signature: pp.payload.signature as Hex, network: req.network }, amount: intent.amount };
  }

  const payerOf = async (c: Checked) => (await getMandate(publicClient, c.vault, c.intent.mandateId)).params.agent;

  app.post("/verify", ctx.wrap(async (req, res) => {
    const r = await inspect(req.body);
    if (!r.ok) return void res.json({ isValid: false, invalidReason: r.reason, invalidMessage: r.message } satisfies VerifyResponse);
    const { c } = r;
    const key = keyOf(c);
    const known = ctx.settlements.get(key);
    const payer = (await payerOf(c).catch(() => undefined)) as Address | undefined;
    if (known) {
      // already submitted: valid if it settled, otherwise say what it is waiting for
      const ok = known.status === "settled" || known.status === "queued";
      return void res.json({ isValid: ok, invalidReason: ok ? undefined : snake(known.reason ?? "refused"), payer } satisfies VerifyResponse);
    }
    const code = Number(await publicClient.readContract({ address: c.vault, abi: warrantVaultAbi, functionName: "check", args: [c.intent, c.signature] }));
    const accepted = code === 0 || code === 1; // Ok, ApprovalRequired (settle will queue it)
    res.json({
      isValid: accepted,
      invalidReason: accepted ? undefined : snake(reasonNameOf(code)),
      invalidMessage: accepted ? undefined : reasonMessage(code),
      payer,
    } satisfies VerifyResponse);
  }));

  app.post("/settle", ctx.wrap(async (req, res) => {
    const r = await inspect(req.body);
    if (!r.ok) {
      const network = (req.body?.paymentRequirements?.network as string | undefined) ?? "";
      return void res.json({ success: false, errorReason: r.reason, errorMessage: r.message, transaction: "", network } satisfies SettleResponse);
    }
    const key = keyOf(r.c);
    let p = inflight.get(key);
    if (!p) {
      p = settle(r.c, r.amount).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    res.json(await p);
  }));

  const keyOf = (c: Checked) => `${c.vault}:${c.intent.mandateId}:${c.intent.nonce}`.toLowerCase();

  async function settle(c: Checked, amount: bigint): Promise<SettleResponse> {
    const key = keyOf(c);
    const payer = (await payerOf(c).catch(() => undefined)) as Address | undefined;
    const base = { payer, network: c.network, transaction: "" };
    const known = ctx.settlements.get(key);
    if (known) return resume(c, known, payer);

    const r = await ctx.submitIntent(c.vault, c.intent, c.signature);
    const row = {
      key,
      vault: c.vault,
      merchant: c.intent.merchant,
      invoiceRef: c.intent.invoiceRef,
      amount: amount.toString(),
      payer: payer ?? "",
      txHash: r.txHash ?? null,
      pendingId: r.pendingId ?? null,
      queueBlock: r.blockNumber?.toString() ?? null,
      reason: null as string | null,
    };
    switch (r.status) {
      case "executed":
        ctx.settlements.put({ ...row, status: "settled" });
        return { success: true, ...base, transaction: r.txHash! };
      case "queued":
        ctx.settlements.put({ ...row, status: "queued" });
        return {
          success: false,
          errorReason: "approval_required",
          errorMessage: reasonMessage(1),
          ...base,
          pendingId: r.pendingId,
          queueTransaction: r.txHash,
        };
      case "refused": {
        const reason = snake(r.check.reason);
        ctx.settlements.put({ ...row, status: "refused", reason });
        return { success: false, errorReason: reason, errorMessage: r.check.message, ...base, refusalTransaction: r.txHash };
      }
      default:
        // not authentic, or the refusal budget is used up: nothing was sent, nothing is stored (the agent may sign again)
        return { success: false, errorReason: snake(r.check.reason), errorMessage: r.note ?? r.check.message, ...base };
    }
  }

  /** The payment was submitted before: report its current state (this is how a queued payment is collected). */
  async function resume(c: Checked, known: NonNullable<ReturnType<SettlementStore["get"]>>, payer?: Address): Promise<SettleResponse> {
    const base = { payer, network: c.network, transaction: "" };
    if (known.status === "settled") return { success: true, ...base, transaction: known.txHash ?? "" };
    if (known.status === "refused") {
      return { success: false, errorReason: known.reason ?? "refused", errorMessage: "The mandate refused this payment.", ...base, refusalTransaction: known.txHash ?? undefined };
    }
    if (known.status === "failed") return { success: false, errorReason: known.reason ?? "failed", ...base };

    // queued: look at the owner's decision on-chain
    const pending = await getPending(publicClient, c.vault, BigInt(known.pendingId!));
    if (pending.status === "Open") {
      return { success: false, errorReason: "approval_required", errorMessage: reasonMessage(1), ...base, pendingId: known.pendingId!, queueTransaction: known.txHash ?? undefined };
    }
    if (pending.status === "Approved") {
      const from = BigInt(known.queueBlock ?? "0");
      const entries = await getAuditLog({ publicClient, vault: c.vault, fromBlock: from, indexerUrl: cfg.indexerUrl });
      const paid = entries.find((e) => e.kind === "PaymentExecuted" && String((e.args as any).invoiceRef).toLowerCase() === known.invoiceRef.toLowerCase());
      if (paid) {
        ctx.settlements.put({ ...known, status: "settled", txHash: paid.txHash, reason: null });
        return { success: true, ...base, transaction: paid.txHash };
      }
      return { success: false, errorReason: "settlement_not_found", errorMessage: "Approved, but the payment transaction could not be located yet. Retry shortly.", ...base };
    }
    const reason = pending.status === "Expired" ? "approval_expired" : "approval_rejected";
    ctx.settlements.put({ ...known, status: "failed", reason });
    return { success: false, errorReason: reason, errorMessage: "The owner did not approve this payment.", ...base, pendingId: known.pendingId! };
  }
}

/** `reasonName` throws on codes this SDK doesn't know; a verify must never throw for those. */
function reasonNameOf(code: number) {
  try {
    return reasonName(code);
  } catch {
    return "unknown";
  }
}
