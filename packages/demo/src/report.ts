import { readFileSync, writeFileSync } from "node:fs";

export interface RunReport {
  network: string;
  chainId: number;
  factory: string;
  registry: string;
  vault: string;
  agent: string;
  merchant: string;
  attacker: string;
  mandateId: string;
  finishedAt: string;
  rows: { step: string; outcome: "ok" | "done" | "blocked" | "queued" | "info"; text: string; txHash?: string; url?: string }[];
}

const LABEL = { ok: "Paid", done: "Done", blocked: "Refused", queued: "Queued", info: "Setup" } as const;

export function toMarkdown(r: RunReport): string {
  const net = r.network === "aevum" ? "Aevum testnet" : "local anvil fork of Aevum";
  const txs = r.rows.filter((x) => x.txHash).length;
  const refused = r.rows.filter((x) => x.outcome === "blocked").length;
  return [
    `# Demo run on ${net}`,
    "",
    `Recorded ${r.finishedAt}. ${txs} transactions, ${refused} payments refused by the vault before any transaction was sent.`,
    "",
    "| | |",
    "| --- | --- |",
    `| Chain | ${r.chainId} |`,
    `| WarrantFactory | \`${r.factory}\` |`,
    `| AgentRegistry | \`${r.registry}\` |`,
    `| Vault | \`${r.vault}\` |`,
    `| Agent key (signs only, holds no tQDAY) | \`${r.agent}\` |`,
    `| Merchant (Ledgerline Data) | \`${r.merchant}\` |`,
    `| Attacker address from the injected page | \`${r.attacker}\` |`,
    `| Mandate | #${r.mandateId} |`,
    "",
    "| Step | Result | What happened | Transaction |",
    "| --- | --- | --- | --- |",
    ...r.rows.map(
      (x) =>
        `| ${x.step} | ${LABEL[x.outcome]} | ${x.text.replaceAll("|", "\\|")} | ${x.txHash ? `[${x.txHash}](${x.url})` : "none: refused by the vault's dry run, nothing sent"} |`,
    ),
    "",
  ].join("\n");
}

// node --import tsx src/report.ts <run.json> <out.md>
if (process.argv[1]?.endsWith("report.ts")) {
  const [inp, out] = process.argv.slice(2);
  if (!inp || !out) throw new Error("usage: report.ts <run.json> <out.md>");
  writeFileSync(out, toMarkdown(JSON.parse(readFileSync(inp, "utf8"))));
}
