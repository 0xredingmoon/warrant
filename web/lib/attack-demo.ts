"use client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RELAYER_URL } from "./config";

export type AttackKind = "overspend" | "offlist";

export interface AttackPlan {
  kind: AttackKind;
  /** what the agent will try, in plain language */
  attempted: string;
  amount: string;
  merchant: string;
  /** the reason code the vault is expected to answer with */
  expectedReason: string;
}

export interface AttackView {
  enabled: true;
  vault: string;
  vaultUrl: string;
  mandateId: string;
  agent: string;
  allowedMerchant: string;
  blockedMerchant: string;
  terms: {
    perTxCap: string;
    periodCap: string;
    totalCap: string;
    merchantPerTxCap: string;
    revoked: boolean;
    frozen: boolean;
    expired: boolean;
  };
  attacks: AttackPlan[];
}

export interface AttackOutcome {
  kind: AttackKind;
  attempted: string;
  amount: string;
  merchant: string;
  status: "executed" | "queued" | "refused" | "rejected";
  /** the contract's verdict: a stable reason code plus an English message */
  check: { accepted: boolean; code: number; reason: string; message: string };
  txHash?: string;
  explorerUrl?: string;
  /** set when the outcome is not the one the demo expects */
  note?: string;
}

class DemoUnavailable extends Error {}

async function getView(): Promise<AttackView | null> {
  if (!RELAYER_URL) return null;
  const res = await fetch(`${RELAYER_URL}/v1/demo/attack`, { signal: AbortSignal.timeout(8_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new DemoUnavailable("The relayer did not answer.");
  const json = (await res.json()) as AttackView;
  return json?.enabled ? json : null;
}

/** The demo vault and what the two attacks will try. Reads the chain through the relayer, so it also proves the
 * relayer is the one signing. */
export function useAttackDemo() {
  return useQuery({
    queryKey: ["attack-demo"],
    queryFn: getView,
    staleTime: 30_000,
    retry: false,
  });
}

/** Run one attack. Always goes through the relayer, which holds the demonstration's agent key. */
export function useRunAttack() {
  return useMutation({
    mutationFn: async (kind: AttackKind): Promise<AttackOutcome> => {
      if (!RELAYER_URL) throw new Error("No relayer is configured.");
      const res = await fetch(`${RELAYER_URL}/v1/demo/attack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
        signal: AbortSignal.timeout(120_000), // the relayer waits for the refusal to be mined
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `The relayer answered ${res.status}.`);
      return json as AttackOutcome;
    },
  });
}

/** Short address for display; the full address stays in the title and the explorer link. */
export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);
