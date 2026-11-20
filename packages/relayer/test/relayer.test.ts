import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createRelayerApp, type RelayerConfig } from "../src";

const base: RelayerConfig = {
  rpcUrl: "http://127.0.0.1:1",
  chainId: 44005,
  privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  factory: "0x66687369d9C683aaaaDAe98b747b63eE7e0662E3",
  explorerUrl: "https://explorer-test.qday.info",
  ratePerMinuteIp: 3,
  ratePerMinuteVault: 30,
  dailyTxCap: 5,
  dbPath: ":memory:",
  refusalsPerHourVault: 20,
  dailyRefusalCap: 200,
};

async function serve(cfg: RelayerConfig) {
  const { app } = createRelayerApp({ ...cfg, dbPath: ":memory:" });
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe("relayer", () => {
  it("refuses a public dev key against a remote RPC", () => {
    expect(() => createRelayerApp({ ...base, rpcUrl: "https://rpc-test.qday.info" })).toThrow(/public dev key/);
  });
  it("accepts a dev key against a local RPC", () => {
    expect(() => createRelayerApp(base)).not.toThrow();
  });
  it("rejects malformed bodies with a readable 400", async () => {
    const s = await serve({ ...base, ratePerMinuteIp: 100 });
    const r = await fetch(`${s.url}/v1/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault: "nope" }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/Invalid request/);
    s.close();
  });
  it("requires the API key when one is configured", async () => {
    const s = await serve({ ...base, apiKey: "secret", ratePerMinuteIp: 100 });
    const r = await fetch(`${s.url}/v1/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    s.close();
  });
  it("rate limits per client", async () => {
    const s = await serve(base);
    const hit = () => fetch(`${s.url}/v1/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await hit()).status);
    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    s.close();
  });
});
