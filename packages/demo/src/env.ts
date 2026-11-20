import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

export type Network = "fork" | "aevum";
export const network: Network = (process.env.WARRANT_NETWORK as Network) ?? "fork";
if (network !== "fork" && network !== "aevum") throw new Error(`WARRANT_NETWORK must be fork or aevum, got ${network}`);

export const rpcUrl = process.env.RPC_URL ?? (network === "fork" ? "http://127.0.0.1:8545" : "https://rpc-test.qday.info");
export const chainId = 44005;
export const explorer = process.env.EXPLORER_URL ?? "https://explorer-test.qday.info";

export const chain: Chain = {
  id: chainId,
  name: "Aevum testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: explorer } },
};

export const publicClient: PublicClient = createPublicClient({ chain, transport: http(rpcUrl) });
export const walletFor = (account: PrivateKeyAccount): WalletClient => createWalletClient({ account, chain, transport: http(rpcUrl) });

export interface Deployments {
  tUSD8: Address;
  deployBlock: number;
  AgentRegistry: { address: Address };
  WarrantFactory: { address: Address };
}

export function loadDeployments(): Deployments {
  const file = resolve(ROOT, "deployments", `${network}.json`);
  if (!existsSync(file)) {
    throw new Error(
      network === "fork"
        ? "deployments/fork.json missing. Start the fork (pnpm fork) and run bash scripts/deploy-fork.sh"
        : "deployments/aevum.json missing. Run make deploy-aevum and node scripts/record-deployment.mjs aevum 44005",
    );
  }
  const d = JSON.parse(readFileSync(file, "utf8"));
  return {
    tUSD8: getAddress(d.tUSD8),
    deployBlock: d.deployBlock,
    AgentRegistry: { address: getAddress(d.AgentRegistry.address) },
    WarrantFactory: { address: getAddress(d.WarrantFactory.address) },
  };
}

/** Throwaway demo identities (agent, merchants, relayer), kept in .demo/ (gitignored) so reruns reuse them. */
export function demoKeys() {
  const file = resolve(ROOT, ".demo", `keys-${network}.json`);
  let k: Record<string, Hex> = {};
  if (existsSync(file)) k = JSON.parse(readFileSync(file, "utf8"));
  let changed = false;
  for (const name of ["agent", "merchantA", "merchantB", "relayer", "evil", "owner"]) {
    if (!k[name]) {
      k[name] = generatePrivateKey();
      changed = true;
    }
  }
  if (changed) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(k, null, 2), { mode: 0o600 });
  }
  return {
    agent: privateKeyToAccount(k.agent!),
    merchantA: privateKeyToAccount(k.merchantA!),
    merchantB: privateKeyToAccount(k.merchantB!),
    relayer: privateKeyToAccount(k.relayer!),
    /** attacker: we only ever use its address */
    evil: privateKeyToAccount(k.evil!),
    /** fork only: a random funded owner. On Aevum the owner is the funded deployer key from .env */
    forkOwner: privateKeyToAccount(k.owner!),
    relayerKey: k.relayer! as Hex,
  };
}
