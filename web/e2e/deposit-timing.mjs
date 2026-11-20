// Times a real gasless deposit on Aevum, stage by stage, against a running relayer.
//   OWNER_KEY_FILE=.demo/tester.key VAULT=0x… AMOUNT=0.01 RELAYER_URL=http://localhost:8787 node web/e2e/deposit-timing.mjs
// Without VAULT it creates a vault first (the owner pays that gas). The key is read from a file and never printed.
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { createVault, getVaultsOf, parseUsd, formatUsd, getTokenBalance, relayDeposit, signReceiveWithAuthorization, RPC_HTTP, randomBytes32 } from "@warrant/sdk";

const RPC = process.env.RPC_URL ?? "https://rpc-test.qday.info";
const RELAYER = process.env.RELAYER_URL ?? "http://localhost:8787";
const TOKEN = "0x456569838f1d43009A91ebA4263147Afd7233483";
const dep = JSON.parse(readFileSync(new URL("../../deployments/aevum.json", import.meta.url), "utf8"));
const FACTORY = dep.WarrantFactory.address;
const key = readFileSync(process.env.OWNER_KEY_FILE ?? ".demo/tester.key", "utf8").match(/0x[0-9a-fA-F]{64}/)[0];
const account = privateKeyToAccount(key);
const chain = { id: 44005, name: "aevum", nativeCurrency: { name: "QDay", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC, RPC_HTTP) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC, RPC_HTTP) });
const t0 = Date.now();
const at = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${s}`);

let vault = process.env.VAULT;
if (!vault) {
  const existing = await getVaultsOf(publicClient, FACTORY, account.address).catch(() => []);
  vault = existing[0];
  if (!vault) {
    at("creating a vault");
    vault = (await createVault({ clients: { publicClient, walletClient }, factory: FACTORY, salt: randomBytes32() })).vault;
    at(`vault ${vault}`);
  }
}
const amount = parseUsd(process.env.AMOUNT ?? "0.01");
const before = await getTokenBalance(publicClient, TOKEN, vault);
at(`vault holds ${formatUsd(before)}; signing a deposit of ${formatUsd(amount)}`);
const tSign = Date.now();
const auth = await signReceiveWithAuthorization({ signer: walletClient, chainId: 44005, token: TOKEN, from: account.address, to: vault, value: amount, validBefore: BigInt(Math.floor(Date.now() / 1000) + 900) });
at(`signed (${Date.now() - tSign} ms)`);
const tPost = Date.now();
const res = await relayDeposit({ relayerUrl: RELAYER, vault, from: account.address, amount, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce, signature: auth.signature });
at(`relayer answered after ${((Date.now() - tPost) / 1000).toFixed(1)} s: ${res.status} ${res.txHash ?? res.error ?? ""}`);
if (res.txHash) {
  const tRead = Date.now();
  for (;;) {
    const now = await getTokenBalance(publicClient, TOKEN, vault);
    if (now >= before + amount) { at(`balance reads ${formatUsd(now)} (${((Date.now() - tRead) / 1000).toFixed(1)} s after the relayer answered)`); break; }
    if (Date.now() - tRead > 120000) { at("balance still old after 120 s"); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
}
at("total from signature request to the balance changing: " + ((Date.now() - tSign) / 1000).toFixed(1) + " s");
