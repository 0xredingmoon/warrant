#!/usr/bin/env node
// Serves the static dashboard export (web/out) and writes /config.js from the environment, no dependencies.
//   RELAYER_URL=http://localhost:8787 PORT=3000 node scripts/serve-web.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../web/out");
if (!existsSync(join(root, "index.html"))) {
  console.error("web/out missing. Build it: STATIC_EXPORT=1 pnpm --filter @warrant/web exec next build");
  process.exit(1);
}
const keys = { RELAYER_URL: "relayerUrl", RPC_URL: "rpcUrl", EXPLORER_URL: "explorer", INDEXER_URL: "indexerUrl", FACTORY_ADDRESS: "factory", REGISTRY_ADDRESS: "registry" };
const cfg = Object.fromEntries(Object.entries(keys).filter(([k]) => process.env[k]).map(([k, v]) => [v, process.env[k]]));
const configJs = `window.__WARRANT__ = ${JSON.stringify(cfg)};\n`;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain" };

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/config.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(configJs);
    return;
  }
  let file = normalize(join(root, path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
  if (!existsSync(file)) file = join(root, "index.html");
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": path.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache" }).end(readFileSync(file));
}).listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "127.0.0.1", () => console.log(`dashboard on :${process.env.PORT ?? 3000}  relayer ${cfg.relayerUrl ?? "(none)"}`));
