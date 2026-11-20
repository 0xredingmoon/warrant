import { keccak256, toBytes, toHex, type Address, type Hex } from "viem";
import type { PaymentIntent } from "./types";

export const WARRANT_DOMAIN_NAME = "Warrant";
export const WARRANT_DOMAIN_VERSION = "1";

export const paymentIntentTypes = {
  PaymentIntent: [
    { name: "mandateId", type: "uint256" },
    { name: "merchant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "invoiceRef", type: "bytes32" },
    { name: "intentHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const approvePaymentTypes = {
  ApprovePayment: [
    { name: "pendingId", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const vaultDomain = (chainId: number, vault: Address) =>
  ({ name: WARRANT_DOMAIN_NAME, version: WARRANT_DOMAIN_VERSION, chainId, verifyingContract: vault }) as const;

/** Anything that can sign EIP-712 typed data: a viem local account, or a wallet client with an account. */
export interface TypedDataSigner {
  signTypedData: (args: any) => Promise<Hex>;
}

export function randomBytes32(): Hex {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** keccak256 of a prompt / decision / context. Goes on-chain as `intentHash` so a payment can be traced to why the agent made it. */
export function hashContext(context: string | Record<string, unknown>): Hex {
  return keccak256(toBytes(typeof context === "string" ? context : JSON.stringify(context)));
}

export interface BuildIntentArgs {
  mandateId: bigint;
  merchant: Address;
  /** gross amount in tUSD8 units (6 decimals) */
  amount: bigint;
  /** merchant invoice id (bytes32). Random if omitted. Reuse the same ref when retrying so you can never double pay. */
  invoiceRef?: Hex;
  /** why the agent is paying: a string or object that is hashed into `intentHash` */
  context?: string | Record<string, unknown>;
  /** seconds the signed intent stays submittable (default 600) */
  ttlSeconds?: number;
  /** override the clock (unix seconds) */
  now?: number;
}

export function buildIntent(a: BuildIntentArgs): PaymentIntent {
  const now = a.now ?? Math.floor(Date.now() / 1000);
  return {
    mandateId: a.mandateId,
    merchant: a.merchant,
    amount: a.amount,
    invoiceRef: a.invoiceRef ?? randomBytes32(),
    intentHash: a.context === undefined ? ("0x" + "00".repeat(32)) as Hex : hashContext(a.context),
    nonce: randomBytes32(),
    deadline: BigInt(now + (a.ttlSeconds ?? 600)),
  };
}

/** Sign a payment intent as the mandate's agent. The vault address and chain id are part of the signature. */
export function signIntent(args: {
  signer: TypedDataSigner;
  chainId: number;
  vault: Address;
  intent: PaymentIntent;
}): Promise<Hex> {
  return args.signer.signTypedData({
    domain: vaultDomain(args.chainId, args.vault),
    types: paymentIntentTypes,
    primaryType: "PaymentIntent",
    message: args.intent,
  });
}

/** Owner co-sign for a queued payment (relayable by anyone via `approveBySig`). */
export function signApproval(args: {
  signer: TypedDataSigner;
  chainId: number;
  vault: Address;
  pendingId: bigint;
  deadline: bigint;
}): Promise<Hex> {
  return args.signer.signTypedData({
    domain: vaultDomain(args.chainId, args.vault),
    types: approvePaymentTypes,
    primaryType: "ApprovePayment",
    message: { pendingId: args.pendingId, deadline: args.deadline },
  });
}

export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** EIP-3009 authorization letting a relayer deposit `value` tUSD8 from `from` into `to` (the vault) with no gas from `from`. */
export function signReceiveWithAuthorization(args: {
  signer: TypedDataSigner;
  chainId: number;
  token: Address;
  tokenDomain?: { name: string; version: string };
  from: Address;
  to: Address;
  value: bigint;
  validAfter?: bigint;
  validBefore: bigint;
  nonce?: Hex;
}): Promise<{ signature: Hex; nonce: Hex; validAfter: bigint; validBefore: bigint }> {
  const nonce = args.nonce ?? randomBytes32();
  const validAfter = args.validAfter ?? 0n;
  return args.signer
    .signTypedData({
      domain: {
        name: args.tokenDomain?.name ?? "tUSD8",
        version: args.tokenDomain?.version ?? "2",
        chainId: args.chainId,
        verifyingContract: args.token,
      },
      types: receiveWithAuthorizationTypes,
      primaryType: "ReceiveWithAuthorization",
      message: { from: args.from, to: args.to, value: args.value, validAfter, validBefore: args.validBefore, nonce },
    })
    .then((signature) => ({ signature, nonce, validAfter, validBefore: args.validBefore }));
}
