// Wallet edge cases against the running dashboard. Sends no transaction and spends nothing.
//   WEB_URL=http://localhost:3000 node web/e2e/wallet-states.mjs
// 1. wallet on the wrong network -> banner; declining the switch is reported as declined; accepting the switch (with the
//    4902 "unknown chain" path first) adds the chain with the right parameters and the banner goes away.
// 2. wallet on Aevum, owner rejects the transaction -> a plain message and no pending state left behind.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const OUT = process.env.SHOTS ?? "/tmp/warrant-wallet-states";
const ACCOUNT = "0x9deF7070074E11a319f4b5D80902eF04b7BeE0EC"; // the tester address; nothing is signed with it
mkdirSync(OUT, { recursive: true });
const failures = [];
const expect = (ok, what) => (console.log(ok ? "  ok  " : "  FAIL", what), ok || failures.push(what));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });

async function open(mode) {
  const page = await (await browser.createBrowserContext()).newPage(); // fresh storage: wagmi would otherwise reconnect from the last test
  await page.setViewport({ width: 1360, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.evaluateOnNewDocument((account, mode) => {
    const listeners = {};
    let chain = mode.startsWith("wrong") ? "0x1" : "0xabe5";
    window.__calls = [];
    window.ethereum = {
      isMock: true,
      on: (e, f) => ((listeners[e] ??= []).push(f)),
      removeListener: (e, f) => (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
      async request({ method, params }) {
        window.__calls.push({ method, params });
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "eth_chainId") return chain;
        if (method === "net_version") return String(parseInt(chain, 16));
        if (method === "wallet_switchEthereumChain") {
          if (mode === "wrong-decline") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          if (mode === "wrong-unknown" && !window.__added) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          chain = params[0].chainId;
          (listeners.chainChanged ?? []).forEach((f) => f(chain));
          return null;
        }
        if (method === "wallet_addEthereumChain") {
          window.__added = params[0];
          chain = params[0].chainId;
          (listeners.chainChanged ?? []).forEach((f) => f(chain));
          return null;
        }
        if (method === "eth_sendTransaction" || method === "eth_signTypedData_v4") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        const r = await (await fetch("https://rpc-test.qday.info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? [] }) })).json();
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      },
    };
  }, ACCOUNT, mode);
  await page.goto(WEB, { waitUntil: "load" });
  return { page, errors };
}
const text = (page) => page.evaluate(() => document.body.innerText);
const clickText = async (page, sel, t) => {
  await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some((el) => el.textContent.trim().startsWith(t) && !el.disabled), { timeout: 20000 }, sel, t);
  await page.evaluate((s, t) => [...document.querySelectorAll(s)].find((el) => el.textContent.trim().startsWith(t) && !el.disabled).click(), sel, t);
};

console.log("wrong network, owner declines the switch");
{
  const { page, errors } = await open("wrong-decline");
  await clickText(page, "button", "Connect wallet");
  await page.waitForFunction(() => document.body.innerText.includes("different network"), { timeout: 20000 });
  expect(true, "banner shown on chain 0x1");
  await page.screenshot({ path: `${OUT}/wrong-network.png` });
  await clickText(page, "button", "Switch network");
  await page.waitForFunction(() => document.body.innerText.includes("declined the network switch"), { timeout: 10000 }).catch(() => {});
  const t = await text(page);
  expect(t.includes("You declined the network switch in your wallet."), "decline is reported as declined, not as an error");
  expect(t.includes("different network"), "banner stays, nothing was forced");
  await page.screenshot({ path: `${OUT}/switch-declined.png` });
  expect(errors.length === 0, `no page errors ${errors.join("|")}`);
  await page.close();
}

console.log("wrong network, chain unknown to the wallet (4902), owner accepts");
{
  const { page, errors } = await open("wrong-unknown");
  await clickText(page, "button", "Connect wallet");
  await page.waitForFunction(() => document.body.innerText.includes("different network"), { timeout: 20000 });
  await clickText(page, "button", "Switch network");
  await page.waitForFunction(() => !document.body.innerText.includes("different network"), { timeout: 15000 }).catch(() => {});
  const added = await page.evaluate(() => window.__added);
  expect(added?.chainId === "0xabe5", "wallet_addEthereumChain called with chain id 44005 (0xabe5)");
  expect(added?.rpcUrls?.[0] === "https://rpc-test.qday.info" && added?.blockExplorerUrls?.[0] === "https://explorer-test.qday.info", "with the Aevum RPC and explorer");
  expect(added?.nativeCurrency?.symbol === "tQDAY" && added?.nativeCurrency?.decimals === 18, "native currency tQDAY, 18 decimals");
  expect(!(await text(page)).includes("different network"), "banner disappears after the switch");
  await page.screenshot({ path: `${OUT}/switched.png` });
  expect(errors.length === 0, `no page errors ${errors.join("|")}`);
  await page.close();
}

console.log("right network, owner rejects the transaction");
{
  const { page, errors } = await open("rejects");
  await clickText(page, "button", "Connect wallet");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Create vault"), { timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Create vault" && !b.disabled), { timeout: 30000 });
  await clickText(page, "button", "Create vault");
  await page.waitForFunction(() => document.body.innerText.includes("You rejected the request in your wallet"), { timeout: 15000 }).catch(() => {});
  const t = await text(page);
  expect(t.includes("You rejected the request in your wallet. Nothing was sent."), "rejection is explained in plain words");
  expect(!t.includes("Confirm in your wallet, then wait"), "no spinner left running");
  const sent = await page.evaluate(() => window.__calls.filter((c) => c.method === "eth_sendRawTransaction").length);
  expect(sent === 0, "nothing reached the chain");
  await page.screenshot({ path: `${OUT}/rejected.png` });
  expect(errors.length === 0, `no page errors ${errors.join("|")}`);
  await page.close();
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nwallet states: all passed");
