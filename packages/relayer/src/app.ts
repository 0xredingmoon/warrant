import express, { type NextFunction, type Request, type Response } from "express";
import { createPublicClient, createWalletClient, getAddress, http, isAddress, isHex, parseEventLogs, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeRejection,
  explainError,
  toCheckResult,
  txUrl,
  warrantFactoryAbi,
  warrantVaultAbi,
  Reason,
} from "@warrant/sdk";
import { z } from "zod";
import { isLocalRpc, PUBLIC_DEV_KEYS, type RelayerConfig } from "./config";

const addr = z.string().refine(isAddress, "invalid address").transform((a) => getAddress(a));
const hex = z.string().refine((s) => isHex(s), "invalid hex").transform((s) => s as Hex);
const hex32 = hex.refine((s) => s.length === 66, "must be 32 bytes");
const big = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return BigInt(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid integer" });
    return z.NEVER;
  }
});

const intentSchema = z.object({
  mandateId: big,
  merchant: addr,
  amount: big,
  invoiceRef: hex32,
  intentHash: hex32,
  nonce: hex32,
  deadline: big,
});
const paySchema = z.object({ vault: addr, intent: intentSchema, signature: hex });
const approveSchema = z.object({ vault: addr, pendingId: big, deadline: big, signature: hex });
const depositSchema = z.object({
  vault: addr,
  from: addr,
  amount: big,
  validAfter: big,
  validBefore: big,
  nonce: hex32,
  signature: hex,
});

class SlidingWindow {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  take(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

export interface RelayerApp {
  app: express.Express;
  relayerAddress: Address;
}

/**
 * Guard rails (the relayer pays gas for anyone who can sign an intent, so it is deliberately boring):
 *  - only vaults deployed by the configured factory, only `pay` / `approveBySig` / `depositWithAuthorization`
 *  - free on-chain dry run first (`check`): refused payments cost no gas
 *  - per-IP and per-vault rate limits, a daily transaction cap, an optional bearer key
 *  - one in-flight submission per (vault, merchant, invoice); transactions are sent one at a time (no nonce races)
 *  - refuses well-known public dev keys unless the RPC is local
 * Limits live in memory: put the relayer behind one process, or move them to a shared store before scaling out.
 */
export function createRelayerApp(cfg: RelayerConfig): RelayerApp {
  if (PUBLIC_DEV_KEYS.has(cfg.privateKey.toLowerCase()) && !isLocalRpc(cfg.rpcUrl)) {
    throw new Error("Refusing to use a public dev key (anvil/hardhat) against a non-local RPC");
  }
  const account = privateKeyToAccount(cfg.privateKey);
  const chain: Chain = {
    id: cfg.chainId,
    name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });

  const ipLimit = new SlidingWindow(cfg.ratePerMinuteIp, 60_000);
  const vaultLimit = new SlidingWindow(cfg.ratePerMinuteVault, 60_000);
  let txToday = 0;
  let dayKey = new Date().toISOString().slice(0, 10);
  const inflight = new Set<string>();
  const knownVaults = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const clientIp = (req: Request) => {
    if (cfg.trustedIpHeader) {
      const h = req.headers[cfg.trustedIpHeader];
      const v = Array.isArray(h) ? h[0] : h;
      if (v) return v.split(",")[0]!.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  async function assertWarrantVault(vault: Address) {
    if (knownVaults.has(vault)) return;
    const ok = await publicClient.readContract({
      address: cfg.factory,
      abi: warrantFactoryAbi,
      functionName: "isVault",
      args: [vault],
    });
    if (!ok) throw new HttpError(400, "That address is not a vault deployed by the Warrant factory.");
    knownVaults.add(vault);
  }

  function takeDailyBudget() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dayKey) {
      dayKey = today;
      txToday = 0;
    }
    if (txToday >= cfg.dailyTxCap) throw new HttpError(429, "The relayer reached its daily transaction cap. Try again tomorrow.");
    txToday += 1;
  }

  async function sendLegacy(vault: Address, functionName: string, args: readonly unknown[], gas: bigint) {
    return serial(async () => {
      const gasPrice = ((await publicClient.getGasPrice()) * 12n) / 10n;
      const sim = await publicClient.simulateContract({ account, address: vault, abi: warrantVaultAbi, functionName, args } as any);
      const hash = await walletClient.writeContract({ ...(sim.request as any), type: "legacy", gasPrice, gas, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { hash, receipt };
    });
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    // permissive CORS: agents and UIs call from anywhere; auth is the signature (and the optional API key)
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  const guard = (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === "POST") {
      if (cfg.apiKey && req.headers.authorization !== `Bearer ${cfg.apiKey}`) return next(new HttpError(401, "Missing or wrong API key."));
      if (!ipLimit.take(clientIp(req))) return next(new HttpError(429, "Too many requests. Slow down."));
    }
    next();
  };
  app.use(guard);

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  app.get("/health", wrap(async (_req, res) => {
    const balance = await publicClient.getBalance({ address: account.address });
    res.json({ ok: true, chainId: cfg.chainId, relayer: account.address, factory: cfg.factory, balance: balance.toString(), txToday });
  }));

  /** Free dry run: what would happen to this signed intent? */
  app.post("/v1/check", wrap(async (req, res) => {
    const { vault, intent, signature } = paySchema.parse(req.body);
    await assertWarrantVault(vault);
    const code = Number(await publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "check", args: [intent, signature] }));
    res.json({ check: toCheckResult(code) });
  }));

  app.post("/v1/pay", wrap(async (req, res) => {
    const { vault, intent, signature } = paySchema.parse(req.body);
    await assertWarrantVault(vault);
    if (!vaultLimit.take(vault)) throw new HttpError(429, "Too many payments for this vault. Slow down.");

    // 1. free dry run: refusals never cost gas
    const code = Number(await publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "check", args: [intent, signature] }));
    const check = toCheckResult(code);
    if (!check.accepted) {
      res.status(200).json({ status: "rejected", check });
      return;
    }

    // 2. one in-flight submission per invoice
    const key = `${vault}:${intent.merchant}:${intent.invoiceRef}`.toLowerCase();
    if (inflight.has(key)) {
      res.status(200).json({ status: "rejected", check: toCheckResult(Reason.InvoiceAlreadyUsed) });
      return;
    }
    inflight.add(key);
    try {
      takeDailyBudget();
      const { hash, receipt } = await sendLegacy(vault, "pay", [intent, signature], 700_000n);
      const queued = parseEventLogs({ abi: warrantVaultAbi, logs: receipt.logs, eventName: "PaymentQueued" })[0];
      res.json({
        status: queued ? "queued" : "executed",
        check,
        txHash: hash,
        explorerUrl: txUrl(hash, cfg.explorerUrl),
        pendingId: queued ? queued.args.pendingId.toString() : undefined,
      });
    } catch (e) {
      // state may have moved between the dry run and inclusion: report the on-chain reason if there is one
      const rejected = decodeRejection(e);
      if (rejected) {
        res.status(200).json({ status: "rejected", check: toCheckResult(rejected.code) });
        return;
      }
      throw e;
    } finally {
      inflight.delete(key);
    }
  }));

  app.post("/v1/approve", wrap(async (req, res) => {
    const { vault, pendingId, deadline, signature } = approveSchema.parse(req.body);
    await assertWarrantVault(vault);
    if (!vaultLimit.take(vault)) throw new HttpError(429, "Too many requests for this vault.");
    takeDailyBudget();
    try {
      const { hash } = await sendLegacy(vault, "approveBySig", [pendingId, deadline, signature], 700_000n);
      res.json({ status: "executed", txHash: hash, explorerUrl: txUrl(hash, cfg.explorerUrl) });
    } catch (e) {
      res.status(200).json({ status: "failed", error: explainError(e) });
    }
  }));

  app.post("/v1/deposit", wrap(async (req, res) => {
    const b = depositSchema.parse(req.body);
    await assertWarrantVault(b.vault);
    if (!vaultLimit.take(b.vault)) throw new HttpError(429, "Too many requests for this vault.");
    takeDailyBudget();
    const sig = b.signature.slice(2);
    if (sig.length !== 130) throw new HttpError(400, "signature must be 65 bytes");
    const r = ("0x" + sig.slice(0, 64)) as Hex;
    const s = ("0x" + sig.slice(64, 128)) as Hex;
    const v = parseInt(sig.slice(128, 130), 16);
    try {
      const { hash } = await sendLegacy(b.vault, "depositWithAuthorization", [b.from, b.amount, b.validAfter, b.validBefore, b.nonce, v, r, s], 400_000n);
      res.json({ status: "executed", txHash: hash, explorerUrl: txUrl(hash, cfg.explorerUrl) });
    } catch (e) {
      res.status(200).json({ status: "failed", error: explainError(e) });
    }
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof z.ZodError) {
      return void res.status(400).json({ error: "Invalid request: " + err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") });
    }
    console.error("[relayer]", err);
    res.status(500).json({ error: explainError(err) });
  });

  return { app, relayerAddress: account.address };
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
