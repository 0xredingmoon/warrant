import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createMandate, parseUsd, warrantVaultAbi, type MandateParams } from "@warrant/sdk";
import { createRelayerApp, type AttackDemoConfig, type RelayerConfig } from "../src";
import { hasAnvil, startChain, type TestChain } from "./chain";

const maybe = hasAnvil ? describe : describe.skip;

maybe("try the attack, against a local chain", { timeout: 30_000 }, () => {
  let c: TestChain;
  let dir: string;
  let mandateId: bigint;
  const open: Array<() => void> = [];

  // the agent the demonstration controls, the merchant the mandate allows, and an address it does not
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  const stranger = privateKeyToAccount(generatePrivateKey()).address;

  const demoConfig = (over: Partial<AttackDemoConfig> = {}): AttackDemoConfig => ({
    chainId: 44005,
    vault: c.vault,
    mandateId,
    agentKey,
    allowedMerchant: merchant,
    blockedMerchant: stranger,
    // the mandate below allows 2.00 per payment and 10.00 per period, and lists only `merchant`
    overspendAmount: parseUsd("3"),
    offlistAmount: parseUsd("0.01"),
    cooldownSeconds: 0,
    ...over,
  });

  const cfg = (demo: AttackDemoConfig | undefined = demoConfig()): RelayerConfig => ({
    rpcUrl: c.rpcUrl,
    chainId: 44005,
    privateKey: c.relayerKey,
    factory: c.factory,
    explorerUrl: "https://explorer.invalid",
    ratePerMinuteIp: 1000,
    ratePerMinuteVault: 100,
    dailyTxCap: 100,
    dbPath: join(dir, "relayer.db"),
    refusalsPerHourVault: 20,
    dailyRefusalCap: 200,
    attackDemo: demo,
  });

  async function serve(over: Partial<RelayerConfig> = {}) {
    const r = createRelayerApp({ ...cfg(), ...over });
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

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };

  beforeAll(async () => {
    c = await startChain();
    dir = mkdtempSync(join(tmpdir(), "warrant-attack-"));
    const now = Math.floor(Date.now() / 1000);
    // a mandate shaped for the demonstration: a small per-payment cap, one allowed merchant
    const params: MandateParams = {
      agent: agent.address,
      agentId: 0n,
      perTxCap: parseUsd("2"),
      periodCap: parseUsd("10"),
      totalCap: parseUsd("50"),
      periodLength: 86400,
      validAfter: now - 60,
      expiry: now + 3600 * 24 * 30,
      approvalThreshold: 0n,
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

  it("describes the demo without signing anything", async () => {
    const s = await serve();
    const res = await fetch(`${s.url}/v1/demo/attack`);
    const view = (await res.json()) as any;
    expect(view.enabled).toBe(true);
    expect(view.vault.toLowerCase()).toBe(c.vault.toLowerCase());
    expect(view.agent.toLowerCase()).toBe(agent.address.toLowerCase());
    expect(view.terms.perTxCap).toBe("2.00");
    expect(view.terms.revoked).toBe(false);
    expect(view.attacks.map((a: any) => a.kind)).toEqual(["overspend", "offlist"]);
    expect(view.attacks[0].expectedReason).toBe("ExceedsPerTxCap");
    expect(view.attacks[1].expectedReason).toBe("MerchantNotAllowed");
    s.stop();
  });

  it("the overspend is signed by the agent and refused on-chain for exceeding the per-payment cap", async () => {
    const s = await serve();
    const before = await c.publicClient.readContract({ address: c.vault, abi: warrantVaultAbi, functionName: "refusalCount", args: [mandateId] });
    const r = await post(`${s.url}/v1/demo/attack`, { kind: "overspend" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("refused");
    expect(r.json.check.reason).toBe("ExceedsPerTxCap");
    expect(r.json.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.json.explorerUrl).toContain(r.json.txHash);
    expect(r.json.note).toBeUndefined();
    const after = await c.publicClient.readContract({ address: c.vault, abi: warrantVaultAbi, functionName: "refusalCount", args: [mandateId] });
    expect(after).toBe(before + 1n);
    s.stop();
  });

  it("the offlist payment is refused because the recipient is not on the allowlist", async () => {
    const s = await serve();
    const r = await post(`${s.url}/v1/demo/attack`, { kind: "offlist" });
    expect(r.json.status).toBe("refused");
    expect(r.json.check.reason).toBe("MerchantNotAllowed");
    expect(r.json.merchant.toLowerCase()).toBe(stranger.toLowerCase());
    // the intent really was the agent's: no funds moved to the stranger
    const tokenAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
    const strangerBalance = await c.publicClient.readContract({ address: c.token, abi: tokenAbi, functionName: "balanceOf", args: [stranger] });
    expect(strangerBalance).toBe(0n);
    s.stop();
  });

  it("rejects an unknown attack kind", async () => {
    const s = await serve();
    const r = await post(`${s.url}/v1/demo/attack`, { kind: "drain" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/kind must be one of/);
    s.stop();
  });

  it("holds a visitor to a cooldown so one of them cannot use up the refusal budget", async () => {
    const s = await serve({ attackDemo: demoConfig({ cooldownSeconds: 60 }) });
    // an attack of its own kind: the overspend cooldown above does not cover this one
    expect((await post(`${s.url}/v1/demo/attack`, { kind: "offlist" })).json.status).toBe("refused");
    const again = await post(`${s.url}/v1/demo/attack`, { kind: "offlist" });
    expect(again.status).toBe(429);
    expect(again.json.error).toMatch(/Try again in \d+s/);
    s.stop();
  });

  it("answers 404 when no demo vault is configured", async () => {
    const s = await serve({ attackDemo: undefined });
    const res = await fetch(`${s.url}/v1/demo/attack`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not configured/);
    s.stop();
  });
});
