import { describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { PublicClient } from "viem";
import { createMerchant } from "../src";

const merchant = createMerchant({
  publicClient: { getTransactionReceipt: async () => { throw new Error("not found"); } } as unknown as PublicClient,
  chainId: 44005,
  factory: "0x9D2CF5776359fD502a1a09862D8Ef03F41446442",
  token: "0x456569838f1d43009A91ebA4263147Afd7233483",
  payTo: "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae",
  name: "Test API",
});

async function serve() {
  const app = express();
  app.get("/data", merchant.paywall(() => ({ amount: "0.15", description: "a record" })), (_req, res) => res.json({ ok: true }));
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe("merchant paywall", () => {
  it("answers 402 with an invoice naming the payee, amount, chain and reference", async () => {
    const s = await serve();
    const r = await fetch(`${s.url}/data`);
    expect(r.status).toBe(402);
    const j: any = await r.json();
    expect(j.invoice).toMatchObject({ amount: "0.15", asset: "tUSD8", chainId: 44005, payTo: "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae" });
    expect(j.invoice.ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.headers.get("x-warrant-invoice")).toBe(j.invoice.ref);
    s.close();
  });
  it("does not serve on an unverifiable receipt", async () => {
    const s = await serve();
    const inv: any = (await (await fetch(`${s.url}/data`)).json()).invoice;
    const r = await fetch(`${s.url}/data`, { headers: { "x-warrant-invoice": inv.ref, "x-warrant-tx": "0x" + "11".repeat(32) } });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("payment_not_verified");
    s.close();
  });
  it("does not serve an unknown invoice", async () => {
    const s = await serve();
    const r = await fetch(`${s.url}/data`, { headers: { "x-warrant-invoice": "0x" + "22".repeat(32), "x-warrant-tx": "0x" + "11".repeat(32) } });
    expect(r.status).toBe(402);
    expect((await r.json()).message).toMatch(/Unknown invoice/);
    s.close();
  });
});
