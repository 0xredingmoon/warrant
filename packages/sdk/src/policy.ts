import { encodeFunctionData, type Address, type Hex } from "viem";
import { warrantVaultAbi } from "./abis";
import { signIntentAsAccount } from "./account-signer";
import { predictAccount, sendKernelUserOp, type KernelUserOp, type SendUserOpOptions, type SentUserOp } from "./account";
import type { TypedDataSigner } from "./intents";
import type { PaymentIntent } from "./types";
import type { RawSigner } from "./account-signer";

/**
 * The agent as a smart account, with Warrant as its spending policy.
 *
 * The mandate's `agent` is the Kernel account, not a key. The agent (the owner key inside the account) signs the
 * `PaymentIntent` as the account, in the ERC-1271 form `signIntentAsAccount` builds, and the account submits that
 * intent to `WarrantVault.payOrRefuse` in a UserOp call. `payOrRefuse` checks the signature with `SignatureChecker`,
 * which reaches the account's `isValidSignature`, so the vault really is validating a smart-account signature. It then
 * applies the mandate exactly as it does for an EOA agent: a payment inside the rules moves funds and emits
 * `PaymentExecuted`; a payment that breaks a rule moves nothing and emits `PaymentRefused` on chain.
 *
 * This is handoff shape (a). It reuses `buildIntent` and the vault's own `payOrRefuse`, changes no Solidity, and the
 * only new thing on the agent side is the signature envelope.
 */
export async function payWithSmartAccount(args: SendUserOpOptions & {
  owner: RawSigner & TypedDataSigner & { address: Address };
  /** the mandate's agent, which must be the Kernel account this owner controls */
  account: Address;
  vault: Address;
  intent: PaymentIntent;
  factory?: Address;
  salt: Hex;
  rootValidator?: Address;
}): Promise<SentUserOp & { callData: Hex; intent: PaymentIntent }> {
  // The intent is signed as `args.account` but the UserOp is submitted from the account this owner derives to. If those
  // disagree the vault would verify against a different contract than the one sending, so refuse before any gas is spent.
  const derived = await predictAccount({
    publicClient: args.publicClient,
    factory: args.factory,
    owner: args.owner.address,
    salt: args.salt,
    rootValidator: args.rootValidator,
  });
  if (derived.toLowerCase() !== args.account.toLowerCase()) {
    throw new Error(`policy: owner ${args.owner.address} controls ${derived}, not the mandate agent ${args.account}`);
  }
  const agentSignature = await signIntentAsAccount({
    signer: args.owner,
    chainId: args.chainId,
    account: args.account,
    vault: args.vault,
    intent: args.intent,
  });
  const callData = encodeFunctionData({
    abi: warrantVaultAbi,
    functionName: "payOrRefuse",
    args: [args.intent, agentSignature],
  });
  const sent = await sendKernelUserOp({
    ...args,
    calls: [{ to: args.vault, data: callData }],
  });
  return { ...sent, callData, intent: args.intent };
}

/** The UserOp's call, without sending it. Useful for a dry run and for asserting the encoding in tests. */
export async function buildPolicyCall(args: {
  owner: RawSigner & TypedDataSigner & { address: Address };
  chainId: number;
  account: Address;
  vault: Address;
  intent: PaymentIntent;
}): Promise<{ callData: Hex; agentSignature: Hex }> {
  const agentSignature = await signIntentAsAccount({
    signer: args.owner,
    chainId: args.chainId,
    account: args.account,
    vault: args.vault,
    intent: args.intent,
  });
  return {
    agentSignature,
    callData: encodeFunctionData({ abi: warrantVaultAbi, functionName: "payOrRefuse", args: [args.intent, agentSignature] }),
  };
}

/** A minimal shape of what a receipt tells us, for callers that only care about the policy outcome. */
export interface PolicyOutcome {
  userOpHash: Hex;
  transactionHash?: Hex;
  success?: boolean;
  callData: Hex;
}

export function toPolicyOutcome(sent: SentUserOp & { callData: Hex }): PolicyOutcome {
  return { userOpHash: sent.userOpHash, transactionHash: sent.transactionHash, success: sent.success, callData: sent.callData };
}

export type { KernelUserOp };
