import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import type { WarrantAgent } from "@warrant/sdk";

const addressArg = z
  .string()
  .refine(isAddress, "must be a 0x… address")
  .transform((a) => getAddress(a));
const amountArg = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'decimal tUSD8 amount with up to 6 decimals, e.g. "4.50"');
const invoiceArg = z
  .string()
  .refine((s) => isHex(s) && s.length === 66, "must be a 32-byte hex string (0x + 64 hex chars)")
  .transform((s) => s as Hex);

const text = (obj: unknown, summary: string, isError = false) => ({
  content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(obj, null, 2)}` }],
  isError,
});

/**
 * Build an MCP server around a WarrantAgent. The agent can only spend within its mandate: even if a prompt injection
 * convinces the model to call pay_with_mandate with an attacker's address, the vault refuses and the model is told why.
 */
export function createWarrantMcpServer(agent: WarrantAgent, info = { name: "warrant", version: "0.1.0" }) {
  const server = new McpServer(info);

  server.registerTool(
    "check_mandate",
    {
      title: "Check a payment against the spending mandate",
      description:
        "Read-only and free. Shows what the owner's spending mandate allows (per-payment cap, period cap, total cap, expiry, approval threshold) " +
        "and what is left. If you pass a merchant and an amount, it also dry-runs that exact payment and tells you in plain language whether " +
        "it would go through, wait for the owner's approval, or be blocked and why. Call this before pay_with_mandate when unsure.",
      inputSchema: {
        merchant: addressArg.optional().describe("merchant address you plan to pay"),
        amount: amountArg.optional().describe("tUSD8 amount you plan to pay, e.g. \"4.50\""),
        invoice_ref: invoiceArg.optional().describe("the merchant's invoice id, if you have one"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ merchant, amount, invoice_ref }) => {
      try {
        const mandate = await agent.describe(merchant as Address | undefined);
        if (merchant && amount) {
          const result = await agent.check({ merchant: merchant as Address, amount, invoiceRef: invoice_ref as Hex | undefined });
          const verdict = result.ok ? "ALLOWED" : result.accepted ? "NEEDS OWNER APPROVAL" : "BLOCKED";
          return text({ mandate, check: result }, `${verdict}: ${result.message}`, false);
        }
        return text({ mandate }, mandate.active ? "Mandate is active." : "Mandate is NOT active (revoked, expired or not started).");
      } catch (e) {
        return text({ error: String((e as Error).message ?? e) }, "Could not read the mandate.", true);
      }
    },
  );

  server.registerTool(
    "pay_with_mandate",
    {
      title: "Pay a merchant in tUSD8 under the spending mandate",
      description:
        "Pays a merchant in tUSD8 from the owner's vault, strictly within the mandate the owner set. The vault enforces the rules on-chain: " +
        "only allow-listed merchants, caps, expiry, and an owner approval step for larger amounts. You cannot override any of that. " +
        "If the payment is blocked, the result says why in plain language: tell the user, do not try to work around it. " +
        "Use a stable invoice_ref when retrying so the same invoice is never paid twice.",
      inputSchema: {
        merchant: addressArg.describe("merchant address to pay"),
        amount: amountArg.describe("tUSD8 amount, e.g. \"4.50\""),
        reason: z.string().max(2000).describe("why you are paying (hashed on-chain for the audit trail)"),
        invoice_ref: invoiceArg.optional().describe("the merchant's invoice id; a random one is used if omitted"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ merchant, amount, reason, invoice_ref }) => {
      try {
        const r = await agent.pay({ merchant: merchant as Address, amount, invoiceRef: invoice_ref as Hex | undefined, context: reason });
        const head =
          r.status === "executed"
            ? `PAID ${r.amount} tUSD8 to ${r.merchant}.`
            : r.status === "queued"
              ? `QUEUED: ${r.amount} tUSD8 to ${r.merchant} is waiting for the owner's approval (pending #${r.pendingId}).`
              : `BLOCKED: ${r.check.message}`;
        return text(r, head, r.status === "rejected");
      } catch (e) {
        return text({ error: String((e as Error).message ?? e) }, "The payment could not be submitted.", true);
      }
    },
  );

  return server;
}
