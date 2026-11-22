import { createPublicClient, http, isAddress, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildIntent, signIntent, warrantVaultAbi, Reason, type CheckResult, type PaymentIntent } from "@warrant/sdk";
import { HttpError } from "./http-error";

/** What `submitIntent` answers: declared here so this module does not have to import the Express app. */
export interface SubmitResult {
  status: "executed" | "queued" | "refused" | "rejected";
  check: CheckResult;
  txHash?: Hex;
  explorerUrl?: string;
  pendingId?: string;
  blockNumber?: bigint;
  note?: string;
}

/**
 * "Try the attack" is a judge-facing demonstration: two hostile payments from a real agent key against a real
 * vault on Aevum, with nothing to install and no wallet. The relayer funds a small demonstration vault once, holds
 * the agent key for that vault, and only ever signs two fixed attacks against it:
 *
 *   overspend   an amount above the mandate's per-payment cap, to the allowed merchant
 *   offlist     an allowed amount to an address that is not on the merchant allowlist
 *
 * Both are authentic intents (the vault's own signature check passes) that the mandate's rules then refuse, so the
 * refusal is booked on-chain as `PaymentRefused` and is readable on the explorer. The relayer will not sign anything
 * else with this key, and the key holds no tQDAY: it cannot move money even if this service is wrong.
 */
export interface AttackDemoConfig {
  /** the vault's chain */
  chainId: number;
  /** the vault the attacks target */
  vault: Address;
  /** the mandate inside that vault */
  mandateId: bigint;
  /** the agent key for that mandate. It signs only the two fixed attacks below. */
  agentKey: Hex;
  /** the merchant the mandate allows, used as the target of the overspend attack */
  allowedMerchant: Address;
  /** an address the mandate does not allow, used as the target of the offlist attack */
  blockedMerchant: Address;
  /** amount that is above the mandate's per-payment cap, in tUSD8 base units */
  overspendAmount: bigint;
  /** amount that is within the cap but is sent to the blocked merchant */
  offlistAmount: bigint;
  /** only sign an attack again after this long, so one visitor cannot burn the daily refusal budget */
  cooldownSeconds: number;
}

export type AttackKind = "overspend" | "offlist";
export const ATTACK_KINDS: readonly AttackKind[] = ["overspend", "offlist"];

export function loadAttackDemoFromEnv(env: NodeJS.ProcessEnv = process.env): AttackDemoConfig | undefined {
  const vault = env.DEMO_VAULT;
  const key = env.DEMO_AGENT_KEY;
  if (!vault && !key) return undefined;
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`DEMO_VAULT and DEMO_AGENT_KEY must be set together (missing ${k})`);
    return v;
  };
  const address = (k: string): Address => {
    const v = need(k);
    if (!isAddress(v)) throw new Error(`${k} is not an address`);
    return v as Address;
  };
  const usd = (k: string, fallback: string) => parseUnits(env[k] ?? fallback, 6);
  const keyValue = need("DEMO_AGENT_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(keyValue)) throw new Error("DEMO_AGENT_KEY must be a 32-byte hex private key");
  return {
    chainId: Number(env.CHAIN_ID ?? 44005),
    vault: address("DEMO_VAULT"),
    mandateId: BigInt(env.DEMO_MANDATE_ID ?? "1"),
    agentKey: keyValue as Hex,
    allowedMerchant: address("DEMO_ALLOWED_MERCHANT"),
    blockedMerchant: env.DEMO_BLOCKED_MERCHANT && isAddress(env.DEMO_BLOCKED_MERCHANT)
      ? (env.DEMO_BLOCKED_MERCHANT as Address)
      : "0x000000000000000000000000000000000000dEaD",
    overspendAmount: usd("DEMO_OVERSPEND_AMOUNT", "250"),
    offlistAmount: usd("DEMO_OFFLIST_AMOUNT", "0.01"),
    cooldownSeconds: Number(env.DEMO_COOLDOWN_SECONDS ?? 20),
  };
}

export interface AttackStepResult {
  kind: AttackKind;
  /** what the agent tried, in plain language */
  attempted: string;
  /** the signed amount, formatted */
  amount: string;
  merchant: Address;
  /** the on-chain verdict from `submitIntent` */
  status: SubmitResult["status"];
  check: CheckResult;
  txHash?: Hex;
  explorerUrl?: string;
  note?: string;
}

export interface AttackDemoView {
  enabled: true;
  vault: Address;
  vaultUrl: string;
  mandateId: string;
  agent: Address;
  allowedMerchant: Address;
  blockedMerchant: Address;
  /** the mandate's terms as read from the vault right now */
  terms: {
    perTxCap: string;
    periodCap: string;
    totalCap: string;
    merchantPerTxCap: string;
    revoked: boolean;
    frozen: boolean;
    expired: boolean;
  };
  /** what the two attacks are, before anything is signed */
  attacks: { kind: AttackKind; attempted: string; amount: string; merchant: Address; expectedReason: string }[];
}

const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2);

export function createAttackDemo(cfg: AttackDemoConfig, publicClient: PublicClient, explorerUrl: string) {
  const agent = privateKeyToAccount(cfg.agentKey);
  /** A per-kind cooldown kept in this demo's memory: on a serverless host it is per warm instance, which is enough. */
  const lastRun = new Map<AttackKind, number>();

  const intentFor = (kind: AttackKind): PaymentIntent => {
    const amount = kind === "overspend" ? cfg.overspendAmount : cfg.offlistAmount;
    const merchant = kind === "overspend" ? cfg.allowedMerchant : cfg.blockedMerchant;
    const context =
      kind === "overspend"
        ? "A prompt-injected agent tries to move more than the mandate allows in one payment."
        : "A prompt-injected agent tries to pay an address the owner never approved.";
    // a fresh invoice reference and nonce each run: each attempt must be a new, authentic intent
    return buildIntent({ mandateId: cfg.mandateId, merchant, amount, context });
  };

  const describe = (kind: AttackKind) =>
    kind === "overspend"
      ? `Pay ${usd(cfg.overspendAmount)} tUSD8 to the allowed merchant, above the mandate's per-payment cap`
      : `Pay ${usd(cfg.offlistAmount)} tUSD8 to ${cfg.blockedMerchant.slice(0, 6)}..., an address the owner never allowed`;

  async function view(): Promise<AttackDemoView> {
    const [m, rule, frozen] = await Promise.all([
      publicClient.readContract({ address: cfg.vault, abi: warrantVaultAbi, functionName: "getMandate", args: [cfg.mandateId] }) as Promise<any>,
      publicClient.readContract({ address: cfg.vault, abi: warrantVaultAbi, functionName: "getMerchantRule", args: [cfg.mandateId, cfg.allowedMerchant] }) as Promise<any>,
      publicClient.readContract({ address: cfg.vault, abi: warrantVaultAbi, functionName: "frozen" }) as Promise<boolean>,
    ]);
    const p = m.params ?? m[0];
    const now = Math.floor(Date.now() / 1000);
    return {
      enabled: true,
      vault: cfg.vault,
      vaultUrl: `${explorerUrl}/address/${cfg.vault}`,
      mandateId: cfg.mandateId.toString(),
      agent: agent.address,
      allowedMerchant: cfg.allowedMerchant,
      blockedMerchant: cfg.blockedMerchant,
      terms: {
        perTxCap: usd(BigInt(p.perTxCap)),
        periodCap: usd(BigInt(p.periodCap)),
        totalCap: usd(BigInt(p.totalCap)),
        merchantPerTxCap: usd(BigInt(rule.perTxCap ?? 0n)),
        revoked: Boolean(m.revoked),
        frozen,
        expired: now >= Number(p.expiry),
      },
      attacks: ATTACK_KINDS.map((kind) => ({
        kind,
        attempted: describe(kind),
        amount: kind === "overspend" ? usd(cfg.overspendAmount) : usd(cfg.offlistAmount),
        merchant: kind === "overspend" ? cfg.allowedMerchant : cfg.blockedMerchant,
        expectedReason: kind === "overspend" ? "ExceedsPerTxCap" : "MerchantNotAllowed",
      })),
    };
  }

  /**
   * Sign and submit one fixed attack. `submit` is the relayer's own `/v1/pay` path, so the demonstration takes
   * exactly the route an agent would, including the free dry run and the on-chain refusal record.
   */
  async function run(
    kind: AttackKind,
    submit: (vault: Address, intent: PaymentIntent, signature: Hex) => Promise<SubmitResult>,
  ): Promise<AttackStepResult> {
    if (!ATTACK_KINDS.includes(kind)) throw new HttpError(400, "Unknown attack.");
    const key = kind;
    const now = Date.now();
    const last = lastRun.get(key) ?? 0;
    if (now - last < cfg.cooldownSeconds * 1000) {
      const wait = Math.ceil((cfg.cooldownSeconds * 1000 - (now - last)) / 1000);
      throw new HttpError(429, `That attack just ran. Try again in ${wait}s.`);
    }

    const intent = intentFor(kind);
    const signature = await signIntent({ signer: agent, chainId: cfg.chainId, vault: cfg.vault, intent });
    const result = await submit(cfg.vault, intent, signature);
    // only a real, recorded refusal spends the cooldown budget
    if (result.status === "refused") lastRun.set(key, now);

    const expected = kind === "overspend" ? Reason.ExceedsPerTxCap : Reason.MerchantNotAllowed;
    const note =
      result.status === "refused" && result.check.code === expected
        ? undefined
        : result.status === "refused"
          ? "The vault refused, but for a different reason than this attack expects. The mandate may have changed."
          : result.status === "rejected"
            ? "The relayer did not send this one (bad signature, expired or rate limited), so nothing was recorded."
            : "This attempt was not refused. Something about the mandate has changed.";
    return {
      kind,
      attempted: describe(kind),
      amount: kind === "overspend" ? usd(cfg.overspendAmount) : usd(cfg.offlistAmount),
      merchant: kind === "overspend" ? cfg.allowedMerchant : cfg.blockedMerchant,
      status: result.status,
      check: result.check,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      note: result.note ?? note,
    };
  }

  return { view, run, agent: agent.address };
}

/** Test and tooling helper: a chain-agnostic public client for one vault's chain. */
export function attackDemoClient(rpcUrl: string, chainId: number): PublicClient {
  return createPublicClient({
    chain: { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl, { timeout: 8_000, retryCount: 3, retryDelay: 300 }),
  });
}

export const __test = { usd, ATTACK_KINDS };
