import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  WARRANT_SCHEME,
  buildIntent,
  createMandate,
  parseUsd,
  payloadFromIntent,
  randomBytes32,
  signIntent,
  warrantVaultAbi,
  x402Network,
  type MandateParams,
} from "@warrant/sdk";
import { createRelayerApp, type RelayerConfig } from "../src";
import { hasAnvil, startChain, type TestChain } from "./chain";

const maybe = hasAnvil ? describe : describe.skip;

maybe("relayer against a local chain", { timeout: 30_000 }, () => {
  let c: TestChain;
  let dir: string;
  const agent = privateKeyToAccount(generatePrivateKey());
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  let mandateId: bigint;
  const open: Array<() => void> = [];

  const cfg = (over: Partial<RelayerConfig> = {}): RelayerConfig => ({
    rpcUrl: c.rpcUrl,
    chainId: 44005,
    privateKey: c.relayerKey,
    factory: c.factory,
    explorerUrl: "https://explorer.invalid",
    ratePerMinuteIp: 1000,
    ratePerMinuteVault: 1000,
    dailyTxCap: 100,
    dbPath: join(dir, "relayer.db"),
    refusalsPerHourVault: 20,
    dailyRefusalCap: 200,
    ...over,
  });

  async function serve(over: Partial<RelayerConfig> = {}) {
    const r = createRelayerApp(cfg(over));
    const server = await new Promise<import("node:http").Server>((res) => {
      const s = r.app.listen(0, "127.0.0.1", () => res(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stop = () => {
      server.close();
      r.close();
    };
    open.push(stop);
    return { url, stop };
  }

  /** logs the vault emitted after block `from` (exclusive); none if the chain has not moved */
  const logsAfter = async (from: bigint) => {
    const head = await c.publicClient.getBlockNumber();
    return head > from ? c.publicClient.getLogs({ address: c.vault, fromBlock: from + 1n, toBlock: head }) : [];
  };

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
    return { status: res.status, json: (await res.json()) as any };
  };

  async function signed(amount: string, to = merchant, invoiceRef = randomBytes32()) {
    const intent = buildIntent({ mandateId, merchant: to, amount: parseUsd(amount), invoiceRef, context: "test" });
    const signature = await signIntent({ signer: agent, chainId: 44005, vault: c.vault, intent });
    return { intent, signature };
  }
  const requirements = (amount: bigint, invoiceRef: string, payTo = merchant) => ({
    scheme: WARRANT_SCHEME,
    network: x402Network(44005, 2),
    amount: amount.toString(),
    asset: c.token,
    payTo,
    maxTimeoutSeconds: 600,
    extra: { invoiceRef, name: "Warrant", version: "1" },
  });
  const v2 = async (amount: string, to = merchant) => {
    const { intent, signature } = await signed(amount, to);
    const reqs = requirements(intent.amount, intent.invoiceRef, to);
    return { intent, reqs, body: { x402Version: 2, paymentPayload: { x402Version: 2, accepted: reqs, payload: payloadFromIntent(c.vault, intent, signature) }, paymentRequirements: reqs } };
  };

  beforeAll(async () => {
    c = await startChain();
    dir = mkdtempSync(join(tmpdir(), "warrant-relayer-"));
    const now = Math.floor(Date.now() / 1000);
    const params: MandateParams = {
      agent: agent.address,
      agentId: 0n,
      perTxCap: parseUsd("5"),
      periodCap: parseUsd("50"),
      totalCap: parseUsd("100"),
      periodLength: 86400,
      validAfter: now - 60,
      expiry: now + 3600 * 24 * 30,
      approvalThreshold: parseUsd("4"),
      approvalWindow: 3600,
    };
    const created = await createMandate({ clients: { publicClient: c.publicClient, walletClient: c.owner.wallet as any }, vault: c.vault, params, merchants: [{ address: merchant }] });
    mandateId = created.mandateId;
  }, 60_000);

  afterAll(() => {
    for (const s of open) s();
    c?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("/v1/pay executes an in-policy payment", async () => {
    const s = await serve();
    const { intent, signature } = await signed("0.25");
    const r = await post(`${s.url}/v1/pay`, { vault: c.vault, intent, signature });
    expect(r.json.status).toBe("executed");
    expect(await c.publicClient.readContract({ address: c.token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [merchant] })).toBe(parseUsd("0.25") - parseUsd("0.25") / 1000n);
    s.stop();
  });

  it("/v1/pay records a refusal on-chain: the merchant is not on the allowlist", async () => {
    const s = await serve();
    const { intent, signature } = await signed("1.00", stranger);
    const r = await post(`${s.url}/v1/pay`, { vault: c.vault, intent, signature });
    expect(r.json.status).toBe("refused");
    expect(r.json.check.reason).toBe("MerchantNotAllowed");
    expect(r.json.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const receipt = await c.publicClient.getTransactionReceipt({ hash: r.json.txHash });
    const log = receipt.logs.find((l) => l.address.toLowerCase() === c.vault.toLowerCase())!;
    expect(log.topics.length).toBe(4); // PaymentRefused: mandate, agent, merchant indexed
    expect(await c.publicClient.readContract({ address: c.vault, abi: warrantVaultAbi, functionName: "refusalCount", args: [mandateId] })).toBeGreaterThanOrEqual(1n);
    s.stop();
  });

  it("does not send anything for an intent the agent did not sign", async () => {
    const s = await serve();
    const { intent } = await signed("1.00", stranger);
    const stranger2 = privateKeyToAccount(generatePrivateKey());
    const signature = await signIntent({ signer: stranger2, chainId: 44005, vault: c.vault, intent });
    const before = await c.publicClient.getBlockNumber();
    const r = await post(`${s.url}/v1/pay`, { vault: c.vault, intent, signature });
    expect(r.json.status).toBe("rejected");
    expect(r.json.check.reason).toBe("BadSignature");
    expect(r.json.txHash).toBeUndefined();
    expect((await logsAfter(before)).length).toBe(0);
    s.stop();
  });

  it("limits recorded refusals per vault and says why when it stops recording", async () => {
    const s = await serve({ dbPath: join(dir, "refusals.db"), refusalsPerHourVault: 2 });
    const statuses: string[] = [];
    let note: string | undefined;
    for (let i = 0; i < 3; i++) {
      const { intent, signature } = await signed("1.00", stranger);
      const r = await post(`${s.url}/v1/pay`, { vault: c.vault, intent, signature });
      statuses.push(r.json.status);
      note = r.json.note ?? note;
    }
    expect(statuses).toEqual(["refused", "refused", "rejected"]);
    expect(note).toMatch(/refusal budget/);
    s.stop();
  });

  it("keeps rate limits and daily budgets across a restart", async () => {
    const file = join(dir, "persist.db");
    const small = { dbPath: file, ratePerMinuteIp: 3, dailyTxCap: 1 };
    let s = await serve(small);
    const hit = () => fetch(`${s.url}/v1/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect([(await hit()).status, (await hit()).status, (await hit()).status]).toEqual([400, 400, 400]);
    expect((await hit()).status).toBe(429);
    s.stop();
    // restart on the same file: the client is still limited
    s = await serve(small);
    expect((await hit()).status).toBe(429);
    s.stop();

    // the daily transaction budget is also remembered
    const file2 = join(dir, "daily.db");
    let t = await serve({ dbPath: file2, dailyTxCap: 1 });
    const one = await signed("0.10");
    expect((await post(`${t.url}/v1/pay`, { vault: c.vault, ...one })).json.status).toBe("executed");
    t.stop();
    t = await serve({ dbPath: file2, dailyTxCap: 1 });
    const two = await signed("0.10");
    const r = await post(`${t.url}/v1/pay`, { vault: c.vault, ...two });
    expect(r.status).toBe(429);
    expect(r.json.error).toMatch(/daily transaction cap/);
    expect((await (await fetch(`${t.url}/health`)).json()).txToday).toBe(1);
    t.stop();
  });

  describe("x402 facilitator", () => {
    it("advertises the warrant scheme for v1 and v2", async () => {
      const s = await serve();
      const sup = (await (await fetch(`${s.url}/supported`)).json()) as any;
      expect(sup.kinds).toEqual([
        { x402Version: 1, scheme: "warrant", network: "aevum-testnet" },
        { x402Version: 2, scheme: "warrant", network: "eip155:44005" },
      ]);
      s.stop();
    });

    it("verify is read-only and settle pays; settling twice is idempotent", async () => {
      const s = await serve();
      const p = await v2("0.50");
      const before = await c.publicClient.getBlockNumber();
      const v = await post(`${s.url}/verify`, p.body);
      expect(v.json).toMatchObject({ isValid: true, payer: agent.address });
      expect((await logsAfter(before)).length).toBe(0);

      const a = await post(`${s.url}/settle`, p.body);
      expect(a.json).toMatchObject({ success: true, network: "eip155:44005", payer: agent.address });
      expect(a.json.transaction).toMatch(/^0x[0-9a-f]{64}$/);
      const b = await post(`${s.url}/settle`, p.body);
      expect(b.json.transaction).toBe(a.json.transaction);
      s.stop();
    });

    it("answers v1 payloads too (X-PAYMENT shape, network name)", async () => {
      const s = await serve();
      const { intent, signature } = await signed("0.30");
      const reqs = { ...requirements(intent.amount, intent.invoiceRef), network: "aevum-testnet", maxAmountRequired: intent.amount.toString(), amount: undefined };
      const body = { x402Version: 1, paymentPayload: { x402Version: 1, scheme: "warrant", network: "aevum-testnet", payload: payloadFromIntent(c.vault, intent, signature) }, paymentRequirements: reqs };
      const r = await post(`${s.url}/settle`, body);
      expect(r.json).toMatchObject({ success: true, network: "aevum-testnet" });
      s.stop();
    });

    it("rejects a payment that does not match the requirements", async () => {
      const s = await serve();
      const p = await v2("0.20");
      const wrongAmount = { ...p.body, paymentRequirements: { ...p.reqs, amount: "999999" } };
      expect((await post(`${s.url}/verify`, wrongAmount)).json).toMatchObject({ isValid: false, invalidReason: "amount_mismatch" });
      const wrongPayee = { ...p.body, paymentRequirements: { ...p.reqs, payTo: stranger } };
      expect((await post(`${s.url}/verify`, wrongPayee)).json).toMatchObject({ isValid: false, invalidReason: "recipient_mismatch" });
      const wrongInvoice = { ...p.body, paymentRequirements: { ...p.reqs, extra: { ...p.reqs.extra, invoiceRef: randomBytes32() } } };
      expect((await post(`${s.url}/verify`, wrongInvoice)).json).toMatchObject({ isValid: false, invalidReason: "invoice_mismatch" });
      const wrongNet = { ...p.body, paymentRequirements: { ...p.reqs, network: "eip155:1" } };
      expect((await post(`${s.url}/settle`, wrongNet)).json).toMatchObject({ success: false, errorReason: "invalid_network", transaction: "" });
      const fakeVault = { ...p.body, paymentPayload: { ...p.body.paymentPayload, payload: { ...p.body.paymentPayload.payload, vault: stranger } } };
      expect((await post(`${s.url}/verify`, fakeVault)).json).toMatchObject({ isValid: false, invalidReason: "unknown_vault" });
      s.stop();
    });

    it("a refused payment settles as success:false with the on-chain refusal transaction", async () => {
      const s = await serve();
      const p = await v2("1.00", stranger);
      const v = await post(`${s.url}/verify`, p.body);
      expect(v.json).toMatchObject({ isValid: false, invalidReason: "merchant_not_allowed" });
      const r = await post(`${s.url}/settle`, p.body);
      expect(r.json).toMatchObject({ success: false, errorReason: "merchant_not_allowed", transaction: "" });
      expect(r.json.refusalTransaction).toMatch(/^0x[0-9a-f]{64}$/);
      // asking again returns the same stored refusal instead of a second transaction
      const again = await post(`${s.url}/settle`, p.body);
      expect(again.json.refusalTransaction).toBe(r.json.refusalTransaction);
      s.stop();
    });

    it("a payment above the co-sign threshold is queued, then collected after the owner approves", async () => {
      const file = join(dir, "x402-queue.db");
      let s = await serve({ dbPath: file });
      const p = await v2("4.50"); // threshold is 4.00
      const q = await post(`${s.url}/settle`, p.body);
      expect(q.json).toMatchObject({ success: false, errorReason: "approval_required", transaction: "" });
      expect(q.json.pendingId).toMatch(/^\d+$/);

      // still waiting after a restart
      s.stop();
      s = await serve({ dbPath: file });
      expect((await post(`${s.url}/settle`, p.body)).json.errorReason).toBe("approval_required");

      const hash = await c.owner.wallet.writeContract({ address: c.vault, abi: warrantVaultAbi, functionName: "approve", args: [BigInt(q.json.pendingId)], chain: c.chain, gas: 700_000n } as any);
      await c.publicClient.waitForTransactionReceipt({ hash });
      const done = await post(`${s.url}/settle`, p.body);
      expect(done.json).toMatchObject({ success: true, transaction: hash });
      s.stop();
    });

    it("a rejected queued payment settles as approval_rejected", async () => {
      const s = await serve();
      const p = await v2("4.25");
      const q = await post(`${s.url}/settle`, p.body);
      const hash = await c.owner.wallet.writeContract({ address: c.vault, abi: warrantVaultAbi, functionName: "reject", args: [BigInt(q.json.pendingId)], chain: c.chain } as any);
      await c.publicClient.waitForTransactionReceipt({ hash });
      expect((await post(`${s.url}/settle`, p.body)).json).toMatchObject({ success: false, errorReason: "approval_rejected" });
      s.stop();
    });
  });
});
