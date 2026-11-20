import express, { type NextFunction, type Request, type Response } from "express";
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, isHex, parseEventLogs, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeRejection,
  explainError,
  isRecordableRefusal,
  toCheckResult,
  txUrl,
  warrantFactoryAbi,
  warrantVaultAbi,
  Reason,
  RPC_HTTP,
  type CheckResult,
  type PaymentIntent,
} from "@warrant/sdk";
import { RateStore, openDb } from "@warrant/store";
import { z } from "zod";
import { isLocalRpc, PUBLIC_DEV_KEYS, type RelayerConfig } from "./config";
import { SettlementStore } from "./settlements";
import { mountFacilitator } from "./x402";

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
  /** false: answer as soon as the transaction is broadcast (status "submitted") instead of after it is mined */
  wait: z.boolean().optional(),
});

export interface RelayerApp {
  app: express.Express;
  relayerAddress: Address;
  /** close the SQLite file (tests, graceful shutdown) */
  close: () => void;
}

export interface SubmitResult {
  /** executed: money moved. queued: waiting for the owner. refused: recorded on-chain, nothing moved. rejected: not submitted. */
  status: "executed" | "queued" | "refused" | "rejected";
  check: CheckResult;
  txHash?: Hex;
  explorerUrl?: string;
  pendingId?: string;
  blockNumber?: bigint;
  /** why a refusal was not recorded on-chain (rate limit) */
  note?: string;
}

/**
 * Guard rails (the relayer pays gas for anyone who can sign an intent, so it is deliberately boring):
 *  - only vaults deployed by the configured factory, only `pay` / `approveBySig` / `depositWithAuthorization`
 *  - free on-chain dry run first (`check`): refused payments cost no gas
 *  - per-IP and per-vault rate limits, a daily transaction cap, an optional bearer key, all kept in SQLite so they survive a restart
 *  - refusals are recorded on-chain only for intents carrying the agent's valid signature (the vault enforces that
 *    too), with their own per-vault hourly and daily budgets
 *  - one in-flight submission per (vault, merchant, invoice); transactions are sent one at a time (no nonce races)
 *  - refuses well-known public dev keys unless the RPC is local
 * State lives in one SQLite file (`cfg.dbPath`): run one relayer process per file.
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
  // Aevum's public RPC answers in ~0.3 s but now and then stalls. A short per-call timeout with quick retries bounds
  // that tail (the default 45 s timeout turned one stalled call into a minute-long deposit).
  const rpcTransport = http(cfg.rpcUrl, { timeout: 8_000, retryCount: 4, retryDelay: 300 });
  const publicClient = createPublicClient({ chain, transport: rpcTransport });

  const db = openDb(cfg.dbPath);
  const rates = new RateStore(db);
  const settlements = new SettlementStore(db);
  rates.prune();
  const pruneTimer = setInterval(() => rates.prune(), 3600_000);
  pruneTimer.unref();
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
    if (!rates.takeDaily("tx", cfg.dailyTxCap)) throw new HttpError(429, "The relayer reached its daily transaction cap. Try again tomorrow.");
  }

  /**
   * Sign and broadcast one transaction. Sends are serialised, but waiting for the receipt is not part of the lock.
   * The nonce is the node's pending count, and the lock is kept until the node reports the new transaction as pending,
   * so the next send cannot reuse the nonce. (No local nonce counter: if a transaction is ever dropped, a counter
   * would leave every later one waiting behind a gap.)
   */
  async function broadcast(vault: Address, functionName: string, args: readonly unknown[], gas: bigint): Promise<Hex> {
    return serial(async () => {
      // the three reads are independent: wait for the slowest, not the sum
      const [price, , nonce] = await Promise.all([
        publicClient.getGasPrice(),
        publicClient.simulateContract({ account, address: vault, abi: warrantVaultAbi, functionName, args } as any),
        publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
      ]);
      // sign locally and send the raw transaction: no extra eth_chainId / eth_estimateGas round trips
      const data = encodeFunctionData({ abi: warrantVaultAbi, functionName, args } as any);
      const raw = await account.signTransaction({ type: "legacy", chainId: cfg.chainId, to: vault, data, gas, gasPrice: (price * 12n) / 10n, nonce, value: 0n });
      const hash = await publicClient.sendRawTransaction({ serializedTransaction: raw });
      for (let i = 0; i < 20; i++) {
        const seen = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }).catch(() => nonce);
        if (seen > nonce) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      return hash;
    });
  }

  const RECEIPT_TIMEOUT_MS = 90_000;
  async function mined(hash: Hex) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: 1000 });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return receipt;
  }

  async function sendLegacy(vault: Address, functionName: string, args: readonly unknown[], gas: bigint) {
    const hash = await broadcast(vault, functionName, args, gas);
    const receipt = await mined(hash);
    return { hash, receipt };
  }

  const log = (route: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), route, ...fields }));

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
      if (!rates.take("ip", clientIp(req), cfg.ratePerMinuteIp, 60_000)) return next(new HttpError(429, "Too many requests. Slow down."));
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
    res.json({ ok: true, chainId: cfg.chainId, relayer: account.address, factory: cfg.factory, balance: balance.toString(), txToday: rates.today("tx"), refusalsToday: rates.today("refusal") });
  }));

  /** Free dry run: what would happen to this signed intent? */
  app.post("/v1/check", wrap(async (req, res) => {
    const { vault, intent, signature } = paySchema.parse(req.body);
    await assertWarrantVault(vault);
    const code = Number(await publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "check", args: [intent, signature] }));
    res.json({ check: toCheckResult(code) });
  }));

  /**
   * Submit an agent-signed intent with `payOrRefuse`: it pays, queues for the owner, or (when the mandate says no)
   * records the refusal on-chain. Anything that is not authentic (bad signature, expired, replayed) is never sent.
   */
  async function submitIntent(vault: Address, intent: PaymentIntent, signature: Hex): Promise<SubmitResult> {
    await assertWarrantVault(vault);
    if (!rates.take("vault", vault, cfg.ratePerMinuteVault, 60_000)) throw new HttpError(429, "Too many payments for this vault. Slow down.");

    // 1. free dry run: authenticity first, then the rules
    const code = Number(await publicClient.readContract({ address: vault, abi: warrantVaultAbi, functionName: "check", args: [intent, signature] }));
    const check = toCheckResult(code);
    let record = false;
    if (!check.accepted) {
      if (!isRecordableRefusal(code)) return { status: "rejected", check };
      if (!rates.take("refusal-vault", vault, cfg.refusalsPerHourVault, 3600_000) || !rates.takeDaily("refusal", cfg.dailyRefusalCap)) {
        return { status: "rejected", check, note: "Refusal not recorded on-chain: the relayer's refusal budget for this vault is used up." };
      }
      record = true;
    }

    // 2. one in-flight submission per invoice
    const key = `${vault}:${intent.merchant}:${intent.invoiceRef}`.toLowerCase();
    if (inflight.has(key)) return { status: "rejected", check: toCheckResult(Reason.InvoiceAlreadyUsed) };
    inflight.add(key);
    try {
      if (!record) takeDailyBudget();
      const { hash, receipt } = await sendLegacy(vault, "payOrRefuse", [intent, signature], 700_000n);
      const logs = parseEventLogs({ abi: warrantVaultAbi, logs: receipt.logs });
      const base = { txHash: hash, explorerUrl: txUrl(hash, cfg.explorerUrl), blockNumber: receipt.blockNumber };
      const refused = logs.find((l) => l.eventName === "PaymentRefused") as any;
      if (refused) return { status: "refused", check: toCheckResult(Number(refused.args.reason)), ...base };
      const queued = logs.find((l) => l.eventName === "PaymentQueued") as any;
      if (queued) return { status: "queued", check, pendingId: queued.args.pendingId.toString(), ...base };
      return { status: "executed", check, ...base };
    } catch (e) {
      // state may have moved between the dry run and inclusion: report the on-chain reason if there is one
      const rejected = decodeRejection(e);
      if (rejected) return { status: "rejected", check: toCheckResult(rejected.code) };
      throw e;
    } finally {
      inflight.delete(key);
    }
  }

  app.post("/v1/pay", wrap(async (req, res) => {
    const { vault, intent, signature } = paySchema.parse(req.body);
    const r = await submitIntent(vault, intent, signature);
    res.status(200).json({ ...r, blockNumber: undefined, pendingId: r.pendingId });
  }));

  app.post("/v1/approve", wrap(async (req, res) => {
    const { vault, pendingId, deadline, signature } = approveSchema.parse(req.body);
    await assertWarrantVault(vault);
    if (!rates.take("vault", vault, cfg.ratePerMinuteVault, 60_000)) throw new HttpError(429, "Too many requests for this vault.");
    takeDailyBudget();
    try {
      const { hash } = await sendLegacy(vault, "approveBySig", [pendingId, deadline, signature], 700_000n);
      res.json({ status: "executed", txHash: hash, explorerUrl: txUrl(hash, cfg.explorerUrl) });
    } catch (e) {
      res.status(200).json({ status: "failed", error: explainError(e) });
    }
  }));

  // one broadcast per signed authorization: sending the same one again returns the first answer instead of a second transaction
  const depositJobs = new Map<string, Promise<Hex>>();

  app.post("/v1/deposit", wrap(async (req, res) => {
    const b = depositSchema.parse(req.body);
    const t0 = Date.now();
    await assertWarrantVault(b.vault);
    if (!rates.take("vault", b.vault, cfg.ratePerMinuteVault, 60_000)) throw new HttpError(429, "Too many requests for this vault.");
    const sig = b.signature.slice(2);
    if (sig.length !== 130) throw new HttpError(400, "signature must be 65 bytes");
    const r = ("0x" + sig.slice(0, 64)) as Hex;
    const s = ("0x" + sig.slice(64, 128)) as Hex;
    const v = parseInt(sig.slice(128, 130), 16);
    const key = `${b.from}:${b.nonce}`.toLowerCase();
    let job = depositJobs.get(key);
    const duplicate = !!job;
    if (!job) {
      takeDailyBudget();
      job = broadcast(b.vault, "depositWithAuthorization", [b.from, b.amount, b.validAfter, b.validBefore, b.nonce, v, r, s], 400_000n);
      depositJobs.set(key, job);
      job.catch(() => depositJobs.delete(key));
      setTimeout(() => depositJobs.delete(key), 600_000).unref();
    }
    try {
      const hash = await job;
      const tSent = Date.now();
      if (b.wait === false) {
        void mined(hash).then(
          () => log("deposit", { hash, sentMs: tSent - t0, minedMs: Date.now() - t0 }),
          (e) => log("deposit", { hash, error: explainError(e) }),
        );
        res.json({ status: "submitted", txHash: hash, explorerUrl: txUrl(hash, cfg.explorerUrl), duplicate });
        return;
      }
      await mined(hash);
      log("deposit", { hash, sentMs: tSent - t0, minedMs: Date.now() - t0, duplicate });
      res.json({ status: "executed", txHash: hash, explorerUrl: txUrl(hash, cfg.explorerUrl), duplicate });
    } catch (e) {
      log("deposit", { error: explainError(e), ms: Date.now() - t0 });
      res.status(200).json({ status: "failed", error: explainError(e) });
    }
  }));

  mountFacilitator(app, { cfg, publicClient, relayerAddress: account.address, assertWarrantVault, submitIntent, settlements, wrap });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof z.ZodError) {
      return void res.status(400).json({ error: "Invalid request: " + err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") });
    }
    console.error("[relayer]", err);
    res.status(500).json({ error: explainError(err) });
  });

  return { app, relayerAddress: account.address, close: () => {
      clearInterval(pruneTimer);
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
