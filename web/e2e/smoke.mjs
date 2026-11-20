// UI smoke test against a local anvil fork. A mock injected wallet forwards to anvil's unlocked dev account.
// Prereqs: pnpm fork; bash scripts/deploy-fork.sh; relayer running; web dev server running with fork env (see e2e/README).
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WarrantAgent, formatUsd } from "@warrant/sdk";

const WEB = process.env.WEB_URL ?? "http://localhost:3100";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:8787";
const OUT = process.env.SHOTS ?? "/tmp/warrant-shots";
const ACCOUNT = process.env.ACCOUNT ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil dev account 1 (fork only; unlocked in anvil)
const TOKEN = "0x456569838f1d43009A91ebA4263147Afd7233483";
mkdirSync(OUT, { recursive: true });

const rpc = async (method, params = []) => {
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const log = (...a) => console.log("  ", ...a);
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

// the run is rolled back at the end, so it can be repeated
const snapshot = await rpc("evm_snapshot");
// 20 tUSD8 for the wallet (balance mapping is slot 11)
const { keccak256, encodeAbiParameters } = await import("viem");
await rpc("anvil_setStorageAt", [TOKEN, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ACCOUNT, 11n])), "0x" + (20_000_000n).toString(16).padStart(64, "0")]);

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 900 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.evaluateOnNewDocument((account, rpcUrl) => {
  const listeners = {};
  window.ethereum = {
    isMock: true,
    on: (e, f) => ((listeners[e] ??= []).push(f)),
    removeListener: (e, f) => (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0xabe5";
      if (method === "wallet_switchEthereumChain") return null;
      const r = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? [] }) })).json();
      if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
      return r.result;
    },
  };
}, ACCOUNT, RPC);

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const clickText = async (sel, text, opts = {}) => {
  await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some((el) => el.textContent.trim().startsWith(t) && !el.disabled), { timeout: opts.timeout ?? 20000 }, sel, text);
  await page.evaluate((s, t) => [...document.querySelectorAll(s)].find((el) => el.textContent.trim().startsWith(t) && !el.disabled).click(), sel, text);
};
const waitText = (text, timeout = 45000) => page.waitForFunction((t) => document.body.textContent.includes(t), { timeout }, text);
const step = (s) => console.log(`\n${s}`);

try {
  step("landing");
  await page.goto(WEB, { waitUntil: "networkidle2" });
  await waitText("spending mandate");
  await shot("01-landing");
  await page.setViewport({ width: 390, height: 844 });
  await shot("01b-landing-mobile");
  await page.setViewport({ width: 1360, height: 900 });

  step("connect");
  await clickText("button", "Connect wallet");
  await waitText("Create your vault");
  await shot("02-create-vault");

  step("create vault");
  await clickText("button", "Create vault");
  await waitText("Vault created", 60000);
  const vault = await page.evaluate(() => document.querySelector(".head a.mono")?.textContent);
  log("vault", vault);
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault ?? "")) fail("vault address not shown");
  await shot("03-empty-vault");

  step("deposit 5.00 via relayer (EIP-3009)");
  await clickText("button", "Deposit");
  await page.type('input[inputmode="decimal"]', "5");
  await clickText("button", "Deposit");
  await page.waitForFunction(() => document.querySelector(".balance .amt")?.textContent?.startsWith("5.00"), { timeout: 60000 });
  log("balance shows 5.00");

  step("new mandate with a generated agent key");
  await clickText("button", "New mandate");
  await waitText("Start from a template");
  await shot("04-new-mandate-sheet");
  await clickText("button", "Generate a new agent key");
  await clickText("button", "Reveal");
  const key = await page.evaluate(() => document.querySelector(".key-box code")?.textContent);
  if (!/^0x[0-9a-f]{64}$/.test(key ?? "")) throw new Error("agent key not shown");
  const merchant = getAddress("0x" + "ab".repeat(20));
  await page.type("textarea", merchant);
  await shot("05-new-mandate-filled");
  await clickText("button", "Issue mandate");
  await waitText("Mandate #1", 90000);
  await page.waitForFunction(() => !document.querySelector(".sheet"), { timeout: 10000 });
  await shot("06-mandate-active");

  step("agent pays through the relayer, UI sees it");
  const publicClient = createPublicClient({ transport: http(RPC) });
  const agent = new WarrantAgent({ signer: privateKeyToAccount(key), publicClient, chainId: 44005, vault, mandateId: 1n, relayerUrl: RELAYER });
  const p1 = await agent.pay({ merchant, amount: "0.40", context: "smoke: small purchase" });
  if (p1.status !== "executed") throw new Error(`expected executed, got ${p1.status}: ${p1.message}`);
  const p2 = await agent.pay({ merchant, amount: "3.50", context: "smoke: above threshold" });
  if (p2.status !== "queued") throw new Error(`expected queued, got ${p2.status}: ${p2.message}`);
  const evil = await agent.pay({ merchant: "0x" + "ee".repeat(20), amount: "0.10" });
  if (evil.status !== "rejected") throw new Error("unlisted merchant was not rejected");
  log("executed, queued, rejected:", evil.check.message);
  await waitText("3.50", 30000);
  await waitText("Decide in", 30000);
  await waitText("Paid 0.40 tUSD8", 30000);
  await shot("07-pending-and-activity");

  step("approve the queued payment from the UI (signature, relayed)");
  await clickText("button", "Approve");
  await page.waitForFunction(() => !document.body.textContent.includes("Decide in"), { timeout: 60000 });
  await waitText("approved by", 30000);
  log("balance now", await page.evaluate(() => document.querySelector(".balance .amt")?.textContent));
  await shot("08-approved");

  step("registered agent shows reputation");
  await waitText("Agent #", 30000);
  await waitText("verified payments");

  step("freeze, unfreeze");
  await clickText("button", "Freeze all payments");
  await clickText("button", "Freeze");
  await waitText("Frozen", 45000);
  const blocked = await agent.pay({ merchant, amount: "0.10" });
  if (blocked.status !== "rejected") throw new Error("payment went through a frozen vault");
  log("frozen vault refused:", blocked.check.message);
  await shot("09-frozen");
  await clickText("button", "Unfreeze vault");
  await page.waitForFunction(() => !document.body.textContent.includes("Every payment is refused"), { timeout: 45000 });

  step("revoke");
  await clickText("button", "Revoke mandate");
  await clickText("button", "Revoke now");
  await waitText("Revoked", 45000);
  const after = await agent.pay({ merchant, amount: "0.10" });
  if (after.status !== "rejected") throw new Error("payment went through a revoked mandate");
  log("revoked mandate refused:", after.check.message);
  await shot("10-revoked");

  step("withdraw");
  await clickText("button", "Withdraw");
  await clickText("button", "Use the full");
  await clickText("button", "Withdraw");
  await page.waitForFunction(() => document.querySelector(".balance .amt")?.textContent?.startsWith("0.00"), { timeout: 60000 });
  await shot("11-final");

  step("mobile layout");
  await page.setViewport({ width: 390, height: 844 });
  await shot("12-dashboard-mobile");
} catch (e) {
  fail(e.message);
  await shot("zz-failure").catch(() => {});
}
const real = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
if (real.length) { console.log("\nbrowser errors:"); real.slice(0, 8).forEach((e) => console.log("  -", e.slice(0, 300))); }
await browser.close();
await rpc("evm_revert", [snapshot]);
console.log(process.exitCode ? "\nSMOKE FAILED" : `\nSMOKE OK (screenshots in ${OUT})`);
