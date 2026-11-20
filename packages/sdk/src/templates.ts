import type { Address } from "viem";
import { parseUsd } from "./chain";
import type { MandateParams } from "./types";

export interface MandateTemplate {
  id: string;
  name: string;
  description: string;
  /** tUSD8 amounts as decimal strings */
  perTx: string;
  period: string;
  total: string;
  periodHours: number;
  durationDays: number;
  /** payments at or above this wait for the owner. "0" = never */
  approvalAbove: string;
  approvalWindowHours: number;
}

export const MANDATE_TEMPLATES: MandateTemplate[] = [
  {
    id: "research-assistant",
    name: "Research assistant",
    description: "Buys data and API calls. Payments under 3.00 go through; larger ones wait for your approval.",
    perTx: "5",
    period: "20",
    total: "100",
    periodHours: 24,
    durationDays: 7,
    approvalAbove: "3",
    approvalWindowHours: 24,
  },
  {
    id: "micro-payments",
    name: "Pay-per-request (x402 style)",
    description: "Tiny per-call payments to API providers. At most 0.10 per call and 5.00 a day.",
    perTx: "0.10",
    period: "5",
    total: "30",
    periodHours: 24,
    durationDays: 30,
    approvalAbove: "0",
    approvalWindowHours: 24,
  },
  {
    id: "subscription-runner",
    name: "Subscription runner",
    description: "Pays recurring invoices for three months. At most 25.00 a month.",
    perTx: "25",
    period: "25",
    total: "75",
    periodHours: 24 * 30,
    durationDays: 90,
    approvalAbove: "0",
    approvalWindowHours: 24,
  },
  {
    id: "shopping-errand",
    name: "One-day shopping errand",
    description: "One day, 50.00 in total. Anything from 25.00 up needs your approval.",
    perTx: "50",
    period: "50",
    total: "50",
    periodHours: 24,
    durationDays: 1,
    approvalAbove: "25",
    approvalWindowHours: 12,
  },
];

/** Turn a template into contract parameters. Start time defaults to now. */
export function templateToParams(t: MandateTemplate, agent: Address, opts: { agentId?: bigint; now?: number } = {}): MandateParams {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const threshold = parseUsd(t.approvalAbove);
  return {
    agent,
    agentId: opts.agentId ?? 0n,
    perTxCap: parseUsd(t.perTx),
    periodCap: parseUsd(t.period),
    totalCap: parseUsd(t.total),
    periodLength: Math.round(t.periodHours * 3600),
    // a few seconds in the past so it is valid at the next block even with clock skew
    validAfter: now - 5,
    expiry: now + Math.round(t.durationDays * 86400),
    approvalThreshold: threshold,
    approvalWindow: threshold === 0n ? 0 : Math.round(t.approvalWindowHours * 3600),
  };
}
