"use client";
import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { deposit, formatUsd, parseUsd, relayDeposit, signReceiveWithAuthorization, withdraw, type VaultState } from "@warrant/sdk";
import { CHAIN_ID, RELAYER_URL, TOKEN } from "@/lib/config";
import { RelayerNotice, useRelayer } from "@/lib/relayer";
import { publicClient } from "@/lib/chain";
import { cleanAmount, txLink } from "@/lib/format";
import { useClients } from "@/lib/hooks";
import { useWalletTokenBalance } from "@/lib/queries";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

/** balances we know are right because the receipt says so, shown until the RPC catches up (it can lag a few seconds) */
interface Pin {
  dir: "in" | "out";
  vault: bigint;
  wallet?: bigint;
  until: number;
}

interface Flow {
  label: string;
  steps: string[];
  stage: number;
  hash?: Hex;
}

const DEPOSIT_STEPS = ["Sign in your wallet (no gas)", "Relayer sends the transaction", "Block confirms it", "Balances update"];
const DIRECT_STEPS = ["Confirm in your wallet", "Block confirms it", "Balances update"];

export function BalancePanel({ vault, state }: { vault: Address; state?: VaultState }) {
  const { address } = useWallet();
  const { clients, wallet, ready } = useClients();
  const { run, busy } = useTx();
  const mine = useWalletTokenBalance(address);
  const { online: relayerOnline } = useRelayer();
  const [mode, setMode] = useState<"deposit" | "withdraw" | null>(null);
  const [amt, setAmt] = useState("");
  const [gasless, setGasless] = useState(false);
  const [pin, setPin] = useState<Pin | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    setGasless(relayerOnline === true);
  }, [relayerOnline]);

  // what to show: the pinned figure until the chain read agrees with it (or 60 s pass)
  const pinned = pin && Date.now() < pin.until ? pin : null;
  const pickUp = (real: bigint | undefined, pinnedV: bigint | undefined, dir: "in" | "out", up: boolean) =>
    real === undefined || pinnedV === undefined ? real : (dir === "in") === up ? (real > pinnedV ? real : pinnedV) : real < pinnedV ? real : pinnedV;
  const vaultBal = pinned ? pickUp(state?.balance, pinned.vault, pinned.dir, true) : state?.balance;
  const walletBal = pinned ? pickUp(mine.data, pinned.wallet, pinned.dir, false) : mine.data;
  useEffect(() => {
    if (!pin) return;
    const reached = state && (pin.dir === "in" ? state.balance >= pin.vault : state.balance <= pin.vault);
    if (reached || Date.now() >= pin.until) setPin(null);
    else {
      const t = setTimeout(() => setPin((p) => (p === pin ? { ...p } : p)), Math.max(0, pin.until - Date.now()) + 50);
      return () => clearTimeout(t);
    }
  }, [pin, state]);

  const value = amt && amt !== "." ? parseUsd(amt) : 0n;
  const limit = mode === "deposit" ? walletBal : vaultBal;
  const over = limit !== undefined && value > limit;
  const isOwner = !state || !address || state.owner.toLowerCase() === address.toLowerCase();
  const canSubmit = ready && value > 0n && !over && !busy && !flow && isOwner;

  async function submit() {
    if (!clients || !wallet || !address || submitting.current) return;
    submitting.current = true;
    const dir = mode === "withdraw" ? "out" : "in";
    const before = { vault: state?.balance ?? 0n, wallet: mine.data };
    const amount = value;
    const title = mode === "withdraw" ? `Withdraw ${formatUsd(amount)} tUSD8` : `Deposit ${formatUsd(amount)} tUSD8${gasless && relayerOnline && RELAYER_URL ? " (no gas)" : ""}`;
    const relayed = mode === "deposit" && gasless && relayerOnline === true && !!RELAYER_URL;
    setFlow({ label: title, steps: relayed ? DEPOSIT_STEPS : DIRECT_STEPS, stage: 0 });
    const adv = (stage: number, hash?: Hex) => setFlow((f) => (f ? { ...f, stage, hash: hash ?? f.hash } : f));
    try {
      await run(
        title,
        async ({ step }) => {
          if (mode === "withdraw") {
            return withdraw(clients, vault, address, amount);
          }
          if (!relayed) return deposit({ clients, vault, token: TOKEN, amount });
          step("Sign the deposit in your wallet. The signature costs no gas.");
          const auth = await signReceiveWithAuthorization({
            signer: wallet as any,
            chainId: CHAIN_ID,
            token: TOKEN,
            from: address,
            to: vault,
            value: amount,
            validBefore: BigInt(Math.floor(Date.now() / 1000) + 900),
          });
          adv(1);
          step("Signed. Sending it to the relayer…");
          let sent;
          try {
            sent = await relayDeposit({ relayerUrl: RELAYER_URL!, vault, from: address, amount, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce, signature: auth.signature, wait: false, timeoutMs: 30_000 });
          } catch (e) {
            if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") throw new Error("The relayer did not answer within 30 seconds. Your signed deposit may still go through: check the vault balance before signing again.");
            throw e;
          }
          if (sent.status === "failed" || !sent.txHash) throw new Error(sent.error ?? "The relayer could not submit the deposit.");
          adv(2, sent.txHash);
          step("The relayer sent the transaction. Waiting for the block…", sent.txHash);
          if (sent.status === "submitted") {
            const receipt = await publicClient.waitForTransactionReceipt({ hash: sent.txHash, timeout: 120_000, pollingInterval: 1000 });
            if (receipt.status !== "success") throw new Error("The deposit transaction reverted. Nothing moved.");
          }
          return { hash: sent.txHash };
        },
        {
          onSuccess: () => {
            // the receipt is in: show the new balances now and keep them until the chain read agrees
            setPin({ dir, vault: dir === "in" ? before.vault + amount : before.vault - amount, wallet: before.wallet === undefined ? undefined : dir === "in" ? before.wallet - amount : before.wallet + amount, until: Date.now() + 60_000 });
            setAmt("");
            setMode(null);
            setFlow(null);
          },
        },
      );
    } finally {
      submitting.current = false;
      setFlow(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="bal-h">
      <div className="panel-h">
        <h2 id="bal-h">Balance</h2>
      </div>
      <div className="panel-b stack" style={{ gap: 16 }}>
        <div className="balance">
          {vaultBal !== undefined ? (
            <div className="amt">
              {formatUsd(vaultBal)}
              <small>tUSD8</small>
            </div>
          ) : (
            <div className="skel" style={{ width: 160, height: 40 }} />
          )}
          <div className="hint">
            In your wallet: <span className="num">{walletBal !== undefined ? formatUsd(walletBal) : "…"}</span> tUSD8
          </div>
        </div>

        {!isOwner && <p className="hint">This vault belongs to another wallet. You can read it, but only its owner can move funds.</p>}

        {flow ? (
          <FlowSteps flow={flow} />
        ) : mode === null ? (
          <div className="split">
            <button className="btn" disabled={!ready || !isOwner} onClick={() => setMode("deposit")}>Deposit</button>
            <button className="btn quiet" disabled={!ready || !isOwner || vaultBal === undefined || vaultBal === 0n} onClick={() => setMode("withdraw")}>Withdraw</button>
          </div>
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            <label className="field">
              <span>{mode === "deposit" ? "Amount to deposit" : "Amount to withdraw to your wallet"}</span>
              <div className="affix">
                <input inputMode="decimal" autoFocus placeholder="0.00" value={amt} onChange={(e) => setAmt(cleanAmount(e.target.value))} aria-invalid={over} />
                <em>tUSD8</em>
              </div>
              {over && <span className="err">{mode === "deposit" ? "More than your wallet holds." : "More than the vault holds."}</span>}
            </label>
            {limit !== undefined && limit > 0n && (
              <button className="link hint" style={{ justifySelf: "start" }} onClick={() => setAmt(formatUsd(limit))}>
                Use the full {formatUsd(limit)}
              </button>
            )}
            {mode === "deposit" && relayerOnline && RELAYER_URL && (
              <label className="check">
                <input type="checkbox" checked={gasless} onChange={(e) => setGasless(e.target.checked)} />
                <span>
                  Sign instead of sending a transaction (EIP-3009). The relayer pays the gas.
                </span>
              </label>
            )}
            {mode === "deposit" && relayerOnline !== true && <RelayerNotice />}
            {mode === "deposit" && !gasless && <p className="hint">Two transactions: an allowance, then the deposit.</p>}
            <div className="row">
              <button className="btn" disabled={!canSubmit} onClick={submit}>
                {mode === "deposit" ? "Deposit" : "Withdraw"}
              </button>
              <button className="btn quiet" onClick={() => { setAmt(""); setMode(null); }}>Cancel</button>
            </div>
          </div>
        )}
        {!ready && <p className="hint">Connect your wallet on Aevum to move funds.</p>}
      </div>
    </section>
  );
}

/** Where a deposit or withdrawal is, in the panel itself, so nobody has to guess whether to sign again. */
function FlowSteps({ flow }: { flow: Flow }) {
  const stage = flow.stage;
  return (
    <div className="stack" style={{ gap: 10 }} role="status" aria-live="polite">
      <strong style={{ fontSize: 14 }}>{flow.label}</strong>
      <ol className="flow-steps">
        {flow.steps.map((s, i) => (
          <li key={s} className={i < stage ? "done" : i === stage ? "now" : ""}>
            {i < stage ? <span className="tick" aria-hidden>✓</span> : i === stage ? <span className="spinner dark" aria-hidden /> : <span className="dot-s" aria-hidden />}
            <span>{s}</span>
            {i === 1 && flow.hash && flow.steps === DEPOSIT_STEPS && (
              <a className="mono hint" href={txLink(flow.hash)} target="_blank" rel="noreferrer">{flow.hash.slice(0, 10)}… ↗</a>
            )}
          </li>
        ))}
      </ol>
      <Slow hash={flow.hash} />
      <p className="hint">Don't sign again while this runs. A second signature is a second deposit.</p>
    </div>
  );
}

/** After 25 s the screen says what is going on instead of just spinning. */
function Slow({ hash }: { hash?: Hex }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 25_000);
    return () => clearTimeout(t);
  }, []);
  if (!slow) return null;
  return (
    <p className="note" role="status">
      This is taking longer than usual.{" "}
      {hash ? <>The transaction is on the network and can be followed <a href={txLink(hash)} target="_blank" rel="noreferrer">in the explorer ↗</a>.</> : "Your wallet has not handed over the signature yet."}{" "}
      Wait for it before trying again.
    </p>
  );
}
