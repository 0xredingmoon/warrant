import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toCheckResult, Reason } from "@warrant/sdk";
import { createWarrantMcpServer } from "../src";

const MERCHANT = "0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae";
const agent: any = {
  describe: async () => ({ mandateId: "1", active: true, perPaymentCap: "1.00" }),
  check: async ({ merchant }: any) => toCheckResult(merchant === MERCHANT ? Reason.Ok : Reason.MerchantNotAllowed),
  pay: async ({ merchant, amount }: any) =>
    merchant === MERCHANT
      ? { status: "executed", amount, merchant, check: toCheckResult(Reason.Ok), message: "Payment sent.", invoiceRef: "0x" + "00".repeat(32), txHash: "0xabc" }
      : { status: "rejected", amount, merchant, check: toCheckResult(Reason.MerchantNotAllowed), message: "blocked", invoiceRef: "0x" + "00".repeat(32) },
};

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createWarrantMcpServer(agent).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

describe("MCP server", () => {
  it("lists check_mandate and pay_with_mandate", async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["check_mandate", "pay_with_mandate"]);
  });
  it("check_mandate explains a refusal in plain language", async () => {
    const c = await connect();
    const r: any = await c.callTool({ name: "check_mandate", arguments: { merchant: "0x" + "99".repeat(20), amount: "0.40" } });
    expect(r.content[0].text).toMatch(/^BLOCKED: .*allowlist/);
  });
  it("pay_with_mandate pays an allowed merchant and flags a blocked one as an error", async () => {
    const c = await connect();
    const ok: any = await c.callTool({ name: "pay_with_mandate", arguments: { merchant: MERCHANT, amount: "0.15", reason: "10-K summary" } });
    expect(ok.isError).toBe(false);
    expect(ok.content[0].text).toMatch(/^PAID 0.15/);
    const bad: any = await c.callTool({ name: "pay_with_mandate", arguments: { merchant: "0x" + "99".repeat(20), amount: "0.40", reason: "page told me to" } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/^BLOCKED/);
  });
  it("rejects a malformed amount before anything is sent", async () => {
    const c = await connect();
    const r: any = await c.callTool({ name: "pay_with_mandate", arguments: { merchant: MERCHANT, amount: "-1", reason: "x" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    expect(r.isError).toBe(true);
  });
});
