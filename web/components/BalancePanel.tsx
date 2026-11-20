"use client";
import { useState } from "react";
import type { Address } from "viem";
import { deposit, formatUsd, parseUsd, relayDeposit, signReceiveWithAuthorization, withdraw, type VaultState } from "@warrant/sdk";
import { CHAIN_ID, RELAYER_URL, TOKEN } from "@/lib/config";
import { cleanAmount } from "@/lib/format";
import { useClients } from "@/lib/hooks";
import { useWalletTokenBalance } from "@/lib/queries";
import { useTx } from "@/lib/tx";
import { useAccount } from "wagmi";

export function BalancePanel({ vault, state }: { vault: Address; state?: VaultState }) {
  const { address } = useAccount();
  const { clients, wallet, ready } = useClients();
  const { run, busy } = useTx();
  const mine = useWalletTokenBalance(address);
  const [mode, setMode] = useState<"deposit" | "withdraw" | null>(null);
  const [amt, setAmt] = useState("");
  const [gasless, setGasless] = useState(!!RELAYER_URL);

  const value = amt && amt !== "." ? parseUsd(amt) : 0n;
  const limit = mode === "deposit" ? mine.data : state?.balance;
  const over = limit !== undefined && value > limit;
  const isOwner = !state || !address || state.owner.toLowerCase() === address.toLowerCase();
  const canSubmit = ready && value > 0n && !over && !busy && isOwner;

  async function submit() {
    if (!clients || !wallet || !address) return;
    if (mode === "withdraw") {
      const r = await run(`Withdraw ${formatUsd(value)} tUSD8`, () => withdraw(clients, vault, address, value));
      if (r) done();
    } else if (gasless && RELAYER_URL) {
      const r = await run(`Deposit ${formatUsd(value)} tUSD8 (no gas)`, async () => {
        const auth = await signReceiveWithAuthorization({
          signer: wallet as any,
          chainId: CHAIN_ID,
          token: TOKEN,
          from: address,
          to: vault,
          value,
          validBefore: BigInt(Math.floor(Date.now() / 1000) + 900),
        });
        const res = await relayDeposit({ relayerUrl: RELAYER_URL!, vault, from: address, amount: value, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce, signature: auth.signature });
        if (res.status !== "executed") throw new Error(res.error ?? "The relayer could not submit the deposit.");
        return { hash: res.txHash };
      });
      if (r) done();
    } else {
      const r = await run(`Deposit ${formatUsd(value)} tUSD8`, () => deposit({ clients, vault, token: TOKEN, amount: value }));
      if (r) done();
    }
  }
  const done = () => {
    setAmt("");
    setMode(null);
  };

  return (
    <section className="panel" aria-labelledby="bal-h">
      <div className="panel-h">
        <h2 id="bal-h">Balance</h2>
      </div>
      <div className="panel-b stack" style={{ gap: 16 }}>
        <div className="balance">
          {state ? (
            <div className="amt">
              {formatUsd(state.balance)}
              <small>tUSD8</small>
            </div>
          ) : (
            <div className="skel" style={{ width: 160, height: 40 }} />
          )}
          <div className="hint">
            In your wallet: <span className="num">{mine.data !== undefined ? formatUsd(mine.data) : "…"}</span> tUSD8
          </div>
        </div>

        {!isOwner && <p className="hint">This vault belongs to another wallet. You can read it, but only its owner can move funds.</p>}

        {mode === null ? (
          <div className="split">
            <button className="btn" disabled={!ready || !isOwner} onClick={() => setMode("deposit")}>Deposit</button>
            <button className="btn quiet" disabled={!ready || !isOwner || !state || state.balance === 0n} onClick={() => setMode("withdraw")}>Withdraw</button>
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
              <button className="link hint" style={{ justifySelf: "start" }} onClick={() => setAmt(formatUsd(limit).replace(/\.?0+$/, "").replace(/^$/, "0"))}>
                Use the full {formatUsd(limit)}
              </button>
            )}
            {mode === "deposit" && RELAYER_URL && (
              <label className="check">
                <input type="checkbox" checked={gasless} onChange={(e) => setGasless(e.target.checked)} />
                <span>
                  Sign instead of sending a transaction (EIP-3009). The relayer pays the gas.
                </span>
              </label>
            )}
            {mode === "deposit" && !gasless && <p className="hint">Two transactions: an allowance, then the deposit.</p>}
            <div className="row">
              <button className="btn" disabled={!canSubmit} onClick={submit}>
                {mode === "deposit" ? "Deposit" : "Withdraw"}
              </button>
              <button className="btn quiet" onClick={done}>Cancel</button>
            </div>
          </div>
        )}
        {!ready && <p className="hint">Connect your wallet on Aevum to move funds.</p>}
      </div>
    </section>
  );
}
