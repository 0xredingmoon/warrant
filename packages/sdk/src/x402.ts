/**
 * x402 over Warrant.
 *
 * x402 (https://github.com/coinbase/x402) is the HTTP 402 payment protocol: a server answers `402` with its
 * payment requirements, the client retries with a signed payment payload in a header, and a facilitator
 * (`/verify`, `/settle`, `/supported`) checks and settles it on-chain. This module speaks both wire versions:
 *
 *   v1  402 JSON body {x402Version:1, accepts:[...]}   client header X-PAYMENT           reply header X-PAYMENT-RESPONSE
 *   v2  402 header PAYMENT-REQUIRED (base64 JSON)       client header PAYMENT-SIGNATURE   reply header PAYMENT-RESPONSE
 *
 * The scheme is `warrant`, not `exact`: instead of an EIP-3009 transfer authorization (which would hand the
 * facilitator an unconditional transfer from the agent's wallet), the payload is the agent's EIP-712
 * `PaymentIntent` for its Warrant mandate. The vault enforces the mandate's caps, allowlist and approval queue
 * when the facilitator settles it. Everything else (envelope, headers, endpoints, response shapes) follows the spec.
 */
import type { Address, Hex } from "viem";
import { formatUsd } from "./chain";
import { buildIntent, signIntent, type TypedDataSigner } from "./intents";
import { Reason, isRecordableRefusal, toCheckResult, type CheckResult } from "./reasons";
import { relayPay } from "./relayer-client";
import { check } from "./vault";
import type { PaymentIntent } from "./types";
import type { PublicClient } from "viem";

export const WARRANT_SCHEME = "warrant";

export const X402_HEADERS = {
  v1: { payment: "X-PAYMENT", response: "X-PAYMENT-RESPONSE" },
  v2: { required: "PAYMENT-REQUIRED", payment: "PAYMENT-SIGNATURE", response: "PAYMENT-RESPONSE" },
} as const;

export type X402Version = 1 | 2;

/** v1 network names are plain strings; v2 uses CAIP-2 ids. Aevum testnet is `aevum-testnet` / `eip155:44005`. */
export function x402Network(chainId: number, version: X402Version): string {
  if (version === 1 && chainId === 44005) return "aevum-testnet";
  return `eip155:${chainId}`;
}

export function chainIdFromNetwork(network: string): number | undefined {
  if (network === "aevum-testnet") return 44005;
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : undefined;
}

/** What the server asks for, per x402 v1 (`maxAmountRequired`, `resource` is a URL). */
export interface RequirementsV1 {
  scheme: typeof WARRANT_SCHEME;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema?: unknown;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: WarrantExtra;
}

/** x402 v2 requirements (`amount`; the resource moves to the envelope). */
export interface RequirementsV2 {
  scheme: typeof WARRANT_SCHEME;
  network: string;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: WarrantExtra;
}

export interface WarrantExtra {
  /** the invoice this payment settles; goes into the intent as `invoiceRef` */
  invoiceRef: Hex;
  /** EIP-712 domain of the vaults: name "Warrant", version "1" */
  name: "Warrant";
  version: "1";
  /** display metadata for the asset */
  assetName: "tUSD8";
  decimals: 6;
}

export interface PaymentRequiredV1 {
  x402Version: 1;
  error: string;
  accepts: RequirementsV1[];
}

export interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: RequirementsV2[];
  extensions?: Record<string, unknown>;
}

export type Requirements = RequirementsV1 | RequirementsV2;

export interface WarrantPayload {
  vault: Address;
  /** the signed intent, numbers as decimal strings */
  intent: Record<keyof PaymentIntent, string>;
  signature: Hex;
}

export interface PaymentPayloadV1 {
  x402Version: 1;
  scheme: typeof WARRANT_SCHEME;
  network: string;
  payload: WarrantPayload;
}

export interface PaymentPayloadV2 {
  x402Version: 2;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: RequirementsV2;
  payload: WarrantPayload;
}

export type PaymentPayload = PaymentPayloadV1 | PaymentPayloadV2;

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: Address;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: Address;
  /** the settlement transaction; empty when nothing settled */
  transaction: string;
  network: string;
  /** Warrant extras (extra fields are allowed by the spec) */
  pendingId?: string;
  /** tx that queued the payment for the owner (success is false until it is approved) */
  queueTransaction?: string;
  /** tx of the on-chain `PaymentRefused` record when the mandate refused the payment */
  refusalTransaction?: string;
}

export interface SupportedResponse {
  kinds: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[];
  extensions: string[];
  signers: Record<string, string[]>;
}

/* ------------------------------------------------------------------ encoding */

export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeHeader<T = unknown>(value: string): T {
  const bin = atob(value.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** snake_case reason codes used in x402 `invalidReason` / `errorReason` (e.g. `exceeds_period_cap`). */
export const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/* ------------------------------------------------------------------ server helpers */

export interface InvoiceTerms {
  invoiceRef: Hex;
  /** atomic units (6 decimals) */
  amount: bigint;
  payTo: Address;
  token: Address;
  chainId: number;
  resource: string;
  description: string;
  ttlSeconds: number;
  mimeType?: string;
}

export function requirementsV1(t: InvoiceTerms): RequirementsV1 {
  return {
    scheme: WARRANT_SCHEME,
    network: x402Network(t.chainId, 1),
    maxAmountRequired: t.amount.toString(),
    resource: t.resource,
    description: t.description,
    mimeType: t.mimeType ?? "application/json",
    outputSchema: null,
    payTo: t.payTo,
    maxTimeoutSeconds: t.ttlSeconds,
    asset: t.token,
    extra: warrantExtra(t.invoiceRef),
  };
}

export function requirementsV2(t: InvoiceTerms): RequirementsV2 {
  return {
    scheme: WARRANT_SCHEME,
    network: x402Network(t.chainId, 2),
    amount: t.amount.toString(),
    asset: t.token,
    payTo: t.payTo,
    maxTimeoutSeconds: t.ttlSeconds,
    extra: warrantExtra(t.invoiceRef),
  };
}

const warrantExtra = (invoiceRef: Hex): WarrantExtra => ({ invoiceRef, name: "Warrant", version: "1", assetName: "tUSD8", decimals: 6 });

/** The 402 a server sends: v1 body plus the v2 header, so clients of either version can pay. */
export function paymentRequired(t: InvoiceTerms, error = "payment_required") {
  const v1: PaymentRequiredV1 = { x402Version: 1, error, accepts: [requirementsV1(t)] };
  const v2: PaymentRequiredV2 = {
    x402Version: 2,
    error,
    resource: { url: t.resource, description: t.description, mimeType: t.mimeType ?? "application/json" },
    accepts: [requirementsV2(t)],
  };
  return { body: v1, headers: { [X402_HEADERS.v2.required]: encodeHeader(v2) } };
}

/** Read the payment header of a request (either version). */
export function readPaymentHeader(get: (name: string) => string | undefined | null): PaymentPayload | undefined {
  const raw = get(X402_HEADERS.v2.payment) ?? get(X402_HEADERS.v1.payment);
  if (!raw) return undefined;
  const p = decodeHeader<any>(raw);
  if (!p || typeof p !== "object" || !p.payload) throw new Error("malformed payment payload");
  return p as PaymentPayload;
}

export const payloadNetwork = (p: PaymentPayload) => (p.x402Version === 1 ? p.network : p.accepted.network);

export function intentFromPayload(p: WarrantPayload): PaymentIntent {
  const i = p.intent;
  return {
    mandateId: BigInt(i.mandateId),
    merchant: i.merchant as Address,
    amount: BigInt(i.amount),
    invoiceRef: i.invoiceRef as Hex,
    intentHash: i.intentHash as Hex,
    nonce: i.nonce as Hex,
    deadline: BigInt(i.deadline),
  };
}

export function payloadFromIntent(vault: Address, intent: PaymentIntent, signature: Hex): WarrantPayload {
  return {
    vault,
    intent: {
      mandateId: intent.mandateId.toString(),
      merchant: intent.merchant,
      amount: intent.amount.toString(),
      invoiceRef: intent.invoiceRef,
      intentHash: intent.intentHash,
      nonce: intent.nonce,
      deadline: intent.deadline.toString(),
    },
    signature,
  };
}

/* ------------------------------------------------------------------ client */

export interface X402Agent {
  signer: TypedDataSigner & { address: Address };
  publicClient: PublicClient;
  chainId: number;
  vault: Address;
  mandateId: bigint;
  /** used to record a refused payment on-chain; the facilitator pays for settlement itself */
  relayerUrl?: string;
  relayerApiKey?: string;
  recordRefusals?: boolean;
}

export type X402Outcome =
  | { kind: "free" }
  | { kind: "paid"; settle?: SettleResponse; amount: string }
  /** the mandate refused; `txHash` is the on-chain PaymentRefused record when it could be recorded */
  | { kind: "refused"; check: CheckResult; amount: string; txHash?: Hex; explorerUrl?: string }
  /** payment accepted by the vault but queued for the owner: call `retry()` after approval */
  | { kind: "pending"; amount: string; pendingId?: string; settle?: SettleResponse; retry: () => Promise<X402Result> }
  | { kind: "failed"; reason: string; settle?: SettleResponse };

export interface X402Result {
  response: Response;
  outcome: X402Outcome;
}

export interface X402FetchOptions {
  /** called before paying: return false to decline (e.g. a price you don't want to pay) */
  approve?: (info: { amount: string; payTo: Address; description: string; resource: string }) => boolean | Promise<boolean>;
  /** why the agent is paying: hashed into the on-chain `intentHash` */
  context?: string | Record<string, unknown>;
  fetch?: typeof fetch;
}

/** Parse a 402 response into the warrant requirements it offers (v2 header first, then the v1 body). */
export async function parsePaymentRequired(res: Response): Promise<
  { version: 2; envelope: PaymentRequiredV2; req: RequirementsV2 } | { version: 1; envelope: PaymentRequiredV1; req: RequirementsV1 } | undefined
> {
  const h = res.headers.get(X402_HEADERS.v2.required);
  if (h) {
    try {
      const envelope = decodeHeader<PaymentRequiredV2>(h);
      const req = envelope.accepts?.find((a) => a.scheme === WARRANT_SCHEME);
      if (req) return { version: 2, envelope, req };
    } catch {
      /* fall through to the v1 body */
    }
  }
  const body: any = await res.clone().json().catch(() => undefined);
  if (body?.x402Version === 1 && Array.isArray(body.accepts)) {
    const req = (body as PaymentRequiredV1).accepts.find((a) => a.scheme === WARRANT_SCHEME);
    if (req) return { version: 1, envelope: body as PaymentRequiredV1, req };
  }
  if (body?.x402Version === 2 && Array.isArray(body.accepts)) {
    const req = (body as PaymentRequiredV2).accepts.find((a) => a.scheme === WARRANT_SCHEME);
    if (req) return { version: 2, envelope: body as PaymentRequiredV2, req };
  }
  return undefined;
}

/**
 * `fetch` that pays HTTP 402s with a Warrant mandate. Free responses pass through untouched. On a 402 it signs
 * a `PaymentIntent` for the requested invoice, checks it against the vault for free, and retries with the
 * payment header. A payment the mandate refuses never leaves the agent: when `relayerUrl` is set the refusal is
 * recorded on-chain (`PaymentRefused`) and returned as `outcome.kind === "refused"`.
 */
export async function x402Fetch(agent: X402Agent, url: string, init: RequestInit = {}, opts: X402FetchOptions = {}): Promise<X402Result> {
  const doFetch = opts.fetch ?? fetch;
  const first = await doFetch(url, init);
  if (first.status !== 402) return { response: first, outcome: { kind: "free" } };

  const parsed = await parsePaymentRequired(first);
  if (!parsed) return { response: first, outcome: { kind: "failed", reason: "402 without a warrant payment option" } };
  const req = parsed.req;
  const amountAtomic = BigInt(parsed.version === 1 ? (req as RequirementsV1).maxAmountRequired : (req as RequirementsV2).amount);
  const amountText = formatUsd(amountAtomic);
  const net = chainIdFromNetwork(req.network);
  if (net !== agent.chainId) return { response: first, outcome: { kind: "failed", reason: `server wants network ${req.network}, agent is on ${agent.chainId}` } };

  const resource = parsed.version === 1 ? (req as RequirementsV1).resource : (parsed.envelope as PaymentRequiredV2).resource.url;
  const description = parsed.version === 1 ? (req as RequirementsV1).description : (parsed.envelope as PaymentRequiredV2).resource.description;
  if (opts.approve && !(await opts.approve({ amount: amountText, payTo: req.payTo, description, resource }))) {
    return { response: first, outcome: { kind: "failed", reason: "declined by the agent's own price check" } };
  }

  const intent = buildIntent({
    mandateId: agent.mandateId,
    merchant: req.payTo,
    amount: amountAtomic,
    invoiceRef: req.extra.invoiceRef,
    context: opts.context ?? { x402: resource, description },
  });
  const signature = await signIntent({ signer: agent.signer, chainId: agent.chainId, vault: agent.vault, intent });

  const pre = await check({ publicClient: agent.publicClient, vault: agent.vault, intent, signature });
  if (!pre.accepted) {
    let txHash: Hex | undefined;
    let explorerUrl: string | undefined;
    if (agent.relayerUrl && agent.recordRefusals !== false && isRecordableRefusal(pre.code)) {
      const r = await relayPay({ relayerUrl: agent.relayerUrl, vault: agent.vault, intent, signature, apiKey: agent.relayerApiKey }).catch(() => undefined);
      if (r?.status === "refused") {
        txHash = r.txHash;
        explorerUrl = r.explorerUrl;
      }
    }
    return { response: first, outcome: { kind: "refused", check: pre, amount: amountText, txHash, explorerUrl } };
  }

  const payload = payloadFromIntent(agent.vault, intent, signature);
  const header =
    parsed.version === 1
      ? { name: X402_HEADERS.v1.payment, value: encodeHeader({ x402Version: 1, scheme: WARRANT_SCHEME, network: req.network, payload } satisfies PaymentPayloadV1) }
      : {
          name: X402_HEADERS.v2.payment,
          value: encodeHeader({
            x402Version: 2,
            resource: (parsed.envelope as PaymentRequiredV2).resource,
            accepted: req as RequirementsV2,
            payload,
          } satisfies PaymentPayloadV2),
        };

  const send = async (): Promise<X402Result> => {
    const headers = new Headers(init.headers);
    headers.set(header.name, header.value);
    const res = await doFetch(url, { ...init, headers });
    const settleRaw = res.headers.get(X402_HEADERS.v2.response) ?? res.headers.get(X402_HEADERS.v1.response);
    let settle: SettleResponse | undefined;
    try {
      settle = settleRaw ? decodeHeader<SettleResponse>(settleRaw) : undefined;
    } catch {
      settle = undefined;
    }
    if (res.ok) return { response: res, outcome: { kind: "paid", settle, amount: amountText } };
    if (res.status === 402) {
      const body: any = await res.clone().json().catch(() => ({}));
      if (settle?.errorReason === "approval_required" || body?.error === "approval_required") {
        return { response: res, outcome: { kind: "pending", amount: amountText, pendingId: settle?.pendingId ?? body?.pendingId, settle, retry: send } };
      }
      if (settle?.refusalTransaction) {
        return {
          response: res,
          outcome: {
            kind: "refused",
            check: toCheckResult(refusalCodeFromReason(settle.errorReason)),
            amount: amountText,
            txHash: settle.refusalTransaction as Hex,
          },
        };
      }
      return { response: res, outcome: { kind: "failed", reason: settle?.errorMessage ?? body?.message ?? body?.error ?? "payment not accepted", settle } };
    }
    return { response: res, outcome: { kind: "failed", reason: `server answered ${res.status}`, settle } };
  };
  return send();
}

function refusalCodeFromReason(reason?: string): number {
  if (!reason) return Reason.MerchantNotAllowed;
  const hit = Object.entries(Reason).find(([k]) => snake(k) === reason);
  return hit ? hit[1] : Reason.MerchantNotAllowed;
}

