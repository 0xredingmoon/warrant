#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPublicClient, createWalletClient, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RPC_HTTP, WarrantAgent } from "@warrant/sdk";
import { createWarrantMcpServer } from "./index";

/*
 * Env:
 *   WARRANT_VAULT          vault address (required)
 *   WARRANT_MANDATE_ID     mandate id (required)
 *   AGENT_PRIVATE_KEY      the mandate's agent key (required, signs intents only, needs no gas)
 *   RELAYER_URL            relayer that pays gas (recommended). Without it the agent key must hold tQDAY.
 *   RELAYER_API_KEY        optional bearer token for the relayer
 *   RPC_URL, CHAIN_ID      default https://rpc-test.qday.info / 44005
 */
const need = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`warrant-mcp: missing env var ${k}`);
    process.exit(1);
  }
  return v;
};

const rpc = process.env.RPC_URL ?? "https://rpc-test.qday.info";
const chainId = Number(process.env.CHAIN_ID ?? 44005);
const chain: Chain = {
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
};
const account = privateKeyToAccount(need("AGENT_PRIVATE_KEY") as Hex);
const publicClient = createPublicClient({ chain, transport: http(rpc, RPC_HTTP) });
const relayerUrl = process.env.RELAYER_URL || undefined;
const agent = new WarrantAgent({
  signer: account,
  publicClient,
  chainId,
  vault: need("WARRANT_VAULT") as Address,
  mandateId: BigInt(need("WARRANT_MANDATE_ID")),
  relayerUrl,
  relayerApiKey: process.env.RELAYER_API_KEY || undefined,
  clients: relayerUrl ? undefined : { publicClient, walletClient: createWalletClient({ account, chain, transport: http(rpc, RPC_HTTP) }) },
  explorerUrl: process.env.EXPLORER_URL,
});

const server = createWarrantMcpServer(agent);
await server.connect(new StdioServerTransport());
// stdout is the protocol channel: log to stderr only
console.error(`warrant-mcp ready: agent ${account.address}, vault ${agent.cfg.vault}, mandate #${agent.cfg.mandateId}`);
