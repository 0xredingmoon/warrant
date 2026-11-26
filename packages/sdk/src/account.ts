import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
} from "viem";
import { signUserOpHash, type RawSigner } from "./account-signer";

/**
 * A minimal ERC-4337 v0.7 client for one Kernel v3.1 account on Aevum.
 *
 * It exists because the bundler on Aevum is the only piece of the 4337 stack that is live: there is no paymaster and
 * no ZeroDev or permissionless SDK configured for chain 44005. Everything else is small enough to be exact: derive the
 * counterfactual address from the factory, deploy it, build a PackedUserOperation, sign it, and send it.
 *
 * Two constraints from the chain that this encodes:
 *
 * - The account pays its own gas. There is no paymaster, so the EntryPoint's prefund is taken from the account's
 *   tQDAY balance, and it has to be there before the UserOp is validated (`AA21 didn't pay prefund` otherwise).
 * - The account is deployed before the UserOp, not in `initCode`. The KernelFactory on Aevum is not staked on the
 *   EntryPoint, and EntryPoint v0.7 forbids a counterfactual deployment from touching the ECDSA validator's storage
 *   unless the factory is staked ("...accessed during deployment. Factory ... must be staked"). `createAccount` is
 *   permissionless and `getAddress` does not depend on `msg.sender`, so a plain transaction to the factory lands the
 *   account exactly where `getAddress` predicts, and the UserOp then carries no `initCode`.
 */

export const ENTRYPOINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

/** Aevum's Kernel v3.1 deployment, read from the chain rather than guessed: 2026-11-26. */
export const AEVM_KERNEL_FACTORY: Address = "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419";
export const AEVM_KERNEL_IMPLEMENTATION: Address = "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D";
/** ECDSA root validator, `rootValidator()` on any account from this factory: 0x01 || this address. */
export const AEVM_ECDSA_VALIDATOR: Address = "0x845adb2c711129d4f3966735ed98a9f09fc4ce57";

export const kernelFactoryAbi = [
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [{ name: "data", type: "bytes" }, { name: "salt", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "createAccount",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes" }, { name: "salt", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const kernelAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "execMode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rootValidator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes21" }],
  },
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

const packedOpAbi = parseAbiParameters([
  "address sender",
  "uint256 nonce",
  "bytes initCode",
  "bytes callData",
  "bytes32 accountGasLimits",
  "uint256 preVerificationGas",
  "bytes32 gasFees",
  "bytes paymasterAndData",
]);

/** `0x000000` in the first three bytes is the default exec mode: a single call, revert the whole op on failure. */
export const CALLTYPE_SINGLE_DEFAULT_MODE: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Pack `verificationGasLimit` and `callGasLimit` the way EntryPoint v0.7 does, high 128 bits first. */
export function packUints(hi: bigint, lo: bigint): Hex {
  if (hi > (1n << 128n) - 1n || lo > (1n << 128n) - 1n) throw new Error("packUints: value does not fit 128 bits");
  return toHex(concat([toHex(hi, { size: 16 }), toHex(lo, { size: 16 })]), { size: 32 });
}

/** The Kernel v3.1 account init data: root validator `0x01 || address`, no hook, owner, nothing else. */
export function kernelAccountInitData(owner: Address, rootValidator: Address = AEVM_ECDSA_VALIDATOR): Hex {
  return encodeFunctionData({
    abi: [{
      type: "function",
      name: "initialize",
      stateMutability: "nonpayable",
      inputs: [
        { name: "_rootValidator", type: "bytes21" },
        { name: "hook", type: "address" },
        { name: "validatorData", type: "bytes" },
        { name: "hookData", type: "bytes" },
        { name: "initConfig", type: "bytes[]" },
      ],
      outputs: [],
    }],
    functionName: "initialize",
    // ECDSAValidator.onInstall reads only address(bytes20(validatorData)), so the owner address is the whole payload.
    args: [`0x01${rootValidator.slice(2)}` as Hex, "0x0000000000000000000000000000000000000000", owner, "0x", []],
  });
}

/** The address `getAddress(initData, salt)` returns, computed on the factory so it cannot drift from the deployment. */
export function predictAccount(args: {
  publicClient: PublicClient;
  factory?: Address;
  owner: Address;
  salt: Hex;
  rootValidator?: Address;
}): Promise<Address> {
  return args.publicClient.readContract({
    address: args.factory ?? AEVM_KERNEL_FACTORY,
    abi: kernelFactoryAbi,
    functionName: "getAddress",
    args: [kernelAccountInitData(args.owner, args.rootValidator), args.salt],
  });
}

/** Encode `execute(mode, call)` for one target, or `execute(mode, calls[])` when several are passed. */
export function encodeExecCall(calls: { to: Address; data: Hex; value?: bigint }[], mode: Hex = CALLTYPE_SINGLE_DEFAULT_MODE): Hex {
  const first = calls[0];
  if (calls.length === 1 && first) {
    const executionCalldata = encodeAbiParameters(
      parseAbiParameters("address target, uint256 value, bytes callData"),
      [first.to, first.value ?? 0n, first.data],
    );
    return encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [mode, executionCalldata] });
  }
  return encodeFunctionData({
    abi: kernelBatchExecuteAbi,
    functionName: "execute",
    args: [mode, calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data }))],
  });
}

export interface KernelUserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

/** EntryPoint v0.7 `getUserOpHash`, packed exactly as UserOperationLib does it. */
export function getUserOpHash(args: { userOp: KernelUserOp; entryPoint?: Address; chainId: number }): Hex {
  const op = args.userOp;
  const packed = keccak256(encodeAbiParameters(packedOpAbi, [
    op.sender,
    op.nonce,
    op.initCode,
    op.callData,
    packUints(op.verificationGasLimit, op.callGasLimit),
    op.preVerificationGas,
    packUints(op.maxPriorityFeePerGas, op.maxFeePerGas),
    op.paymasterAndData,
  ]));
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, uint256"), [
      packed,
      args.entryPoint ?? ENTRYPOINT_V07,
      BigInt(args.chainId),
    ]),
  );
}

/** The bundler wire shape: EntryPoint v0.7 optional-gas fields, all hex, with factory/factoryData when undeployed. */
export function toBundlerUserOp(userOp: KernelUserOp): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    sender: userOp.sender,
    nonce: toHex(userOp.nonce),
    callData: userOp.callData,
    callGasLimit: toHex(userOp.callGasLimit),
    verificationGasLimit: toHex(userOp.verificationGasLimit),
    preVerificationGas: toHex(userOp.preVerificationGas),
    maxFeePerGas: toHex(userOp.maxFeePerGas),
    maxPriorityFeePerGas: toHex(userOp.maxPriorityFeePerGas),
    signature: userOp.signature,
  };
  if (userOp.paymasterAndData !== "0x") wire.paymasterAndData = userOp.paymasterAndData;
  return wire;
}

export interface SendUserOpOptions {
  publicClient: PublicClient;
  /** A wallet client for the funder, with its account set: it pays for the deployment and the prefund transfer. */
  funder: WalletClient;
  bundlerUrl: string;
  entryPoint?: Address;
  chainId: number;
  /** tQDAY to put in the account before the UserOp, if the account has less than this. Default 0.02. */
  minAccountBalance?: bigint;
  /** gas limits; the bundler's own `eth_estimateUserOperationGas` is not usable before a valid signature. */
  callGasLimit?: bigint;
  verificationGasLimit?: bigint;
  preVerificationGas?: bigint;
  gasPrice?: bigint;
  /** how long to wait for the UserOp receipt, in ms. Aevum's bundler batches slowly, so this defaults to 10 minutes. */
  waitTimeoutMs?: number;
}

export interface SentUserOp {
  userOpHash: Hex;
  transactionHash?: Hex;
  success?: boolean;
  actualGasUsed?: bigint;
  account: Address;
  deployed: boolean;
  deploymentTx?: Hex;
  prefundTx?: Hex;
}

async function rpc(bundlerUrl: string, method: string, params: unknown[]): Promise<any> {
  const r = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return r.json();
}

/**
 * Make sure the account exists and holds enough tQDAY, then send `calls` as one UserOp and wait for its receipt.
 *
 * The deployment and prefund transactions come from `funder`, which is any wallet holding a little tQDAY; they are not
 * paid by the account. The UserOp itself is paid by the account. There is no paymaster on Aevum.
 */
export async function sendKernelUserOp(args: SendUserOpOptions & {
  owner: RawSigner & { address: Address };
  calls: { to: Address; data: Hex; value?: bigint }[];
  factory?: Address;
  salt: Hex;
  rootValidator?: Address;
}): Promise<SentUserOp> {
  const { publicClient, funder, chainId, owner, calls } = args;
  const bundlerUrl = args.bundlerUrl;
  const entryPoint = args.entryPoint ?? ENTRYPOINT_V07;
  const factory = args.factory ?? AEVM_KERNEL_FACTORY;

  const initData = kernelAccountInitData(owner.address, args.rootValidator);
  const account = await publicClient.readContract({ address: factory, abi: kernelFactoryAbi, functionName: "getAddress", args: [initData, args.salt] });

  const deploymentTx = await ensureDeployed({ publicClient, funder, factory, initData, salt: args.salt, account });
  const prefundTx = await ensureFunded({ publicClient, funder, account, min: args.minAccountBalance ?? 20_000_000_000_000_000n });

  const gasPrice = args.gasPrice ?? await publicClient.getGasPrice();
  const nonce = await publicClient.readContract({
    address: entryPoint,
    abi: [{ type: "function", name: "getNonce", stateMutability: "view", inputs: [{ name: "sender", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ type: "uint256" }] }],
    functionName: "getNonce",
    args: [account, 0n],
  });

  const callData = encodeExecCall(calls);

  const userOp: KernelUserOp = {
    sender: account,
    nonce,
    initCode: "0x",
    callData,
    callGasLimit: args.callGasLimit ?? 700_000n,
    verificationGasLimit: args.verificationGasLimit ?? 400_000n,
    preVerificationGas: args.preVerificationGas ?? 80_000n,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice,
    paymasterAndData: "0x",
    signature: "0x",
  };

  const hash = getUserOpHash({ userOp, entryPoint, chainId });
  userOp.signature = await signUserOpHash({ signer: owner, userOpHash: hash });

  const wire = toBundlerUserOp(userOp);
  const sent = await rpc(bundlerUrl, "eth_sendUserOperation", [wire, entryPoint]);
  if (sent.error) {
    throw new Error(`bundler rejected the UserOp: ${sent.error.message}${sent.error.data ? ` ${JSON.stringify(sent.error.data)}` : ""}`);
  }
  const userOpHash = sent.result as Hex;

  const receipt = await waitForReceipt(bundlerUrl, userOpHash, args.waitTimeoutMs ?? 10 * 60_000);
  return {
    userOpHash,
    transactionHash: receipt?.receipt?.transactionHash,
    success: receipt?.success,
    actualGasUsed: receipt?.actualGasUsed ? BigInt(receipt.actualGasUsed) : undefined,
    account,
    deployed: true,
    deploymentTx,
    prefundTx,
  };
}

const kernelBatchExecuteAbi = [{
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [
    { name: "execMode", type: "bytes32" },
    { name: "executionCalldata", type: "tuple[]", components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ] },
  ],
  outputs: [],
}] as const;

async function ensureDeployed(args: {
  publicClient: PublicClient;
  funder: WalletClient;
  factory: Address;
  initData: Hex;
  salt: Hex;
  account: Address;
}): Promise<Hex | undefined> {
  const code = await args.publicClient.getCode({ address: args.account });
  if (code && code !== "0x") return undefined;
  // createAccount is permissionless and getAddress ignores msg.sender, so any funded wallet can deploy it.
  const hash = await args.funder.sendTransaction({
    account: args.funder.account!,
    chain: null,
    to: args.factory,
    data: encodeFunctionData({ abi: kernelFactoryAbi, functionName: "createAccount", args: [args.initData, args.salt] }),
    gasPrice: await args.publicClient.getGasPrice(),
    type: "legacy",
  });
  await args.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function ensureFunded(args: {
  publicClient: PublicClient;
  funder: WalletClient;
  account: Address;
  min: bigint;
}): Promise<Hex | undefined> {
  const balance = await args.publicClient.getBalance({ address: args.account });
  if (balance >= args.min) return undefined;
  const hash = await args.funder.sendTransaction({
    account: args.funder.account!,
    chain: null,
    to: args.account,
    value: args.min - balance,
    gasPrice: await args.publicClient.getGasPrice(),
    type: "legacy",
  });
  await args.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function waitForReceipt(bundlerUrl: string, userOpHash: Hex, timeoutMs: number): Promise<any | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rpc(bundlerUrl, "eth_getUserOperationReceipt", [userOpHash]);
    if (r.result) return r.result;
    await new Promise((res) => setTimeout(res, 4_000));
  }
  return undefined;
}
