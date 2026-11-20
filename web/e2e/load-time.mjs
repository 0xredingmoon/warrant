// How long until a vault is on screen after a cold load (empty cache) and after a reload (cached paint, then fresh).
// Read-only: the mock wallet only reports an address, it signs nothing.
//   OWNER=0x… WEB_URL=http://localhost:3000 node web/e2e/load-time.mjs
import puppeteer from "puppeteer-core";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const OWNER = process.env.OWNER ?? "0x596f8B0FF75a5786DCF6A60Baa76a87923A4c8e9";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await (await browser.createBrowserContext()).newPage();
await page.setViewport({ width: 1360, height: 900 });
await page.evaluateOnNewDocument((account) => {
  window.ethereum = {
    on() {}, removeListener() {},
    async request({ method }) {
      if (method === "eth_requestAccounts") { sessionStorage.setItem("granted", "1"); return [account]; }
      if (method === "eth_accounts") return sessionStorage.getItem("granted") === "1" ? [account] : [];
      if (method === "eth_chainId") return "0xabe5";
      throw new Error("read-only mock");
    },
  };
}, OWNER);
const until = (fn) => page.waitForFunction(fn, { timeout: 90000 });
const show = (label, t0) => console.log(`${String(Date.now() - t0).padStart(6)} ms  ${label}`);
const rpcCalls = [];
page.on("request", (r) => { if (r.url().includes("rpc-test") || r.url().includes("8545")) rpcCalls.push(r.postData()?.slice(0, 60)); });

await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Connect wallet"));
let t0 = Date.now();
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Connect wallet").click());
console.log("cold (no cache):");
await until(() => document.querySelector(".head h1"));
show("vault header", t0);
await until(() => document.querySelector(".mandate") && document.querySelector(".balance .amt"));
show("mandates and balance", t0);
await until(() => !document.querySelector(".skel"));
show("no skeleton left", t0);
console.log("   rpc requests:", rpcCalls.length);
rpcCalls.length = 0;

console.log("reload (cache):");
t0 = Date.now();
await page.reload({ waitUntil: "domcontentloaded" });
await until(() => document.querySelector(".head h1"));
show("vault header", t0);
await until(() => !document.querySelector(".skel"));
show("no skeleton left", t0);
await browser.close();
