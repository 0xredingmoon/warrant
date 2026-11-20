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

/* ------------------------------------------------------------------ persistence + x402 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { decodeHeader, encodeHeader, payloadFromIntent, warrantVaultAbi, x402Fetch, buildIntent, signIntent, parseUsd } from "@warrant/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { openDb } from "@warrant/store";
import { SqliteInvoiceStore } from "../src";

const FACTORY = "0x9D2CF5776359fD502a1a09862D8Ef03F41446442" as const;
const TOKEN = "0x456569838f1d43009A91ebA4263147Afd7233483" as const;
const PAYEE = "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae" as const;
const VAULT = "0x927d8b1030E90d94039b3281A3E4b415E11c6aba" as const;

describe("invoice store", () => {
  it("keeps invoices and their paid/consumed state across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "warrant-merchant-"));
    try {
      const file = join(dir, "m.db");
      const db1 = openDb(file);
      const m1 = createMerchant({ publicClient: {} as unknown as PublicClient, chainId: 44005, factory: FACTORY, token: TOKEN, payTo: PAYEE, store: new SqliteInvoiceStore(db1) });
      const inv = m1.invoice({ amount: "0.15", description: "a record", resource: "/data" });
      m1.store.markPaid(inv.ref, ("0x" + "ab".repeat(32)) as Hex);
      expect(m1.store.consume(inv.ref)).toBe(true);
      db1.close();

      const m2 = createMerchant({ publicClient: {} as unknown as PublicClient, chainId: 44005, factory: FACTORY, token: TOKEN, payTo: PAYEE, dbPath: file });
      const back = m2.store.get(inv.ref)!;
      expect(back.invoice).toEqual(inv);
      expect(back.amount).toBe(150_000n);
      expect(back.paidTx).toBe("0x" + "ab".repeat(32));
      expect(m2.store.consume(inv.ref)).toBe(false); // an invoice buys one response, even after a restart
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes invoices that expired unpaid, keeps paid ones", () => {
    const store = new SqliteInvoiceStore(openDb(":memory:"));
    const mk = (n: number, expires: number, paid?: boolean) =>
      store.put({ invoice: { ref: (`0x${n.toString(16).padStart(64, "0")}`) as Hex } as any, amount: 1n, expires, paidTx: paid ? ("0x" + "11".repeat(32)) as Hex : undefined });
    mk(1, 1000);
    mk(2, 1000, true);
    mk(3, 200_000);
    expect(store.prune(100_000, 3600)).toBe(1);
    expect(store.get("0x" + "1".padStart(64, "0"))).toBeUndefined();
    expect(store.get("0x" + "2".padStart(64, "0"))).toBeDefined();
    expect(store.get("0x" + "3".padStart(64, "0"))).toBeDefined();
  });
});

describe("x402 paywall", () => {
  const agent = privateKeyToAccount(generatePrivateKey());
  let facilitatorReply: { verify: any; settle: any } | Error;
  let calls: string[] = [];
  let receiptTx: Hex | undefined;
  let receiptRef: Hex | undefined;

  const fakeFetch = (async (url: string, init: any) => {
    const path = new URL(url).pathname.slice(1);
    calls.push(path);
    if (facilitatorReply instanceof Error) throw facilitatorReply;
    const out = (facilitatorReply as any)[path];
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const client = {
    readContract: async () => true,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash !== receiptTx) throw new Error("not found");
      const topics = encodeEventTopics({ abi: warrantVaultAbi, eventName: "PaymentExecuted", args: { mandateId: 1n, merchant: PAYEE, invoiceRef: receiptRef! } });
      const data = encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
        [agent.address, 150_000n, 150n, ("0x" + "00".repeat(32)) as Hex, ("0x" + "00".repeat(32)) as Hex],
      );
      return { status: "success", logs: [{ address: VAULT, topics, data, blockNumber: 1n, logIndex: 0, transactionHash: hash }] };
    },
  } as unknown as PublicClient;

  const m = createMerchant({ publicClient: client, chainId: 44005, factory: FACTORY, token: TOKEN, payTo: PAYEE, name: "Test API" });
  async function serveX() {
    const app = express();
    app.get("/data", m.paywall(() => ({ amount: "0.15", description: "a record" }), { facilitatorUrl: "http://facilitator.test", fetch: fakeFetch }), (_req, res) => res.json({ ok: true, paid: res.locals.payment.txHash }));
    const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  async function paymentFor(url: string, version: 1 | 2) {
    const first = await fetch(url);
    const body: any = await first.json();
    const ref = body.invoice.ref as Hex;
    const intent = buildIntent({ mandateId: 1n, merchant: PAYEE, amount: parseUsd("0.15"), invoiceRef: ref });
    const signature = await signIntent({ signer: agent, chainId: 44005, vault: VAULT, intent });
    const payload = payloadFromIntent(VAULT, intent, signature);
    const header: Record<string, string> =
      version === 1
        ? { "x-payment": encodeHeader({ x402Version: 1, scheme: "warrant", network: "aevum-testnet", payload }) }
        : { "payment-signature": encodeHeader({ x402Version: 2, accepted: decodeHeader<any>(first.headers.get("payment-required")!).accepts[0], payload }) };
    return { ref, header };
  }

  it("answers 402 in native, x402 v1 (body) and x402 v2 (header) form at once", async () => {
    const s = await serveX();
    const r = await fetch(`${s.url}/data`);
    expect(r.status).toBe(402);
    const body: any = await r.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]).toMatchObject({ scheme: "warrant", network: "aevum-testnet", maxAmountRequired: "150000", payTo: PAYEE, asset: TOKEN, mimeType: "application/json" });
    expect(body.accepts[0].resource).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/data$/);
    expect(body.accepts[0].extra.invoiceRef).toBe(body.invoice.ref);
    const v2 = decodeHeader<any>(r.headers.get("payment-required")!);
    expect(v2).toMatchObject({ x402Version: 2, resource: { url: body.accepts[0].resource }, accepts: [{ scheme: "warrant", network: "eip155:44005", amount: "150000", payTo: PAYEE }] });
    s.close();
  });

  for (const version of [1, 2] as const) {
    it(`serves once the facilitator settles and the receipt checks out on-chain (v${version})`, async () => {
      const s = await serveX();
      const { ref, header } = await paymentFor(`${s.url}/data`, version);
      receiptTx = ("0x" + "cd".repeat(32)) as Hex;
      receiptRef = ref;
      calls = [];
      facilitatorReply = { verify: { isValid: true, payer: agent.address }, settle: { success: true, transaction: receiptTx, network: version === 1 ? "aevum-testnet" : "eip155:44005", payer: agent.address } };
      const r = await fetch(`${s.url}/data`, { headers: header });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, paid: receiptTx });
      expect(calls).toEqual(["verify", "settle"]);
      const settle = decodeHeader<any>(r.headers.get(version === 1 ? "x-payment-response" : "payment-response")!);
      expect(settle).toMatchObject({ success: true, transaction: receiptTx });
      // the same payment header cannot buy a second response
      const again = await fetch(`${s.url}/data`, { headers: header });
      expect(again.status).toBe(402);
      expect((await again.json()).error).toBe("invoice_already_used");
      s.close();
    });
  }

  it("does not serve when the facilitator says success but the chain does not agree", async () => {
    const s = await serveX();
    const { ref, header } = await paymentFor(`${s.url}/data`, 2);
    receiptTx = ("0x" + "ee".repeat(32)) as Hex;
    receiptRef = ("0x" + "99".repeat(32)) as Hex; // the receipt pays some other invoice
    facilitatorReply = { verify: { isValid: true }, settle: { success: true, transaction: receiptTx, network: "eip155:44005" } };
    const r = await fetch(`${s.url}/data`, { headers: header });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("settlement_not_verified");
    expect(m.store.get(ref)?.consumedAt).toBeUndefined();
    s.close();
  });

  it("passes the facilitator's refusal and approval states through as 402s", async () => {
    const s = await serveX();
    const a = await paymentFor(`${s.url}/data`, 2);
    facilitatorReply = { verify: { isValid: false, invalidReason: "merchant_not_allowed", invalidMessage: "not on the allowlist" }, settle: {} };
    let r = await fetch(`${s.url}/data`, { headers: a.header });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "merchant_not_allowed", message: "not on the allowlist" });

    const b = await paymentFor(`${s.url}/data`, 2);
    facilitatorReply = { verify: { isValid: true }, settle: { success: false, errorReason: "exceeds_period_cap", errorMessage: "over the cap", transaction: "", network: "eip155:44005", refusalTransaction: "0x" + "77".repeat(32) } };
    r = await fetch(`${s.url}/data`, { headers: b.header });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "exceeds_period_cap", refusalTransaction: "0x" + "77".repeat(32) });
    expect(decodeHeader<any>(r.headers.get("payment-response")!)).toMatchObject({ success: false, errorReason: "exceeds_period_cap" });

    const c = await paymentFor(`${s.url}/data`, 2);
    facilitatorReply = { verify: { isValid: true }, settle: { success: false, errorReason: "approval_required", errorMessage: "waits", transaction: "", network: "eip155:44005", pendingId: "7" } };
    r = await fetch(`${s.url}/data`, { headers: c.header });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "approval_required", pendingId: "7" });
    s.close();
  });

  it("answers 502 when the facilitator is down, and rejects payments for amounts it did not ask", async () => {
    const s = await serveX();
    const a = await paymentFor(`${s.url}/data`, 2);
    facilitatorReply = new Error("connect ECONNREFUSED");
    let r = await fetch(`${s.url}/data`, { headers: a.header });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("facilitator_unavailable");

    const first = await fetch(`${s.url}/data`);
    const inv: any = (await first.json()).invoice;
    const cheap = buildIntent({ mandateId: 1n, merchant: PAYEE, amount: 1n, invoiceRef: inv.ref });
    const sig = await signIntent({ signer: agent, chainId: 44005, vault: VAULT, intent: cheap });
    const hdr = encodeHeader({ x402Version: 1, scheme: "warrant", network: "aevum-testnet", payload: payloadFromIntent(VAULT, cheap, sig) });
    calls = [];
    facilitatorReply = { verify: { isValid: true }, settle: { success: true } };
    r = await fetch(`${s.url}/data`, { headers: { "x-payment": hdr } });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("payment_mismatch");
    expect(calls).toEqual([]);
    s.close();
  });

  it("the SDK client pays a 402 in either version and refuses payments the mandate forbids", async () => {
    const s = await serveX();
    receiptTx = ("0x" + "cd".repeat(32)) as Hex;
    let lastRef: Hex | undefined;
    const spyFetch = (async (u: any, i: any) => {
      const res = await fetch(u, i);
      return res;
    }) as typeof fetch;
    // mocked chain read for the client's free pre-flight check: 0 = Ok
    const publicClient = { readContract: async () => 0 } as unknown as PublicClient;
    const x = { signer: agent, publicClient, chainId: 44005, vault: VAULT, mandateId: 1n };
    // settle echoes the invoice the client actually signed for
    const original = fakeFetch;
    const echoFetch = (async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      lastRef = body.paymentPayload.payload.intent.invoiceRef;
      receiptRef = lastRef;
      facilitatorReply = { verify: { isValid: true }, settle: { success: true, transaction: receiptTx, network: body.paymentRequirements.network } };
      return original(url, init);
    }) as unknown as typeof fetch;
    const m2 = createMerchant({ publicClient: client, chainId: 44005, factory: FACTORY, token: TOKEN, payTo: PAYEE });
    const app = express();
    app.get("/d", m2.paywall(() => ({ amount: "0.15", description: "x" }), { facilitatorUrl: "http://f.test", fetch: echoFetch }), (_q, r) => r.json({ ok: 1 }));
    const server = await new Promise<import("node:http").Server>((r) => { const sv = app.listen(0, "127.0.0.1", () => r(sv)); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/d`;

    const paid = await x402Fetch(x, url, {}, { fetch: spyFetch });
    expect(paid.outcome.kind).toBe("paid");
    expect(await paid.response.json()).toEqual({ ok: 1 });

    // a mandate that refuses (check returns MerchantNotAllowed = 7): nothing is sent to the merchant
    const refusing = { ...x, publicClient: { readContract: async () => 7 } as unknown as PublicClient };
    const denied = await x402Fetch(refusing, url, {}, { fetch: spyFetch });
    expect(denied.outcome).toMatchObject({ kind: "refused", amount: "0.15" });
    expect((denied.outcome as any).check.reason).toBe("MerchantNotAllowed");
    expect(denied.response.status).toBe(402);

    // the agent can decline on price
    const declined = await x402Fetch(x, url, {}, { fetch: spyFetch, approve: () => false });
    expect(declined.outcome.kind).toBe("failed");
    server.close();
    s.close();
  });
});
