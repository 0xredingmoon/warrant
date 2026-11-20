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
  explainError,
  isUnauthorized,
  isUserRejection,
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

  it("have lifetime totals that fit the validity period and say tUSD8 where they name amounts", () => {
    for (const t of MANDATE_TEMPLATES) {
      const periods = Math.ceil((t.durationDays * 24) / t.periodHours);
      expect(Number(t.total)).toBeLessThanOrEqual(Number(t.period) * periods);
      expect(Number(t.total)).toBeGreaterThanOrEqual(Number(t.period));
      expect(t.description).toMatch(/tUSD8/);
    }
  });
});

describe("wallet errors", () => {
  it("tells a rejection from an access problem and explains both plainly", () => {
    const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const unauthorized = Object.assign(new Error("The requested method and/or account has not been authorized by the user."), { code: 4100 });
    expect(isUserRejection(rejected)).toBe(true);
    expect(isUnauthorized(rejected)).toBe(false);
    expect(isUnauthorized(unauthorized)).toBe(true);
    expect(isUnauthorized({ cause: unauthorized })).toBe(true);
    expect(explainError(unauthorized)).not.toMatch(/requested method/i);
    expect(explainError(unauthorized)).toMatch(/Connect the wallet again/);
    expect(explainError(rejected)).toBe("You rejected the request in your wallet. Nothing was sent.");
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

/* ------------------------------------------------------------------ new in this round */

import { encodeAbiParameters, encodeEventTopics } from "viem";
import {
  X402_HEADERS,
  decodeHeader,
  encodeHeader,
  getAuditLog,
  getLogsFromIndexer,
  isRecordableRefusal,
  paymentRequired,
  readPaymentHeader,
  snake,
  warrantVaultAbi,
  x402Network,
  chainIdFromNetwork,
} from "../src";

describe("refusals", () => {
  it("records only refusals of authentic intents", () => {
    const recordable = Object.entries(Reason).filter(([, c]) => isRecordableRefusal(c)).map(([n]) => n);
    expect(recordable).toEqual([
      "MandateRevoked", "VaultFrozen", "NotYetValid", "MandateExpired", "MerchantNotAllowed", "ZeroAmount", "ExceedsPerTxCap",
      "ExceedsMerchantPerTxCap", "ExceedsPeriodCap", "ExceedsMerchantTotalCap", "ExceedsTotalCap", "InvoiceAlreadyUsed", "InsufficientBalance",
    ]);
  });
});

const VAULT = "0x927d8b1030E90d94039b3281A3E4b415E11c6aba" as const;
const MERCHANT = "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae" as const;
const b32 = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;

function refusedRaw(block: number, logIndex: number) {
  const topics = encodeEventTopics({ abi: warrantVaultAbi, eventName: "PaymentRefused", args: { mandateId: 1n, agent: MERCHANT, merchant: MERCHANT } });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [2_500_000n, 7, b32(1), b32(2)]);
  return {
    address: VAULT.toLowerCase(),
    blockNumber: "0x" + block.toString(16),
    logIndex: "0x" + logIndex.toString(16),
    transactionHash: b32(block * 100 + logIndex),
    data,
    topics: [...topics, null],
  };
}

describe("audit log sources", () => {
  it("decodes PaymentRefused with the reason in plain language", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: any) => {
      calls.push(String(u));
      return new Response(JSON.stringify({ message: "OK", result: [refusedRaw(10, 0)] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const entries = await getLogsFromIndexer({ indexerUrl: "https://x.test/", address: VAULT, fromBlock: 5n, toBlock: 99n });
    vi.unstubAllGlobals();
    expect(calls[0]).toBe(`https://x.test/api?module=logs&action=getLogs&fromBlock=5&toBlock=99&address=${VAULT}`);
    const [e] = decodeAuditLogs(entries);
    expect(e!.kind).toBe("PaymentRefused");
    expect(e!.summary).toMatch(/^Refused 2\.50 tUSD8 to 0xf2b0…b4Ae under mandate #1: That recipient is not on this mandate's merchant allowlist/);
  });

  it("pages when the explorer answers a full page and drops duplicates", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => refusedRaw(10 + Math.floor(i / 10), i % 10));
    const second = [...full.slice(-10), refusedRaw(200, 0)];
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: any) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ message: "OK", result: urls.length === 1 ? full : second }));
    });
    const logs = await getLogsFromIndexer({ indexerUrl: "https://x.test", address: VAULT, fromBlock: 1n, toBlock: 300n });
    vi.unstubAllGlobals();
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain("fromBlock=109"); // resumes from the last block seen
    expect(logs.length).toBe(1001);
  });

  it("uses the explorer for history plus the RPC for the newest blocks, and falls back to the RPC if the explorer fails", async () => {
    const rpcCalls: Array<[bigint, bigint]> = [];
    const publicClient = {
      getBlockNumber: async () => 5000n,
      getLogs: async ({ fromBlock, toBlock }: any) => {
        rpcCalls.push([fromBlock, toBlock]);
        return [];
      },
    } as unknown as PublicClient;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "OK", result: [refusedRaw(10, 0)] })));
    let source = "";
    const viaIndexer = await getAuditLog({ publicClient, vault: VAULT, fromBlock: 1n, indexerUrl: "https://x.test", tailBlocks: 500n, onSource: (s) => (source = s) });
    expect(source).toBe("indexer");
    expect(viaIndexer.map((e) => e.kind)).toEqual(["PaymentRefused"]);
    expect(rpcCalls).toEqual([[4501n, 4999n + 1n]]); // only the last 500 blocks hit the RPC (one ≤1000-block chunk)

    rpcCalls.length = 0;
    vi.stubGlobal("fetch", async () => new Response("bad gateway", { status: 502 }));
    await getAuditLog({ publicClient, vault: VAULT, fromBlock: 1n, indexerUrl: "https://x.test", onSource: (s) => (source = s) });
    vi.unstubAllGlobals();
    expect(source).toBe("rpc");
    expect(rpcCalls.length).toBe(5); // 5,000 blocks in 1,000-block chunks
  });
});

describe("x402 helpers", () => {
  it("round-trips base64 JSON headers, including non-ASCII text", () => {
    const v = { a: 1, text: "café ✓", nested: { n: ["x"] } };
    expect(decodeHeader(encodeHeader(v))).toEqual(v);
  });

  it("names networks both ways", () => {
    expect(x402Network(44005, 1)).toBe("aevum-testnet");
    expect(x402Network(44005, 2)).toBe("eip155:44005");
    expect(x402Network(8453, 1)).toBe("eip155:8453");
    expect(chainIdFromNetwork("aevum-testnet")).toBe(44005);
    expect(chainIdFromNetwork("eip155:44005")).toBe(44005);
    expect(chainIdFromNetwork("solana")).toBeUndefined();
  });

  it("builds a 402 that carries both wire versions", () => {
    const { body, headers } = paymentRequired({ invoiceRef: b32(1), amount: 150_000n, payTo: MERCHANT, token: "0x456569838f1d43009A91ebA4263147Afd7233483", chainId: 44005, resource: "https://api.test/x", description: "d", ttlSeconds: 900 });
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]).toMatchObject({ scheme: "warrant", network: "aevum-testnet", maxAmountRequired: "150000", resource: "https://api.test/x" });
    const v2 = decodeHeader<any>(headers[X402_HEADERS.v2.required]);
    expect(v2.accepts[0]).toMatchObject({ scheme: "warrant", network: "eip155:44005", amount: "150000" });
    expect(v2.resource.url).toBe("https://api.test/x");
  });

  it("reads either payment header and rejects garbage", () => {
    const payload = { x402Version: 1, payload: { vault: VAULT } };
    expect(readPaymentHeader((n) => (n === "X-PAYMENT" ? encodeHeader(payload) : undefined))).toEqual(payload);
    expect(readPaymentHeader((n) => (n === "PAYMENT-SIGNATURE" ? encodeHeader({ ...payload, x402Version: 2 }) : undefined))).toMatchObject({ x402Version: 2 });
    expect(readPaymentHeader(() => undefined)).toBeUndefined();
    expect(() => readPaymentHeader(() => "%%%")).toThrow();
    expect(() => readPaymentHeader(() => encodeHeader({ nope: true }))).toThrow(/malformed/);
  });

  it("snake-cases reason names", () => {
    expect(snake("ExceedsPeriodCap")).toBe("exceeds_period_cap");
    expect(snake("MerchantNotAllowed")).toBe("merchant_not_allowed");
  });
});
