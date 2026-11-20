import type { Address, Hex } from "viem";
import { toCheckResult, type CheckResult } from "./reasons";
import type { PaymentIntent } from "./types";

export interface RelayPayResponse {
  /**
   * "executed": paid. "queued": waiting for the owner. "refused": the mandate said no and the refusal was recorded
   * on-chain (`txHash`). "rejected": refused and not recorded (bad signature, expired, rate limit...).
   */
  status: "executed" | "queued" | "refused" | "rejected";
  check: CheckResult;
  txHash?: Hex;
  explorerUrl?: string;
  pendingId?: string;
}

const ser = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

async function post<T>(url: string, body: unknown, apiKey?: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(ser(body)),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok && !json?.status) throw new Error(json?.error ?? `relayer error ${res.status}`);
  return json as T;
}

/**
 * Submit a signed intent through a relayer, which pays the gas. The agent needs no tQDAY.
 * A refused payment is returned as `status: "rejected"` with a human-readable `check.message`; it does not throw.
 */
export async function relayPay(args: {
  relayerUrl: string;
  vault: Address;
  intent: PaymentIntent;
  signature: Hex;
  apiKey?: string;
}): Promise<RelayPayResponse> {
  const r = await post<any>(`${args.relayerUrl.replace(/\/$/, "")}/v1/pay`, { vault: args.vault, intent: args.intent, signature: args.signature }, args.apiKey);
  return { ...r, check: toCheckResult(r.check.code) };
}

/** Relay an owner's `approveBySig` for a queued payment (the owner needs no gas). */
export function relayApprove(args: { relayerUrl: string; vault: Address; pendingId: bigint; deadline: bigint; signature: Hex; apiKey?: string }) {
  return post<{ status: "executed" | "failed"; txHash?: Hex; explorerUrl?: string; error?: string }>(
    `${args.relayerUrl.replace(/\/$/, "")}/v1/approve`,
    { vault: args.vault, pendingId: args.pendingId, deadline: args.deadline, signature: args.signature },
    args.apiKey,
  );
}

/** Relay an EIP-3009 gasless deposit into a vault. */
export function relayDeposit(args: {
  relayerUrl: string;
  vault: Address;
  from: Address;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
  apiKey?: string;
}) {
  const { relayerUrl, apiKey, ...body } = args;
  return post<{ status: "executed" | "failed"; txHash?: Hex; explorerUrl?: string; error?: string }>(
    `${relayerUrl.replace(/\/$/, "")}/v1/deposit`,
    body,
    apiKey,
  );
}

export async function relayerHealth(relayerUrl: string) {
  const res = await fetch(`${relayerUrl.replace(/\/$/, "")}/health`);
  return (await res.json()) as { ok: boolean; chainId: number; relayer: Address; factory: Address; balance: string };
}
