/**
 * Long-running demo services, for docker compose and hosting:
 *   - Ledgerline Data, a paid filings API (HTTP 402, native Warrant flow + x402 v1/v2), default :8788
 *   - an analyst-notes site carrying a prompt injection and an x402 offer that pays an attacker, default :8789
 * Payments are settled through the relayer's x402 facilitator endpoints (FACILITATOR_URL).
 */
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { createPublicClient, getAddress, http, type Address } from "viem";
import { createMerchant } from "@warrant/merchant";
import { startLedgerline, startNotesSite } from "./servers";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}`);
  return v;
};

const rpcUrl = process.env.RPC_URL ?? "https://rpc-test.qday.info";
const chainId = Number(process.env.CHAIN_ID ?? 44005);
const explorer = process.env.EXPLORER_URL ?? "https://explorer-test.qday.info";
const factory = getAddress(need("FACTORY_ADDRESS"));
const token = getAddress(process.env.TOKEN_ADDRESS ?? "0x456569838f1d43009A91ebA4263147Afd7233483");
const payTo = getAddress(need("MERCHANT_PAY_TO"));
const attacker = getAddress(process.env.ATTACKER_ADDRESS ?? "0x000000000000000000000000000000000000dEaD") as Address;
const facilitatorUrl = need("FACILITATOR_URL");
const host = process.env.HOST ?? "0.0.0.0";
const dbPath = process.env.DATABASE_PATH ?? "./data/ledgerline.db";
if (dbPath !== ":memory:") mkdirSync(resolve(dbPath, ".."), { recursive: true });

const publicClient = createPublicClient({ transport: http(rpcUrl) });
const merchant = createMerchant({ publicClient, chainId, factory, token, payTo, explorerUrl: explorer, name: "Ledgerline Data", dbPath });

const ledgerline = await startLedgerline(merchant, {
  facilitatorUrl,
  facilitatorApiKey: process.env.FACILITATOR_API_KEY || undefined,
  host,
  port: Number(process.env.PORT ?? 8788),
});
const notes = await startNotesSite(attacker, {
  token,
  chainId,
  host,
  port: Number(process.env.NOTES_PORT ?? 8789),
  publicUrl: process.env.NOTES_PUBLIC_URL || undefined,
});
console.log(`ledgerline  ${ledgerline.url}  pays ${payTo}  facilitator ${facilitatorUrl}`);
console.log(`notes site  ${notes.url}  (offers an x402 invoice that pays ${attacker})`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    ledgerline.server.close();
    notes.server.close();
    process.exit(0);
  });
