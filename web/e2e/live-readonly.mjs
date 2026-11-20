// Read-only check of the production build against the real Aevum testnet: shows a vault's state and chunked audit log.
// usage: OWNER=0x… VAULT_OWNER view; the mock wallet only reports an address, it cannot sign.
import puppeteer from "puppeteer-core";
const WEB = process.env.WEB_URL ?? "http://localhost:3200";
const OWNER = process.env.OWNER;
const OUT = process.env.SHOTS ?? "/tmp/warrant-shots";
if (!OWNER) throw new Error("set OWNER to the vault owner's address");
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.evaluateOnNewDocument((account) => {
  window.ethereum = {
    on() {}, removeListener() {},
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0xabe5";
      if (method === "wallet_switchEthereumChain") return null;
      const r = await (await fetch("https://rpc-test.qday.info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) })).json();
      if (r.error) throw new Error(r.error.message);
      return r.result;
    },
  };
}, OWNER);
await page.goto(WEB, { waitUntil: "networkidle2" });
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Connect wallet")).click());
await page.waitForFunction(() => document.body.textContent.includes("Mandate #1"), { timeout: 60000 });
await page.waitForFunction(() => document.body.textContent.includes("Vault created"), { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));
const text = await page.evaluate(() => document.body.innerText);
console.log(text.split("\n").filter((l) => /Revoked|Paid|Queued|Vault created|tUSD8|Agent #|verified/.test(l)).slice(0, 20).join("\n"));
await page.screenshot({ path: `${OUT}/live-dashboard.png` });
await browser.close();
if (errors.length) { console.log("errors:", errors.slice(0, 3)); process.exitCode = 1; }
