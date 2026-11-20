import type { Address, Hex } from "viem";

export interface MandateParams {
  agent: Address;
  /** AgentRegistry id (0n for none). The registry wallet must equal `agent`. */
  agentId: bigint;
  perTxCap: bigint;
  periodCap: bigint;
  totalCap: bigint;
  /** seconds */
  periodLength: number;
  /** unix seconds */
  validAfter: number;
  /** unix seconds, exclusive */
  expiry: number;
  /** payments >= this need the owner's approval; 0n = never */
  approvalThreshold: bigint;
  /** seconds the owner has to approve a queued payment */
  approvalWindow: number;
}

export interface MerchantRule {
  allowed: boolean;
  /** 0n = no extra per-payment cap */
  perTxCap: bigint;
  /** 0n = no extra lifetime cap for this merchant */
  totalCap: bigint;
}

export interface Mandate {
  id: bigint;
  params: MandateParams;
  spentTotal: bigint;
  revoked: boolean;
}

/** How much of a mandate's rolling period cap is in use right now. */
export interface WindowState {
  /** spent within the trailing `periodLength` (counted a little conservatively: up to one eighth of the period extra) */
  spent: bigint;
  /** the oldest counted spend: how much frees up and when (unix seconds). 0 when nothing is counted. */
  nextReleaseAmount: bigint;
  nextReleaseAt: number;
}

export interface PaymentIntent {
  mandateId: bigint;
  merchant: Address;
  /** gross amount in tUSD8 units (6 decimals) */
  amount: bigint;
  invoiceRef: Hex;
  /** hash of the agent's prompt/context/decision: kept on-chain for forensics */
  intentHash: Hex;
  nonce: Hex;
  /** unix seconds */
  deadline: bigint;
}

export type PendingStatus = "None" | "Open" | "Approved" | "Rejected" | "Expired";

export interface Pending {
  id: bigint;
  mandateId: bigint;
  merchant: Address;
  amount: bigint;
  createdAt: number;
  expiresAt: number;
  status: PendingStatus;
  invoiceRef: Hex;
  intentHash: Hex;
}

export type InvoiceState = "None" | "Pending" | "Paid";
