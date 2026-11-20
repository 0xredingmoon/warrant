/**
 * Prints the on-chain record of one vault as a markdown table (every vault event with its explorer link), for docs/live-run.md.
 *   WARRANT_NETWORK=aevum VAULT=0x… tsx src/video-log.ts
 */
import { getAddress } from "viem";
import { getAuditLog, getVaultCreatedBlock } from "@warrant/sdk";
import { explorer, loadDeployments, publicClient } from "./env";

const vault = getAddress(process.env.VAULT ?? "");
const dep = loadDeployments();
const from = await getVaultCreatedBlock(publicClient, vault).catch(() => BigInt(dep.deployBlock));
const entries = (await getAuditLog({ publicClient, vault, fromBlock: from ?? BigInt(dep.deployBlock) })).sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
const refused = entries.filter((e) => e.kind === "PaymentRefused").length;
console.log(`${entries.length} vault events, ${refused} of them refusals recorded on-chain.\n`);
console.log("| Block | What happened | Transaction |\n| --- | --- | --- |");
for (const [i, e] of entries.entries()) console.log(`| ${e.blockNumber} | ${(i === 0 && e.kind === "GuardianSet" ? "Vault created, no guardian" : e.summary).replace(/\|/g, "\\|")} | [${e.txHash}](${explorer}/tx/${e.txHash}) |`);
