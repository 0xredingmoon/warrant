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
  const grant = () => sessionStorage.setItem("granted", "1"); // like MetaMask: no accounts until the site is permitted, and the permission survives a reload
  window.ethereum = {
    isMock: true,
    on: (e, f) => ((listeners[e] ??= []).push(f)),
    removeListener: (e, f) => (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
    async request({ method, params }) {
      if (method === "eth_requestAccounts") { grant(); return [account]; }
      if (method === "eth_accounts") return sessionStorage.getItem("granted") === "1" ? [account] : [];
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
const check = (ok, what) => { console.log(ok ? "   ok" : "   FAIL", what); if (!ok) fail(what); };
const bodyText = () => page.evaluate(() => document.body.innerText);
// replace the value of a labelled field in the New mandate sheet
const setField = async (label, value) => {
  const h = await page.evaluateHandle((l) => [...document.querySelectorAll(".sheet label.field")].find((el) => el.querySelector("span")?.textContent.startsWith(l))?.querySelector("input"), label);
  const el = h.asElement();
  if (!el) throw new Error(`no field "${label}"`);
  await el.focus();
  await el.evaluate((i) => i.select());
  await el.type(value);
};

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
  await page.waitForFunction(() => !document.querySelector('.panel input[inputmode="decimal"]'), { timeout: 3000 }).then(() => check(true, "deposit form closed once the deposit landed"), () => check(false, "deposit form closed once the deposit landed"));
  check(/In your wallet: 15\.00 tUSD8/.test(await bodyText()), "wallet balance shows 15.00 right away");
  await page.waitForFunction(() => !document.querySelector(".toast-pending"), { timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector(".toast-ok"), { timeout: 9000 }).then(() => check(true, "success toast dismisses itself"), () => check(false, "success toast dismisses itself"));

  step("a slow relayer: staged progress, no second signature, no early Done");
  {
    await page.setRequestInterception(true);
    let held = 0;
    page.on("request", (rq) => {
      if (rq.isInterceptResolutionHandled()) return;
      if (rq.method() === "POST" && rq.url().endsWith("/v1/deposit")) { held++; setTimeout(() => rq.continue().catch(() => {}), 4000); } else rq.continue().catch(() => {});
    });
    await clickText("button", "Deposit");
    await page.type('input[inputmode="decimal"]', "0.50");
    const t0 = Date.now();
    await clickText("button", "Deposit");
    await page.waitForFunction(() => document.body.innerText.includes("Relayer sends the transaction") && document.body.innerText.includes("Don't sign again"), { timeout: 3000 }).then(() => check(true, "the panel shows the stages while the relayer works"), () => check(false, "the panel shows the stages while the relayer works"));
    check(await page.evaluate(() => ![...document.querySelectorAll(".panel button")].some((b) => b.textContent.trim() === "Deposit")), "no Deposit button to press twice while it runs");
    check(await page.evaluate(() => !document.querySelector(".toast-ok")), "no Done toast yet");
    await page.waitForFunction(() => document.querySelector(".balance .amt")?.textContent?.startsWith("5.50"), { timeout: 60000 });
    log(`signature to new balance: ${((Date.now() - t0) / 1000).toFixed(1)} s (the relayer was held 4 s on purpose)`);
    check(await page.evaluate(() => !document.querySelector('.panel input[inputmode="decimal"]')), "form closed after the deposit");
    await page.waitForFunction(() => document.querySelector(".toast-ok")?.textContent?.includes("Deposit 0.50"), { timeout: 15000 }).then(() => check(true, "Done appears after the balances were read"), () => check(false, "Done appears after the balances were read"));
    check(held === 1, "the relayer got exactly one request");
    await page.setRequestInterception(false);
    await page.waitForFunction(() => !document.querySelector(".toast"), { timeout: 15000 });
  }

  step("the relayer ignores a repeated authorization");
  {
    const { createWalletClient, custom } = await import("viem");
    const { relayDeposit, signReceiveWithAuthorization, parseUsd, getTokenBalance } = await import("@warrant/sdk");
    const vaultNow = await page.evaluate(() => document.querySelector(".head a.mono")?.textContent);
    const signer = createWalletClient({ account: ACCOUNT, transport: custom({ request: ({ method, params }) => rpc(method, params) }) });
    const pc = createPublicClient({ transport: http(RPC) });
    const amount = parseUsd("0.05");
    const auth = await signReceiveWithAuthorization({ signer, chainId: 44005, token: TOKEN, from: ACCOUNT, to: vaultNow, value: amount, validBefore: BigInt(Math.floor(Date.now() / 1000) + 900) });
    const body = { relayerUrl: RELAYER, vault: vaultNow, from: ACCOUNT, amount, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce, signature: auth.signature, wait: false };
    const before = await getTokenBalance(pc, TOKEN, vaultNow);
    const [a, b] = await Promise.all([relayDeposit(body), relayDeposit(body)]);
    check(a.status === "submitted" && b.status === "submitted" && a.txHash === b.txHash, `same signature, same transaction (${a.txHash?.slice(0, 10)})`);
    check([a, b].filter((x) => x.duplicate).length === 1, "the second answer is marked as a duplicate");
    await pc.waitForTransactionReceipt({ hash: a.txHash });
    check((await getTokenBalance(pc, TOKEN, vaultNow)) - before === amount, "the vault received it once");
    await page.waitForFunction(() => document.querySelector(".balance .amt")?.textContent?.startsWith("5.55"), { timeout: 60000 });
  }

  step("new mandate with a generated agent key");
  await clickText("button", "New mandate");
  await waitText("Start from a template");
  await shot("04-new-mandate-sheet");
  check((await bodyText()).includes("5.00 tUSD8 per payment · 20.00 per day · 100.00 over 7 days"), "template chips carry units and the lifetime window");
  check(await page.evaluate(() => { const s = document.querySelector(".sheet"); return s.scrollWidth <= s.clientWidth; }), "no horizontal scrollbar in the drawer");
  const spill = await page.evaluate(() => { const s = document.querySelector(".sheet"); const lim = s.getBoundingClientRect().right - parseFloat(getComputedStyle(s).paddingRight) + 0.5; return [...s.querySelectorAll(".field, .tpl, .affix, .input")].filter((el) => el.getBoundingClientRect().right > lim).map((el) => el.className + ":" + Math.round(el.getBoundingClientRect().right - lim)); });
  check(spill.length === 0, `nothing in the drawer pokes past its padding ${spill.slice(0, 4).join(" ")}`);
  await clickText("button", "Generate a new agent key");
  check(await page.evaluate(() => document.querySelector(".key-box input[type=checkbox]")?.checked === false), "registry registration is off by default");
  await page.evaluate(() => document.querySelector(".key-box input[type=checkbox]").click());
  await clickText("button", "Reveal");
  const key = await page.evaluate(() => document.querySelector(".key-box code")?.textContent);
  if (!/^0x[0-9a-f]{64}$/.test(key ?? "")) throw new Error("agent key not shown");
  const merchant = getAddress("0x" + "ab".repeat(20));
  await page.type("textarea", merchant);
  // lowering the per-payment limit below the approval threshold pulls the threshold down with a visible note
  await setField("Per payment", "2");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.querySelector(".sheet .note")?.textContent.includes("Approval threshold lowered to 2.00"), { timeout: 3000 }).then(() => check(true, "threshold follows a lowered per-payment limit, with a note"), () => check(false, "threshold follows a lowered per-payment limit, with a note"));
  await setField("Per payment", "5");
  await setField("Ask me from", "3");
  await page.keyboard.press("Tab");
  check(/the vault holds 5\.55 now/.test(await bodyText()), "the form says what the vault holds");
  check(/above what the vault holds \(5\.55\)/.test(await bodyText()), "and warns when the lifetime limit is above it");
  await shot("05-new-mandate-filled");
  await clickText("button", "Issue mandate");
  await waitText("Mandate #1", 90000);
  await page.waitForFunction(() => !document.querySelector(".sheet"), { timeout: 10000 });
  check(!(await bodyText()).includes("None listed"), "new mandate never shows a false empty merchant list");
  await page.waitForFunction((m) => document.body.innerText.includes(m.slice(0, 6)) && document.querySelector(".tags"), { timeout: 30000 }, merchant);
  await shot("06-mandate-active");

  step("vault naming, and a second vault is explained");
  await clickText("button", "Rename");
  await page.type('input[aria-label="Vault name"]', "Research budget");
  await clickText("button", "Save");
  await page.waitForFunction(() => document.querySelector(".head h1")?.textContent?.startsWith("Research budget"), { timeout: 5000 });
  check((await page.evaluate(() => document.querySelector(".mandate")?.innerText ?? "")).includes("in Research budget"), "the mandate card names its vault");
  await clickText("button", "New vault");
  await waitText("you already have 1");
  check(/separate contract with its own balance/.test(await bodyText()) && !/One contract per owner/.test(await bodyText()), "the second-vault screen says what a second vault is");
  await clickText("button", "Cancel");
  await waitText("Research budget");

  step("agent pays through the relayer, UI sees it");
  const publicClient = createPublicClient({ transport: http(RPC) });
  const agent = new WarrantAgent({ signer: privateKeyToAccount(key), publicClient, chainId: 44005, vault, mandateId: 1n, relayerUrl: RELAYER });
  const p1 = await agent.pay({ merchant, amount: "0.40", context: "smoke: small purchase" });
  if (p1.status !== "executed") throw new Error(`expected executed, got ${p1.status}: ${p1.message}`);
  const p2 = await agent.pay({ merchant, amount: "3.50", context: "smoke: above threshold" });
  if (p2.status !== "queued") throw new Error(`expected queued, got ${p2.status}: ${p2.message}`);
  const evil = await agent.pay({ merchant: "0x" + "ee".repeat(20), amount: "0.10" });
  if (evil.status !== "refused") throw new Error(`unlisted merchant was not rejected: ${JSON.stringify(evil, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
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
  if (blocked.status !== "refused") throw new Error("payment went through a frozen vault");
  log("frozen vault refused:", blocked.check.message);
  await shot("09-frozen");
  await clickText("button", "Unfreeze vault");
  check((await bodyText()).includes("Let payments resume on this vault?"), "unfreeze asks for confirmation like freeze does");
  await clickText("button", "Unfreeze");
  await page.waitForFunction(() => !document.body.textContent.includes("Every payment is refused"), { timeout: 45000 });

  step("revoke");
  await clickText("button", "Revoke mandate");
  await clickText("button", "Revoke now");
  await waitText("Revoked", 45000);
  const after = await agent.pay({ merchant, amount: "0.10" });
  if (after.status !== "refused") throw new Error("payment went through a revoked mandate");
  log("revoked mandate refused:", after.check.message);
  await shot("10-revoked");
  await page.waitForFunction(() => /revoked\n[^\n]*(\d:\d\d)/i.test(document.querySelector(".mandate")?.innerText ?? ""), { timeout: 30000 }).catch(() => {});
  const card = await page.evaluate(() => { const c = document.querySelector(".mandate"); return { text: c?.innerText ?? "", muted: !!c?.querySelector(".meters.muted") }; });
  check(/revoked\n[^\n]*(\d:\d\d|block \d)/i.test(card.text) && !/expires/i.test(card.text), "revoked mandate shows when it was revoked, not an expiry");
  check(card.muted, "revoked mandate's bars are muted");

  step("second mandate, registry left off, then Register agent");
  await clickText("button", "New mandate");
  await waitText("Start from a template");
  await clickText("button", "Generate a new agent key");
  check(await page.evaluate(() => document.querySelector(".key-box input[type=checkbox]")?.checked === false), "registration still off by default");
  await page.type("textarea", merchant);
  await clickText("button", "Issue mandate");
  await waitText("Mandate #2", 90000);
  await page.waitForFunction(() => !document.querySelector(".sheet"), { timeout: 10000 });
  await waitText("Register agent", 30000);
  await clickText("button", "Register agent");
  await page.waitForSelector(".key-box");
  check(await page.evaluate(() => document.querySelector(".key-box input[type=checkbox]")?.checked === true), "Register agent opens the sheet with a new key and registration on");
  await clickText("button", "Close");
  await page.waitForFunction(() => !document.querySelector(".sheet"), { timeout: 5000 });

  step("withdraw");
  await clickText("button", "Withdraw");
  const fullLabel = await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Use the full"))?.textContent);
  check(/Use the full \d+\.\d{2}/.test(fullLabel ?? ""), `"${fullLabel}" is two-decimal`);
  await clickText("button", "Use the full");
  const filled = await page.evaluate(() => document.querySelector('.panel input[inputmode="decimal"]').value);
  check(filled === (fullLabel ?? "").replace("Use the full ", "").trim(), `the field is filled with the same figure (${filled})`);
  await clickText("button", "Withdraw");
  await page.waitForFunction(() => document.querySelector(".balance .amt")?.textContent?.startsWith("0.00"), { timeout: 60000 });
  await shot("11-final");

  step("reload: how long until the vault is on screen");
  {
    const t0 = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".head h1"), { timeout: 60000 });
    const painted = Date.now() - t0;
    await page.waitForFunction(() => document.querySelector(".mandate") && document.querySelector(".balance .amt"), { timeout: 60000 });
    log(`vault header ${painted} ms, mandates and balance ${Date.now() - t0} ms after reload`);
    check(painted < 3000, "the vault header is up within 3 s of a reload");
  }

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
if (!process.env.KEEP) await rpc("evm_revert", [snapshot]);
console.log(process.exitCode ? "\nSMOKE FAILED" : `\nSMOKE OK (screenshots in ${OUT})`);
