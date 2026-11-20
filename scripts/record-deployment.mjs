#!/usr/bin/env node
// Turns forge's broadcast file for script/Deploy.s.sol into deployments/<name>.json (addresses, tx hashes, blocks).
// usage: node scripts/record-deployment.mjs <name> <chainId> [explorer]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const [name, chainId = "44005", explorer = "https://explorer-test.qday.info"] = process.argv.slice(2);
if (!name) throw new Error("usage: record-deployment.mjs <name> <chainId> [explorer]");
const run = JSON.parse(readFileSync(`broadcast/Deploy.s.sol/${chainId}/run-latest.json`, "utf8"));
const creates = run.transactions.filter((t) => t.transactionType === "CREATE");
const find = (n) => creates.find((t) => t.contractName === n);
const rcpt = (hash) => run.receipts.find((r) => r.transactionHash === hash);
const entry = (n) => {
  const t = find(n);
  if (!t) throw new Error(`no ${n} in broadcast`);
  const r = rcpt(t.hash);
  return {
    address: t.contractAddress,
    txHash: t.hash,
    explorerTx: `${explorer}/tx/${t.hash}`,
    explorerAddress: `${explorer}/address/${t.contractAddress}`,
    blockNumber: Number(BigInt(r.blockNumber)),
  };
};
const registry = entry("AgentRegistry");
const factory = entry("WarrantFactory");
const wire = run.transactions.find((t) => t.transactionType === "CALL" && t.function?.startsWith("setFactory"));
const out = {
  network: name,
  chainId: Number(chainId),
  tUSD8: "0x456569838f1d43009A91ebA4263147Afd7233483",
  deployer: run.transactions[0].transaction.from,
  deployBlock: Math.min(registry.blockNumber, factory.blockNumber),
  AgentRegistry: registry,
  WarrantFactory: factory,
  setFactoryTx: wire ? { txHash: wire.hash, explorerTx: `${explorer}/tx/${wire.hash}` } : undefined,
  recordedAt: new Date().toISOString(),
};
mkdirSync("deployments", { recursive: true });
writeFileSync(`deployments/${name}.json`, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
