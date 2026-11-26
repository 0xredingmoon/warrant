// Real phone and desktop rendering check, at true CSS viewport widths.
//
// The design is judged on a phone as much as on a desktop, and a resized desktop window is not a phone: the window
// cannot get narrower than its own chrome, so the browser silently clamps the viewport and the "375px" screenshot is
// really 355px. This drives headless Chrome, which honours the width exactly, and asserts the things that actually
// break on small screens: horizontal overflow, tap targets under 44px, and text that collides with the sticky header.
//
//   node web/e2e/viewport-check.mjs [url]
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const URL_ = process.argv[2] ?? process.env.WEB_URL ?? "http://localhost:3199/";
const OUT = process.env.SHOTS ?? join(process.cwd(), ".shots");
const SIZES = [
  { name: "iphone-se", width: 375, height: 667 },
  { name: "iphone-15", width: 393, height: 852 },
  { name: "iphone-max", width: 430, height: 932 },
  { name: "desktop", width: 1360, height: 900 },
];

const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error("No Chrome binary found. Set CHROME=/path/to/chrome");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
let failed = 0;

for (const size of SIZES) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(m.text()); });
  await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1, isMobile: size.width < 500, hasTouch: size.width < 500 });
  await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 1800)); // let the live reads land

  const report = await page.evaluate(() => {
    const d = document.documentElement;
    const under = [...document.querySelectorAll("a, button, input, select")].map((el) => {
      const r = el.getBoundingClientRect();
      // an inline word can carry its hit area on ::after; that still counts as a reachable target
      const after = getComputedStyle(el, "::after");
      const extra = after.content !== "none" && after.position === "absolute"
        ? Math.abs(parseFloat(after.insetBlockStart || "0") || 0) * 2
        : 0;
      return { tag: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim().slice(0, 34), h: Math.round(r.height + extra), w: Math.round(r.width) };
    }).filter((t) => t.h > 0 && t.w > 0 && t.h < 44);

    // a heading landed under the sticky bar is invisible to whoever followed the link there
    const bar = document.querySelector(".bar");
    const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
    const covered = ["#proof", "#try-the-attack"].map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const r = el.getBoundingClientRect();
      return { sel, top: Math.round(r.top), hiddenUnderBar: r.top < barBottom - 1 && r.bottom > barBottom };
    });

    return {
      innerWidth: window.innerWidth,
      clientWidth: d.clientWidth,
      overflowX: d.scrollWidth - d.clientWidth,
      undersized: under,
      covered,
      proofCards: document.querySelectorAll(".proof-card").length,
      attackRows: document.querySelectorAll(".attack-row").length,
    };
  });

  const shot = join(OUT, `${size.name}-${size.width}.png`);
  await page.screenshot({ path: shot, fullPage: true });

  const problems = [];
  if (report.innerWidth !== size.width) problems.push(`viewport clamped to ${report.innerWidth}, wanted ${size.width}`);
  if (report.overflowX > 0) problems.push(`horizontal overflow ${report.overflowX}px`);
  if (report.undersized.length) problems.push(`${report.undersized.length} tap target(s) under 44px: ${JSON.stringify(report.undersized.slice(0, 4))}`);
  if (report.proofCards !== 2) problems.push(`expected 2 proof cards, saw ${report.proofCards}`);
  if (report.attackRows !== 2) problems.push(`expected 2 attack rows, saw ${report.attackRows}`);
  if (errors.length) problems.push(`console errors: ${errors.slice(0, 3).join(" | ")}`);

  if (problems.length) {
    failed++;
    console.log(`FAIL ${size.name} (${size.width}px)`);
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(`ok   ${size.name} (${size.width}px)  overflow=${report.overflowX} targets>=44px cards=${report.proofCards}`);
  }
  await page.close();
}

// the anchor offset, checked by actually following the hero call to action
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60_000 });
await new Promise((r) => setTimeout(r, 1200));
const followed = await page.evaluate(async () => {
  const a = document.querySelector('.hero .cta a[href="#try-the-attack"]');
  if (!a) return { skipped: "no anchor CTA (a wallet is present)" };
  a.click();
  await new Promise((r) => setTimeout(r, 900));
  const el = document.querySelector("#try-the-attack");
  const bar = document.querySelector(".bar");
  const h2 = el?.querySelector("h2");
  return {
    headingTop: h2 ? Math.round(h2.getBoundingClientRect().top) : null,
    barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
    headingVisible: h2 ? h2.getBoundingClientRect().top >= (bar?.getBoundingClientRect().bottom ?? 0) - 1 : null,
  };
});
if (followed.skipped) {
  console.log(`skip anchor-offset check: ${followed.skipped}`);
} else if (followed.headingVisible) {
  console.log(`ok   anchor offset: heading at ${followed.headingTop}px, bar ends at ${followed.barBottom}px`);
} else {
  failed++;
  console.log(`FAIL anchor offset: heading at ${followed.headingTop}px is under the bar (${followed.barBottom}px)`);
}
await page.close();

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall viewport checks passed");
process.exitCode = failed ? 1 : 0;
