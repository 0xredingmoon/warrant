import { describe, expect, it, vi } from "vitest";
import { recoverTypedDataAddress, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MANDATE_TEMPLATES,
  Reason,
  buildIntent,
  formatUsd,
  getLogsChunked,
  hashContext,
  paymentIntentTypes,
  parseUsd,
  reasonMessage,
  reasonName,
  signIntent,
  templateToParams,
  toCheckResult,
  vaultDomain,
  decodeAuditLogs,
} from "../src";

describe("reasons", () => {
  it("every on-chain reason has a plain-language message", () => {
    for (const [name, code] of Object.entries(Reason)) {
      expect(reasonName(code)).toBe(name);
      expect(reasonMessage(code).length).toBeGreaterThan(10);
    }
  });
  it("only Ok and ApprovalRequired are accepted", () => {
    const accepted = Object.values(Reason).filter((c) => toCheckResult(c).accepted);
    expect(accepted).toEqual([Reason.Ok, Reason.ApprovalRequired]);
    expect(toCheckResult(Reason.Ok).ok).toBe(true);
    expect(toCheckResult(Reason.ApprovalRequired).ok).toBe(false);
  });
  it("unknown codes do not throw", () => {
    expect(reasonMessage(99)).toMatch(/does not know/);
    expect(toCheckResult(99)).toMatchObject({ reason: "Unknown", accepted: false, ok: false });
  });
});

describe("amounts", () => {
  it("round-trips with at least two decimals", () => {
    expect(parseUsd("1.5")).toBe(1_500_000n);
    expect(formatUsd(1_500_000n)).toBe("1.50");
    expect(formatUsd(150n)).toBe("0.00015");
    expect(formatUsd(0n)).toBe("0.00");
  });
});

describe("intents", () => {
  const vault = "0x927d8b1030E90d94039b3281A3E4b415E11c6aba" as const;
  it("signs a typed intent that recovers to the agent and binds the vault and chain", async () => {
    const agent = privateKeyToAccount(generatePrivateKey());
    const intent = buildIntent({ mandateId: 1n, merchant: "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae", amount: parseUsd("0.15"), context: "10-K summary" });
    const signature = await signIntent({ signer: agent, chainId: 44005, vault, intent });
    const recover = (chainId: number, v: `0x${string}`) =>
      recoverTypedDataAddress({ domain: vaultDomain(chainId, v), types: paymentIntentTypes, primaryType: "PaymentIntent", message: intent, signature });
    expect(await recover(44005, vault)).toBe(agent.address);
    expect(await recover(1, vault)).not.toBe(agent.address);
    expect(await recover(44005, "0x0000000000000000000000000000000000000001")).not.toBe(agent.address);
  });
  it("hashes context deterministically and uses a fresh nonce each time", () => {
    expect(hashContext("a")).toBe(hashContext("a"));
    expect(hashContext("a")).not.toBe(hashContext("b"));
    const a = buildIntent({ mandateId: 1n, merchant: "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae", amount: 1n });
    const b = buildIntent({ mandateId: 1n, merchant: "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae", amount: 1n });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.invoiceRef).not.toBe(b.invoiceRef);
  });
});

describe("templates", () => {
  it("produce parameters the vault accepts", () => {
    const agent = privateKeyToAccount(generatePrivateKey()).address;
    const now = 1_800_000_000;
    for (const t of MANDATE_TEMPLATES) {
      const p = templateToParams(t, agent, { now });
      expect(p.perTxCap).toBeGreaterThan(0n);
      expect(p.perTxCap <= p.periodCap && p.periodCap <= p.totalCap).toBe(true);
      expect(p.approvalThreshold <= p.perTxCap).toBe(true);
      if (p.approvalThreshold > 0n) expect(p.approvalWindow).toBeGreaterThan(0);
      expect(p.expiry - now).toBeLessThanOrEqual(365 * 86400);
      expect(p.validAfter).toBeLessThan(now);
    }
  });
});

describe("getLogsChunked", () => {
  const mk = (fail?: (from: bigint, to: bigint) => boolean) => {
    const calls: [bigint, bigint][] = [];
    const publicClient = {
      getLogs: vi.fn(async ({ fromBlock, toBlock }: any) => {
        calls.push([fromBlock, toBlock]);
        if (fail?.(fromBlock, toBlock)) throw new Error("range too large");
        return [{ blockNumber: fromBlock }];
      }),
    } as unknown as PublicClient;
    return { publicClient, calls };
  };
  it("never asks for more than 1,000 blocks and covers the range exactly once", async () => {
    const { publicClient, calls } = mk();
    await getLogsChunked({ publicClient, address: "0x0000000000000000000000000000000000000001", fromBlock: 100n, toBlock: 3500n });
    expect(calls.length).toBe(4);
    for (const [f, t] of calls) expect(t - f + 1n).toBeLessThanOrEqual(1000n);
    expect(calls[0]![0]).toBe(100n);
    expect(calls.at(-1)![1]).toBe(3500n);
    for (let i = 1; i < calls.length; i++) expect(calls[i]![0]).toBe(calls[i - 1]![1] + 1n);
  });
  it("halves a range the node still refuses", async () => {
    const { publicClient, calls } = mk((f, t) => t - f + 1n > 300n);
    const logs = await getLogsChunked({ publicClient, address: "0x0000000000000000000000000000000000000001", fromBlock: 0n, toBlock: 999n });
    expect(logs.length).toBeGreaterThan(1);
    expect(calls.filter(([f, t]) => t - f + 1n <= 300n).length).toBeGreaterThan(0);
  });
  it("gives up on a single block that fails", async () => {
    const { publicClient } = mk(() => true);
    await expect(getLogsChunked({ publicClient, address: "0x0000000000000000000000000000000000000001", fromBlock: 5n, toBlock: 5n })).rejects.toThrow("range too large");
  });
  it("ignores logs that are not vault events", () => {
    expect(decodeAuditLogs([{ address: "0x0000000000000000000000000000000000000001", topics: ["0x1234"], data: "0x", blockNumber: 1n, logIndex: 0, transactionHash: "0x00" } as any])).toEqual([]);
  });
});
