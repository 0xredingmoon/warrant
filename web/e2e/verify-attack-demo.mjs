// Drives the "Try the attack" panel on a running dashboard with no wallet at all: the landing page must show the
// panel, both buttons must come back refused on-chain, and the explorer link must point at a real transaction.
// Prereqs: the static build served by `scripts/serve-web.mjs` (or any host) with a relayer URL the app accepts, a
// relayer started with DEMO_VAULT / DEMO_AGENT_KEY, and Chrome. Nothing here signs anything: that is the point.
// usage: WEB_URL=http://192.168.1.10:3000 RELAYER_URL=http://192.168.1.10:8787 node web/e2e/verify-attack-demo.mjs
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const RELAYER = process.env.RELAYER_URL ?? "http://localhost:8787";
const OUT = process.env.SHOTS ?? "/tmp/warrant-shots";
mkdirSync(OUT, { recursive: true });

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const log = (...a) => console.log("  ", ...a);

// the panel only appears when the relayer offers the demo; fail early with the real reason
const view = await (await fetch(`${RELAYER}/v1/demo/attack`)).json().catch(() => null);
if (!view?.enabled) {
  console.error(`The relayer at ${RELAYER} does not have the attack demo configured (GET /v1/demo/attack).`);
  console.error("Start it with DEMO_VAULT and DEMO_AGENT_KEY set, see README.");
  process.exit(2);
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(WEB, { waitUntil: "networkidle2" });
// no wallet: the landing page is the default view
await page.waitForFunction(() => document.body.textContent.includes("Try the attack"), { timeout: 30_000 }).catch(() => fail("the panel did not render: is the dashboard pointed at this relayer?"));
const text = () => page.evaluate(() => document.querySelector(".attack-rows")?.innerText ?? "");

// the panel shows the vault shortened, in the app's own casing, and the full address in the link's href
const shortened = await page.evaluate(() => {
  const link = document.querySelector(".attack a");
  return link ? link.innerText.trim() : "";
});
if (!shortened.includes("...")) fail(`the panel does not show the vault short form (${shortened})`);

// click each "Try it" in turn; a run replaces that row's button with its verdict. Wait on the row count rather
// than on any "Refused" text: a previous run may already have left the other row refused.
for (const [i, attack] of view.attacks.entries()) {
  const before = (await page.$$("button.btn.stop.sm")).length;
  if (!before) {
    fail(`no Try it button left before attack ${i}`);
    break;
  }
  await page.evaluate(() => document.querySelector("button.btn.stop.sm")?.click());
  await page
    .waitForFunction((n) => document.querySelectorAll("button.btn.stop.sm").length === n - 1, { timeout: 120_000 }, before)
    .catch(() => fail(`attack ${i} (${attack.kind}) never finished`));
  const rows = await text();
  // the contract's own wording for this refusal, from the relayer's plan
  const phrase = attack.expectedReason === "ExceedsPerTxCap" ? "above the per-payment limit" : "not on this mandate's merchant allowlist";
  const refusedHere = rows.includes(attack.expectedReason) && rows.includes(phrase);
  log(`${attack.kind}: ${refusedHere ? "refused on-chain, reason on screen" : "NOT REFUSED"}`);
  if (!refusedHere) fail(`attack ${i} (${attack.kind}) did not show its reason`);
  log(`${attack.kind}: buttons left ${(await page.$$("button.btn.stop.sm")).length} (was ${before})`);
}

// the explorer link must be a transaction, and the reason code must be on screen in the contract's words
const links = await page.evaluate(() => [...document.querySelectorAll(".attack-result a")].map((a) => a.getAttribute("href")));
if (!links.length || links.some((h) => !/\/tx\/0x[0-9a-f]{64}$/.test(h ?? ""))) fail(`explorer links look wrong: ${JSON.stringify(links)}`);
for (const reason of view.attacks.map((a) => a.expectedReason)) {
  if (!(await text()).includes(reason)) fail(`the panel does not show the reason code ${reason}`);
}

await page.evaluate(() => document.querySelector(".attack")?.scrollIntoView({ block: "start" }));
await page.screenshot({ path: `${OUT}/attack-panel.png`, fullPage: false });
log(`screenshot: ${OUT}/attack-panel.png`);

// a React hydration warning on a static export is not a failure, anything else is
const real = errors.filter((e) => !/Minified React error #418|Hydration/i.test(e));
if (real.length) fail(`page errors: ${real.join(" | ")}`);

await browser.close();
if (!process.exitCode) console.log("OK: the attack demo works for a visitor with no wallet.");
