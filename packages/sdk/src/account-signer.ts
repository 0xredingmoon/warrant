import { hashTypedData, type Address, type Hex } from "viem";
import { paymentIntentTypes, vaultDomain, type TypedDataSigner } from "./intents";
import type { PaymentIntent } from "./types";

/** The EIP-712 digest the vault passes to `SignatureChecker`. This is what ERC-1271 receives, never a signature. */
export function intentDigest(chainId: number, vault: Address, intent: PaymentIntent): Hex {
  return hashTypedData({
    domain: vaultDomain(chainId, vault),
    types: paymentIntentTypes,
    primaryType: "PaymentIntent",
    message: intent as any,
  });
}

/**
 * Signing as an ERC-4337 Kernel v3.1 smart account.
 *
 * Two different signatures come out of the same owner key, and they are not interchangeable:
 *
 * - The UserOp signature goes to the EntryPoint. It is a plain EIP-191 signature over `getUserOpHash`, and Kernel's
 *   root ECDSA validator accepts it directly. See `signUserOpHash`.
 * - The mandate signature goes to `WarrantVault.payOrRefuse`, which verifies it with OpenZeppelin's
 *   `SignatureChecker.isValidSignatureNow(agent, intentDigest, sig)`. When `agent` is a contract, that is an
 *   ERC-1271 `isValidSignature` call, and Kernel does not accept a bare 65-byte signature there. It first decodes a
 *   validation envelope from the front of the signature (`ValidationTypeLib.decodeSignature`), then verifies the
 *   remaining bytes against `_toWrappedHash(intentDigest)`. For an ECDSA root validator the envelope is the single
 *   byte `0x00`, the signature is EIP-191 over the wrapped digest, and the wrapped digest is the Kernel EIP-712
 *   `Kernel(bytes32 hash)` under the account's own domain. See `signIntentAsAccount`.
 *
 * The wrapped digest is computed locally rather than by asking the account, so this stays offline and testable. The
 * type hash is `keccak256("Kernel(bytes32 hash)")`, which is the constant `KERNEL_WRAPPER_TYPE_HASH` in Kernel v3.1.
 */

/** keccak256("Kernel(bytes32 hash)"): KERNEL_WRAPPER_TYPE_HASH in Kernel v3.1 (NOT "KernelWrapper(...)"). */
export const KERNEL_WRAPPER_TYPE_HASH: Hex = "0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83";

export const kernelWrapperTypes = {
  Kernel: [{ name: "hash", type: "bytes32" }],
} as const;

export const KERNEL_DOMAIN_NAME = "Kernel";
export const KERNEL_DOMAIN_VERSION = "0.3.1";

/** ERC-1271 magic value: what a valid contract signature returns from `isValidSignature`. */
export const ERC1271_MAGIC_VALUE: Hex = "0x1626ba7e";

/** The EIP-712 domain Kernel uses for the wrapper. `verifyingContract` is the account, not the implementation. */
export const kernelDomain = (chainId: number, account: Address) =>
  ({ name: KERNEL_DOMAIN_NAME, version: KERNEL_DOMAIN_VERSION, chainId, verifyingContract: account }) as const;

/** The digest Kernel hands to its root validator for an ERC-1271 check, for an arbitrary inner hash. */
export function wrapForKernel(args: { chainId: number; account: Address; hash: Hex }): Hex {
  return hashTypedData({
    domain: kernelDomain(args.chainId, args.account),
    types: kernelWrapperTypes,
    primaryType: "Kernel",
    message: { hash: args.hash },
  });
}

/** Anything that can produce an EIP-191 signature over raw bytes: a viem local account. */
export interface RawSigner {
  signMessage: (args: { message: { raw: Hex } }) => Promise<Hex>;
}

/** The EntryPoint signature for a Kernel account: EIP-191 over `getUserOpHash`. No envelope, no wrapping. */
export function signUserOpHash(args: { signer: RawSigner; userOpHash: Hex }): Promise<Hex> {
  return args.signer.signMessage({ message: { raw: args.userOpHash } });
}

/**
 * Sign a Warrant `PaymentIntent` as the smart account, in the form `SignatureChecker` reaches through ERC-1271:
 * `0x00 || EIP-191(Kernel-wrapped(data hash intent))`.
 *
 * `signer` is the account's owner key, or a wallet client that holds it. `useEthereumPrefix` stays true: Kernel's
 * ECDSA validator checks the bare digest first and the EIP-191 form second, and `eth_signTypedData` produces the
 * bare form. Both verify; the prefixed form is the one `signMessage` gives and is what this repository uses.
 */
export async function signIntentAsAccount(args: {
  signer: TypedDataSigner & RawSigner;
  chainId: number;
  account: Address;
  vault: Address;
  intent: PaymentIntent;
}): Promise<Hex> {
  // `signIntent` returns an EIP-2098 compact (64 byte) signature. Kernel wraps the 32 byte DIGEST, not a signature,
  // so build the digest here. This is the mistake the type system does not catch: bytes is bytes.
  const digest = intentDigest(args.chainId, args.vault, args.intent);
  const wrapped = wrapForKernel({ chainId: args.chainId, account: args.account, hash: digest });
  const sig = await args.signer.signMessage({ message: { raw: wrapped } });
  return `0x00${sig.slice(2)}` as Hex;
}

/** Same envelope, for a hash that is already the EIP-712 digest the contract will pass to ERC-1271. */
export async function signDigestAsAccount(args: {
  signer: RawSigner;
  chainId: number;
  account: Address;
  hash: Hex;
}): Promise<Hex> {
  const wrapped = wrapForKernel({ chainId: args.chainId, account: args.account, hash: args.hash });
  const sig = await args.signer.signMessage({ message: { raw: wrapped } });
  return `0x00${sig.slice(2)}` as Hex;
}
