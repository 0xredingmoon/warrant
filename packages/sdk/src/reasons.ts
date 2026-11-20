/** Mirrors `IWarrantVault.Reason` in the contracts. The numeric values are the on-chain enum values. */
export const Reason = {
  Ok: 0,
  ApprovalRequired: 1,
  MandateNotFound: 2,
  MandateRevoked: 3,
  VaultFrozen: 4,
  NotYetValid: 5,
  MandateExpired: 6,
  MerchantNotAllowed: 7,
  ZeroAmount: 8,
  ExceedsPerTxCap: 9,
  ExceedsMerchantPerTxCap: 10,
  ExceedsPeriodCap: 11,
  ExceedsMerchantTotalCap: 12,
  ExceedsTotalCap: 13,
  InvoiceAlreadyUsed: 14,
  IntentExpired: 15,
  NonceUsed: 16,
  BadSignature: 17,
  InsufficientBalance: 18,
} as const;

export type ReasonName = keyof typeof Reason;

/**
 * Reasons that a vault records on-chain as `PaymentRefused` (via `payOrRefuse`): the intent was authentic and the
 * mandate's rules said no. The other refusals (unknown mandate, expired or replayed intent, bad signature) are not
 * recorded: they prove nothing about what the agent tried.
 */
export function isRecordableRefusal(code: number): boolean {
  return (
    code !== Reason.Ok &&
    code !== Reason.ApprovalRequired &&
    code !== Reason.MandateNotFound &&
    code !== Reason.IntentExpired &&
    code !== Reason.NonceUsed &&
    code !== Reason.BadSignature
  );
}

const NAMES = Object.fromEntries(Object.entries(Reason).map(([k, v]) => [v, k])) as Record<number, ReasonName>;

const MESSAGES: Record<ReasonName, string> = {
  Ok: "Payment allowed.",
  ApprovalRequired: "Allowed, but the amount is at or above the co-sign threshold: it waits for the owner's approval.",
  MandateNotFound: "That mandate doesn't exist in this vault.",
  MandateRevoked: "The owner revoked this mandate. No further payments are possible.",
  VaultFrozen: "The vault is frozen by the owner or guardian. Nothing can be paid until the owner unfreezes it.",
  NotYetValid: "This mandate isn't active yet (its start time hasn't been reached).",
  MandateExpired: "This mandate has expired.",
  MerchantNotAllowed: "That recipient is not on this mandate's merchant allowlist. The agent may only pay merchants the owner approved.",
  ZeroAmount: "The amount is zero.",
  ExceedsPerTxCap: "The amount is above the per-payment limit of this mandate.",
  ExceedsMerchantPerTxCap: "The amount is above the per-payment limit set for this merchant.",
  ExceedsPeriodCap: "This payment would exceed the mandate's spending limit for the trailing period.",
  ExceedsMerchantTotalCap: "This payment would exceed the total limit set for this merchant.",
  ExceedsTotalCap: "This payment would exceed the mandate's lifetime spending limit.",
  InvoiceAlreadyUsed: "This invoice was already paid (or is waiting for approval). Paying it twice is blocked.",
  IntentExpired: "The signed payment intent expired before it was submitted. Sign a new one.",
  NonceUsed: "This signed intent was already used (or cancelled).",
  BadSignature: "The signature doesn't match the mandate's agent key (or the intent was altered).",
  InsufficientBalance: "The vault doesn't hold enough tUSD8 for this payment.",
};

export function reasonName(code: number): ReasonName {
  const n = NAMES[code];
  if (!n) throw new Error(`Unknown Warrant reason code ${code}`);
  return n;
}

/** Human-readable explanation for a reason (by code or name). */
export function reasonMessage(reason: number | ReasonName): string {
  if (typeof reason === "number" && !NAMES[reason]) return `The vault returned a reason this SDK does not know (code ${reason}). Update @warrant/sdk.`;
  return MESSAGES[typeof reason === "number" ? reasonName(reason) : reason];
}

/** True when a payment with this reason moves money now. */
export const isOk = (code: number) => code === Reason.Ok;
/** True when the payment will execute now or be queued for approval (i.e. it is not rejected). */
export const isAccepted = (code: number) => code === Reason.Ok || code === Reason.ApprovalRequired;

export interface CheckResult {
  code: number;
  reason: ReasonName | "Unknown";
  message: string;
  /** executes now */
  ok: boolean;
  /** executes now or is queued for the owner */
  accepted: boolean;
}

export function toCheckResult(code: number): CheckResult {
  return { code, reason: NAMES[code] ?? "Unknown", message: reasonMessage(code), ok: isOk(code), accepted: isAccepted(code) };
}
