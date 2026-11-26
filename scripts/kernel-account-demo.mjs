// Runs the agent as an ERC-4337 Kernel v3.1 smart account on Aevum, with the Warrant vault as its spending policy.
//
// It does three things, in order, and each one is a real transaction:
//   1. issue a mandate on the demo vault whose agent is the Kernel account (the vault owner signs it),
//   2. send a hostile payment from the account through the bundler, which the vault refuses on chain,
//   3. send one payment inside the mandate from the same account, so the proof is "refused when it should be, paid
//      when it should be", not just one half.
//
// usage:
//   KERNEL_DEMO=1 node scripts/kernel-account-demo.mjs            # full run against Aevum
//   node scripts/kernel-account-demo.mjs --plan                   # print what it would do, no transactions
//
// Reads keys from .demo/ (gitignored): demo-deployer.key owns the demo vault and funds gas;
// kernel-account.key is the account's owner key. It never prints a key.

import { createPublicClient, createWalletClient, http, parseUnits, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
// Run from packages/sdk, so `viem` and the SDK build resolve without a root install:
//   cd packages/sdk && node ../../scripts/kernel-account-demo.mjs
import {
  AEVM_KERNEL_FACTORY, AEVM_ECDSA_VALIDATOR, predictAccount, payWithSmartAccount,
  buildIntent, buildPolicyCall, warrantVaultAbi, toCheckResult,
} from "../packages/sdk/dist/index.js";

const RPC = "https://rpc-test.qday.info";
const BUNDLER = process.env.BUNDLER_URL ?? "https://bundler.qday.info";
const CHAIN_ID = 44005;
const EXPLORER = "https://explorer-test.qday.info";
const VAULT = "0xC3Cd5BEF962C78e5f673386f808046E9812e905e";
const MERCHANT = "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae"; // the demo vault's allowed merchant
const SALT = "0x" + "00".repeat(32);
const OUT = new URL("../deployments/kernel-account-demo.json", import.meta.url);

// Vault event topics, keccak of the exact signatures in src/interfaces/IWarrantVault.sol. A UserOp can be bundled and
// still fail (success=false); the vault log is the only proof the payment reached the policy contract.
const PAYMENT_REFUSED = "0xd29fbc4ea2b9029a0887ad29bfba66cf76e79eeefe29f01ff46905aeeb99a6a7";
const PAYMENT_EXECUTED = "0x4ee8b23f2832af04454bbbcdf4fbecc322343455cdc1139fa5741b11e094e7e6";

const publicClient = createPublicClient({ transport: http(RPC) });
const plan = process.argv.includes("--plan");

const keyPath = (name) => new URL(`../.demo/${name}`, import.meta.url);
function readKey(name) {
  const p = keyPath(name);
  if (!existsSync(p)) throw new Error(`missing ${p.pathname}; see HANDOFF-kernel.md`);
  return readFileSync(p, "utf8").trim();
}

async function main() {
  const owner = privateKeyToAccount(readKey("kernel-account.key"));
  const deployer = privateKeyToAccount(readKey("demo-deployer.key"));
  const deployerWallet = createWalletClient({ account: deployer, transport: http(RPC) });

  const account = await predictAccount({ publicClient, factory: AEVM_KERNEL_FACTORY, owner: owner.address, salt: SALT });
  console.log("owner   ", owner.address);
  console.log("account ", account);
  console.log("vault   ", VAULT);

  // The vault's owner must be the key we hold, or nothing below can be issued.
  const vaultOwner = await publicClient.readContract({ address: VAULT, abi: warrantVaultAbi, functionName: "owner" });
  if (vaultOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`the demo vault is owned by ${vaultOwner}, not by .demo/demo-deployer.key`);
  }

  // 1. A mandate whose agent is the smart account. Same shape as the demo mandate: narrow, long lived, no approval.
  const mandateCount = await publicClient.readContract({ address: VAULT, abi: warrantVaultAbi, functionName: "mandateCount" });
  let mandateId = await findMandateFor({ vault: VAULT, agent: account, count: Number(mandateCount) });
  console.log("mandate ", mandateId === undefined ? "(none yet, will create)" : `#${mandateId} already names the account as agent`);

  if (plan) {
    console.log("plan: create mandate if missing, then a 250.00 tUSD8 overspend (refused) and a 0.05 in-rule payment (paid).");
    return;
  }

  if (mandateId === undefined) {
    const now = Math.floor(Date.now() / 1000);
    const params = {
      agent: account,
      agentId: 0n,
      perTxCap: parseUnits("2", 6),
      periodCap: parseUnits("10", 6),
      totalCap: parseUnits("50", 6),
      periodLength: 86400,
      validAfter: BigInt(now),
      expiry: BigInt(now + 180 * 86400),
      approvalThreshold: 0n,
      approvalWindow: 0,
    };
    const rules = [{ allowed: true, perTxCap: 0n, totalCap: 0n }];
    const hash = await deployerWallet.sendTransaction({
      account: deployer,
      chain: null,
      to: VAULT,
      data: encodeFunctionData({ abi: warrantVaultAbi, functionName: "createMandate", args: [params, [MERCHANT], rules] }),
      gasPrice: await publicClient.getGasPrice(),
      type: "legacy",
    });
    console.log("createMandate tx", `${EXPLORER}/tx/${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });
    mandateId = Number(await publicClient.readContract({ address: VAULT, abi: warrantVaultAbi, functionName: "mandateCount" }));
    console.log("mandate ", `#${mandateId} names ${account} as its agent`);
  }

  // 2. The hostile payment. 250.00 against a 2.00 per-payment limit: the account signs, the vault refuses.
  const overspend = buildIntent({ mandateId: BigInt(mandateId), merchant: MERCHANT, amount: parseUnits("250", 6), context: "kernel smart account, overspend" });
  const before = await readCheck(overspend, owner, account);
  console.log("check(overspend)", JSON.stringify(before));
  const refused = await payWithSmartAccount({
    publicClient, funder: deployerWallet, bundlerUrl: BUNDLER, chainId: CHAIN_ID,
    owner, account, vault: VAULT, intent: overspend, salt: SALT,
  });
  console.log("overspend userOpHash", refused.userOpHash);
  console.log("overspend tx         ", refused.transactionHash ? `${EXPLORER}/tx/${refused.transactionHash}` : "(no receipt)");
  // A bundled UserOp can still fail: EntryPoint emits UserOperationEvent(success=false) and the transaction itself is
  // status 1. The vault log is the proof, so require it on chain instead of trusting the receipt.
  const refusal = await vaultLog({ txHash: refused.transactionHash, vault: VAULT, events: ["PaymentRefused"] });
  if (!refusal) {
    throw new Error(`the overspend UserOp did not reach the vault (tx ${refused.transactionHash}); check the UserOperationEvent`);
  }
  console.log("PaymentRefused on chain", refusal.event, "mandate", Number(BigInt(refusal.topics[1])), "agent", `0x${refusal.topics[2].slice(26)}`, "merchant", `0x${refusal.topics[3].slice(26)}`, "amount", BigInt(`0x${refusal.data.slice(2, 66)}`).toString(), "reason", Number(BigInt(`0x${refusal.data.slice(66, 130)}`)));

  // 3. A payment inside the mandate, from the same account, so the mandate is demonstrably live and not just refusing.
  const inRule = buildIntent({ mandateId: BigInt(mandateId), merchant: MERCHANT, amount: parseUnits("0.05", 6), context: "kernel smart account, in rule" });
  console.log("check(in rule)     ", JSON.stringify(await readCheck(inRule, owner, account)));
  const paid = await payWithSmartAccount({
    publicClient, funder: deployerWallet, bundlerUrl: BUNDLER, chainId: CHAIN_ID,
    owner, account, vault: VAULT, intent: inRule, salt: SALT,
  });
  console.log("in-rule userOpHash  ", paid.userOpHash);
  console.log("in-rule tx          ", paid.transactionHash ? `${EXPLORER}/tx/${paid.transactionHash}` : "(no receipt)");
  const executed = await vaultLog({ txHash: paid.transactionHash, vault: VAULT, events: ["PaymentExecuted"] });
  if (!executed) throw new Error(`the in-rule UserOp did not reach the vault (tx ${paid.transactionHash})`);
  // PaymentExecuted carries 3 indexed params (mandateId, merchant, invoiceRef), then in data: agent, amount, fee,
  // intentHash, receiptId. Print only fields whose offset is certain.
  console.log("PaymentExecuted on chain", executed.event, "mandate", Number(BigInt(executed.topics[1])), "merchant", `0x${executed.topics[2].slice(26)}`);

  const record = {
    network: "aevum", chainId: CHAIN_ID,
    account, owner: owner.address, vault: VAULT, mandateId,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    kernelFactory: AEVM_KERNEL_FACTORY, rootValidator: `0x01${AEVM_ECDSA_VALIDATOR.slice(2)}`,
    refused: { userOpHash: refused.userOpHash, txHash: refused.transactionHash, success: refused.success, amount: "250.00", reason: before.reason },
    paid: { userOpHash: paid.userOpHash, txHash: paid.transactionHash, success: paid.success, amount: "0.05" },
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
  console.log("wrote", OUT.pathname);
}

async function vaultLog({ txHash, vault, events }) {
  if (!txHash) return undefined;
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }) });
  const { result } = await r.json();
  const wanted = new Map([[PAYMENT_REFUSED, "PaymentRefused"], [PAYMENT_EXECUTED, "PaymentExecuted"]]);
  const log = (result?.logs ?? []).find((l) => l.address.toLowerCase() === vault.toLowerCase() && wanted.has(l.topics[0]) && events.includes(wanted.get(l.topics[0])));
  return log ? { event: wanted.get(log.topics[0]), topics: log.topics, data: log.data } : undefined;
}

async function findMandateFor({ vault, agent, count }) {
  for (let i = 1; i <= count; i++) {
    const m = await publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "getMandate", args: [BigInt(i)] });
    if (m.params.agent.toLowerCase() === agent.toLowerCase() && !m.revoked) return i;
  }
  return undefined;
}

async function readCheck(intent, owner, account) {
  // A free dry run through the vault's own `check`, with the same account signature the transaction will carry.
  const { agentSignature } = await buildPolicyCall({ owner, chainId: CHAIN_ID, account, vault: VAULT, intent });
  const code = await publicClient.readContract({ address: VAULT, abi: warrantVaultAbi, functionName: "check", args: [intent, agentSignature] });
  return toCheckResult(Number(code));
}

main().catch((e) => { console.error("FAILED:", e.shortMessage ?? e.message); process.exit(1); });
