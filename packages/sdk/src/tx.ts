import {
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { reasonMessage, reasonName, type ReasonName } from "./reasons";

export interface Clients {
  publicClient: PublicClient;
  /** must have an `account` */
  walletClient: WalletClient;
}

export interface TxResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

/** Thrown when the vault refuses a payment. `.reason` is the on-chain reason, `.message` is plain language. */
export class WarrantRejected extends Error {
  constructor(
    public readonly code: number,
    public readonly reason: ReasonName,
  ) {
    super(reasonMessage(code));
    this.name = "WarrantRejected";
  }
}

/** Pull the on-chain `PaymentRejected(reason)` out of a viem error, if there is one. */
export function decodeRejection(err: unknown): WarrantRejected | undefined {
  if (err instanceof WarrantRejected) return err;
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === "PaymentRejected") {
      const code = Number((reverted.data.args as readonly unknown[])[0]);
      return new WarrantRejected(code, reasonName(code));
    }
  }
  return undefined;
}

/** True when the user said no in their wallet (EIP-1193 code 4001, or viem's UserRejectedRequestError). */
export function isUserRejection(err: unknown): boolean {
  let e: any = err;
  for (let i = 0; e && i < 6; i++) {
    if (e.code === 4001 || e.name === "UserRejectedRequestError" || /user (rejected|denied)/i.test(String(e.shortMessage ?? e.message ?? ""))) return true;
    e = e.cause;
  }
  return false;
}

/** True when the wallet says this page has no access to the account (EIP-1193 code 4100, MetaMask's "not been authorized"). */
export function isUnauthorized(err: unknown): boolean {
  let e: any = err;
  for (let i = 0; e && i < 6; i++) {
    if (e.code === 4100 || /has not been authorized|not authorized by the user/i.test(String(e.shortMessage ?? e.message ?? ""))) return true;
    e = e.cause;
  }
  return false;
}

/** Friendly message for any error coming out of a vault/factory/registry call. */
export function explainError(err: unknown): string {
  const rejected = decodeRejection(err);
  if (rejected) return rejected.message;
  if (isUserRejection(err)) return "You rejected the request in your wallet. Nothing was sent.";
  if (isUnauthorized(err)) return "Your wallet has not given this page access to the account. Connect the wallet again and approve it, then retry.";
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      return CUSTOM_ERRORS[reverted.data.errorName] ?? `Contract refused the call (${reverted.data.errorName}).`;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

const CUSTOM_ERRORS: Record<string, string> = {
  Unauthorized: "Only the vault owner (or the right role) can do that.",
  InvalidCaps: "Caps must nest: per-payment ≤ per-period ≤ lifetime, and per-payment must be above zero.",
  InvalidTimeWindow: "The mandate's time window is invalid (expiry must be in the future, after the start, and within a year).",
  InvalidApproval: "The approval threshold must be at most the per-payment cap and needs an approval window.",
  NoMerchants: "Add at least one merchant to the allowlist.",
  IdentityMismatch: "The agent's registry wallet doesn't match the mandate's agent key.",
  PendingNotOpen: "That queued payment is no longer open.",
  PendingWindowClosed: "The approval window for that payment has closed.",
  PendingStillOpen: "That payment can't be expired yet.",
  SignatureExpired: "That signature has expired.",
  RefusalLogFull: "This mandate already has the maximum number of recorded refusals.",
};

/**
 * Aevum quirks: use legacy (type 0) transactions. We simulate first (so reverts surface as decoded reasons),
 * send with a 20% gas-price margin, then wait for the receipt.
 */
export async function writeLegacy(
  clients: Clients,
  call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; gas?: bigint },
): Promise<TxResult> {
  const { publicClient, walletClient } = clients;
  const account = walletClient.account;
  if (!account) throw new Error("walletClient needs an account");
  const gasPrice = ((await publicClient.getGasPrice()) * 12n) / 10n;
  const sim = await publicClient.simulateContract({
    account,
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  } as any);
  const hash = await walletClient.writeContract({
    ...(sim.request as any),
    type: "legacy",
    gasPrice,
    gas: call.gas,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return { hash, receipt };
}
