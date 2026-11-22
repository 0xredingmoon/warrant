#!/usr/bin/env node
// Records the "Try the attack" demonstration vault into deployments/demo-attack.json.
// Reads the vault address from the factory itself (predictVault with the salt the deploy script uses), then reads
// the mandate and the balance from the chain. Never touches or prints the demo key: only public addresses go here.
//
// usage: node scripts/record-demo-attack.mjs <owner> <agent> <merchant> [mandateId]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// same resolution as record-deployment.mjs: the repo root has no viem of its own, the workspace package does
const viem = await import(pathToFileURL(createRequire(import.meta.url).resolve("viem", { paths: ["packages/sdk"] })).href);
const { createPublicClient, getAddress, http, keccak256, parseAbi, toBytes } = viem;

const [ownerArg, agentArg, merchantArg, mandateArg] = process.argv.slice(2);
if (!ownerArg || !agentArg || !merchantArg) {
  throw new Error("usage: record-demo-attack.mjs <owner> <agent> <merchant> [mandateId]");
}
const owner = getAddress(ownerArg);
const agent = getAddress(agentArg);
const merchant = getAddress(merchantArg);

const RPC = process.env.AEVUM_RPC_URL ?? "https://rpc-test.qday.info";
const EXPLORER = process.env.EXPLORER_URL ?? "https://explorer-test.qday.info";
const SALT = keccak256(toBytes("warrant-demo-attack"));

// DEPLOYMENT_FILE lets the same recorder run against a fork deployment (deployments/fork.json) before testnet
const aevumPath = new URL(`../deployments/${process.env.DEPLOYMENT_FILE ?? "aevum.json"}`, import.meta.url);
const aevum = JSON.parse(readFileSync(aevumPath, "utf8"));
const factory = getAddress(aevum.WarrantFactory.address);
const token = getAddress(aevum.tUSD8);

const client = createPublicClient({ transport: http(RPC), chain: { id: 44005, name: "aevum", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } });

const factoryAbi = parseAbi(["function predictVault(address owner, address guardian, bytes32 salt) view returns (address)"]);
const vaultAbi = parseAbi([
  "function mandateCount() view returns (uint256)",
  "function balance() view returns (uint256)",
  "function getMandate(uint256 mandateId) view returns ((address agent, uint256 agentId, uint128 perTxCap, uint128 periodCap, uint128 totalCap, uint32 periodLength, uint48 validAfter, uint48 expiry, uint128 approvalThreshold, uint32 approvalWindow, bool revoked))",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const vault = await client.readContract({ address: factory, abi: factoryAbi, functionName: "predictVault", args: [owner, "0x0000000000000000000000000000000000000000", SALT] });
const code = await client.getBytecode({ address: vault });
if (!code || code === "0x") {
  throw new Error(`no vault at ${vault}: run script/DemoAttackVault.s.sol first (with the same owner)`);
}

const mandateCount = await client.readContract({ address: vault, abi: vaultAbi, functionName: "mandateCount" });
const mandateId = mandateArg ? BigInt(mandateArg) : mandateCount;
const mandate = await client.readContract({ address: vault, abi: vaultAbi, functionName: "getMandate", args: [mandateId] });
const balance = await client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [vault] });

const usd = (v) => (Number(v) / 1e6).toFixed(2);
const out = {
  network: "aevum",
  chainId: 44005,
  purpose: "dashboard \"Try the attack\" demo: a narrowly mandated vault the relayer holds the agent key for",
  factory,
  tUSD8: token,
  vault,
  vaultUrl: `${EXPLORER}/address/${vault}?tab=contract`,
  owner,
  agent,
  allowedMerchant: merchant,
  mandateId: mandateId.toString(),
  mandate: {
    perTxCap: usd(mandate.perTxCap),
    periodCap: usd(mandate.periodCap),
    totalCap: usd(mandate.totalCap),
    approvalThreshold: usd(mandate.approvalThreshold),
    validAfter: Number(mandate.validAfter),
    expiry: Number(mandate.expiry),
    revoked: mandate.revoked,
  },
  vaultBalance: usd(balance),
  recordedAt: new Date().toISOString(),
};

mkdirSync(new URL("../deployments", import.meta.url), { recursive: true });
const outPath = new URL("../deployments/demo-attack.json", import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
if (existsSync(new URL("../web/public/config.js", import.meta.url))) {
  console.log("\nrun the gh-pages deploy step after this so the dashboard picks the demo up (it reads the relayer)");
}
