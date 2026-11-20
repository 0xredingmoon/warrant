// Wallet edge cases against the running dashboard. Sends no transaction and spends nothing.
//   WEB_URL=http://localhost:3000 node web/e2e/wallet-states.mjs
// 1. wallet on the wrong network -> banner; declining the switch is reported as declined; accepting the switch (with the
//    4902 "unknown chain" path first) adds the chain with the right parameters and the banner goes away.
// 2. wallet on Aevum, owner rejects the transaction -> a neutral toast (not a red error) that dismisses itself.
// 3. the wallet changes network while the page is open -> header, banner and the Create vault button follow at once.
// 4. the wallet no longer authorizes the account (after a reload, or mid-session) -> reconnect prompt, plain wording.
// 5. connecting: the page content stays visible with a waiting state while the wallet prompt is open.
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
  const page = await (await browser.createBrowserContext()).newPage(); // fresh storage so no test inherits the last one's "connected" flag
  await page.setViewport({ width: 1360, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.evaluateOnNewDocument((account, mode) => {
    const listeners = {};
    const emit = (e, v) => (listeners[e] ?? []).forEach((f) => f(v));
    let chain = mode.startsWith("wrong") ? "0x1" : "0xabe5";
    let held;
    const denied = () => sessionStorage.getItem("deny") === "1";
    window.__calls = [];
    // test controls: what the wallet UI does on its own
    window.__wallet = {
      setChain: (c) => { chain = c; emit("chainChanged", c); },
      revoke: () => sessionStorage.setItem("deny", "1"), // site permission removed in the wallet, no event sent
      release: () => held?.(),
    };
    window.ethereum = {
      isMock: true,
      on: (e, f) => ((listeners[e] ??= []).push(f)),
      removeListener: (e, f) => (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
      async request({ method, params }) {
        window.__calls.push({ method, params });
        if (method === "eth_accounts") return denied() || sessionStorage.getItem("granted") !== "1" ? [] : [account]; // like MetaMask: nothing until the site is permitted
        if (method === "eth_requestAccounts") {
          if (mode === "hold") await new Promise((r) => (held = r));
          sessionStorage.removeItem("deny");
          sessionStorage.setItem("granted", "1");
          return [account];
        }
        if (method === "eth_chainId") return chain;
        if (method === "net_version") return String(parseInt(chain, 16));
        if (method === "wallet_switchEthereumChain") {
          if (mode === "wrong-decline") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          if (mode === "wrong-unknown" && !window.__added) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          chain = params[0].chainId;
          emit("chainChanged", chain);
          return null;
        }
        if (method === "wallet_addEthereumChain") {
          window.__added = params[0];
          chain = params[0].chainId;
          emit("chainChanged", chain);
          return null;
        }
        if (method === "eth_sendTransaction" || method === "eth_signTypedData_v4") {
          if (denied()) throw Object.assign(new Error("The requested method and/or account has not been authorized by the user."), { code: 4100 });
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        }
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
  expect(await page.evaluate(() => !!document.querySelector(".toast-neutral") && !document.querySelector(".toast-error")), "a rejection is a neutral toast, not a red error");
  await page.waitForFunction(() => !document.querySelector(".toast"), { timeout: 12000 }).then(() => expect(true, "and it dismisses itself"), () => expect(false, "and it dismisses itself"));
  const sent = await page.evaluate(() => window.__calls.filter((c) => c.method === "eth_sendRawTransaction").length);
  expect(sent === 0, "nothing reached the chain");
  await page.screenshot({ path: `${OUT}/rejected.png` });
  expect(errors.length === 0, `no page errors ${errors.join("|")}`);
  await page.close();
}

const enabled = (page, label) => page.evaluate((l) => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === l && !b.disabled), label);
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);

console.log("network changes while the page is open");
{
  const { page, errors } = await open("wrong-live");
  await clickText(page, "button", "Connect wallet");
  await waitFor(page, () => document.body.innerText.includes("Wallet is on Ethereum, not Aevum"), null, 20000);
  // the vault list is read from Aevum whatever the wallet says; wait until the Create vault screen is up
  await waitFor(page, () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Create vault"), null, 90000);
  let t = await text(page);
  expect(t.includes("Wallet is on Ethereum, not Aevum"), "header names the wallet's actual network");
  expect(await page.evaluate(() => !!document.querySelector(".dot.off")), "and its dot is red, not green");
  expect(!/\d\.\d{4} tQDAY/.test(t), "no tQDAY balance is shown while the wallet is elsewhere");
  expect(!(await page.evaluate(() => document.querySelector("header").innerText)).includes("44005"), "the header does not claim chain 44005");
  expect(!(await enabled(page, "Create vault")), "Create vault is disabled on the wrong network");
  expect(t.includes("Switch your wallet to Aevum first."), "and says why");
  await page.screenshot({ path: `${OUT}/header-wrong-network.png` });
  await page.evaluate(() => window.__wallet.setChain("0x38"));
  expect(await waitFor(page, () => document.body.innerText.includes("Wallet is on BNB Chain, not Aevum")), "another chain switch is reflected");
  await page.evaluate(() => window.__wallet.setChain("0x7a69"));
  expect(await waitFor(page, () => document.body.innerText.includes("Wallet is on chain 31337, not Aevum")), "an unnamed chain shows its number");
  // the owner adds / switches to Aevum in the wallet's own UI: no reload, no click in the page
  await page.evaluate(() => window.__wallet.setChain("0xabe5"));
  expect(await waitFor(page, () => document.body.innerText.includes("Connected to Aevum") && ![...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Create vault")?.disabled), "switching to Aevum enables Create vault without a reload");
  t = await text(page);
  expect(!t.includes("different network"), "banner gone");
  await waitFor(page, () => document.body.innerText.includes("Creating one costs about"), null, 30000);
  t = await text(page);
  const gasLine = t.replace(/\n/g, " ").match(/Creating one costs.*?you pay only what is used\./)?.[0];
  console.log("     gas line:", gasLine);
  expect(/about 0\.00\d+ tQDAY in gas\. Your wallet may show up to 0\.0054/.test(gasLine ?? ""), "gas copy is the live estimate plus the wallet's upper limit (0.0054), not the old 0.004");
  await page.screenshot({ path: `${OUT}/header-aevum.png` });
  await page.evaluate(() => window.__wallet.setChain("0x1"));
  expect(await waitFor(page, () => document.body.innerText.includes("different network")), "and moving away again disables it again");
  expect(errors.length === 0, `no page errors ${errors.join("|")}`);
  await page.close();
}

console.log("account no longer authorized");
{
  const { page, errors } = await open("rights");
  await clickText(page, "button", "Connect wallet");
  await waitFor(page, () => /create your vault/i.test(document.body.innerText), null, 90000);
  await page.evaluate(() => window.__wallet.revoke());
  await page.reload({ waitUntil: "load" });
  expect(await waitFor(page, () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Reconnect wallet"), null, 15000), "after a reload with no access: a Reconnect wallet button");
  let t = await text(page);
  expect(t.includes("no longer shares an account with this page"), "with a plain explanation");
  expect(!/create your vault/i.test(t) && !t.includes("Disconnect"), "not a half-connected dashboard");
  await page.screenshot({ path: `${OUT}/reconnect.png` });
  await clickText(page, "button", "Reconnect wallet");
  expect(await waitFor(page, () => /create your vault/i.test(document.body.innerText), null, 90000), "reconnecting restores the dashboard");

  // access removed while the page is open: the transaction call fails with 4100
  await waitFor(page, () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Create vault" && !b.disabled), null, 90000);
  await page.evaluate(() => window.__wallet.revoke());
  await clickText(page, "button", "Create vault");
  expect(await waitFor(page, () => document.body.innerText.includes("has not given this page access"), null, 15000), "error 4100 is translated");
  t = await text(page);
  expect(!t.includes("requested method and/or account has not been authorized"), "the raw wallet message is not shown");
  expect(await waitFor(page, () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Reconnect wallet")), "and the page offers to reconnect");
  await page.screenshot({ path: `${OUT}/unauthorized.png` });
  expect(errors.length === 0, `no page errors ${errors.join("|")}`);
  await page.close();
}

console.log("connect prompt open");
{
  const { page, errors } = await open("hold");
  await clickText(page, "button", "Connect wallet");
  await page.waitForFunction(() => document.body.innerText.includes("Waiting for your wallet"), { timeout: 5000 });
  const t = await text(page);
  expect(t.includes("Give an AI agent a spending mandate"), "page content stays visible, not a blank skeleton");
  expect(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("Waiting for your wallet") && b.disabled)), "the button says what is happening and cannot be pressed twice");
  await page.screenshot({ path: `${OUT}/waiting.png` });
  await page.evaluate(() => window.__wallet.release());
  expect(await waitFor(page, () => /create your vault/i.test(document.body.innerText), null, 90000), "approving shows the dashboard");
  expect(errors.length === 0, `no page errors ${errors.join("|")}`);
  await page.close();
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nwallet states: all passed");
