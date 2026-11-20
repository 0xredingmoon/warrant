"use client";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { createVault, randomBytes32 } from "@warrant/sdk";
import { formatEther, isAddress, getAddress, zeroAddress } from "viem";
import { CHAIN_ID, FACTORY } from "@/lib/config";
import { ensureAevum } from "@/lib/network";
import { addrLink, short } from "@/lib/format";
import { useClients } from "@/lib/hooks";
import { useAudit, useCreateVaultFee, useGasBalance, useVault, useVaults } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { useTx } from "@/lib/tx";
import { ActivityPanel } from "./ActivityPanel";
import { BalancePanel } from "./BalancePanel";
import { MandatePanel } from "./MandatePanel";
import { NewMandateSheet } from "./NewMandateSheet";
import { PendingPanel } from "./PendingPanel";
import { ReputationPanel } from "./ReputationPanel";
import { SafetyPanel } from "./SafetyPanel";

function NetworkBanner() {
  const { wrongNetwork, refreshChain } = useWallet();
  const [state, setState] = useState<{ pending: boolean; message?: string }>({ pending: false });
  if (!wrongNetwork) return null;
  return (
    <div className="banner stop" role="alert">
      <span>Your wallet is on a different network. Warrant runs on QDay Aevum testnet (chain {CHAIN_ID}).</span>
      <button
        className="btn sm"
        disabled={state.pending}
        onClick={async () => {
          setState({ pending: true });
          const r = await ensureAevum();
          if (r.ok) await refreshChain();
          setState({ pending: false, message: r.ok ? undefined : r.message });
        }}
      >
        {state.pending ? "Check your wallet…" : "Switch network"}
      </button>
      {state.message && <span className="err">{state.message}</span>}
    </div>
  );
}

const fmtFee = (v: bigint) => {
  const n = Number(formatEther(v));
  return n >= 0.001 ? n.toFixed(4) : n.toPrecision(2);
};

function CreateVault({ onCreated, first }: { onCreated: (v: Address) => void; first: boolean }) {
  const { clients, ready } = useClients();
  const { address, wrongNetwork } = useWallet();
  const { run, busy } = useTx();
  const fee = useCreateVaultFee(address);
  const gas = useGasBalance(address);
  const short_ = fee.data !== undefined && gas.data !== undefined && gas.data < fee.data.expected;
  const [guardian, setGuardian] = useState("");
  const gOk = guardian === "" || isAddress(guardian);
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>{first ? "Step 1 of 3 · Create your vault" : "New vault"}</h2>
      </div>
      <div className="panel-b stack" style={{ gap: 18 }}>
        <p style={{ color: "var(--ink-2)" }}>
          A vault is a contract that only you can withdraw from. Agents get mandates on it; they never hold the funds. {fee.data !== undefined
            ? `Creating one costs about ${fmtFee(fee.data.expected)} tQDAY in gas. Your wallet may show up to ${fmtFee(fee.data.most)}; that is the most it allows, and you pay only what is used.`
            : "Creating one costs roughly 0.005 tQDAY in gas. Your wallet may show a little more as its upper limit; you pay only what is used."}
        </p>
        {short_ && <p className="note" role="status">Your wallet holds {fmtFee(gas.data!)} tQDAY, which is not enough for that. Get some from the faucet first.</p>}
        <label className="field">
          <span>Guardian (optional)</span>
          <input className={`input mono ${gOk ? "" : "bad"}`} placeholder="0x… a second key that can freeze or revoke, never move funds" value={guardian} onChange={(e) => setGuardian(e.target.value.trim())} spellCheck={false} />
          {!gOk && <span className="err">That is not an address.</span>}
        </label>
        <div className="row">
          <button
            className="btn"
            disabled={!ready || !gOk || busy}
            onClick={async () => {
              const res = await run("Create vault", () =>
                createVault({ clients: clients!, factory: FACTORY, guardian: guardian ? getAddress(guardian) : zeroAddress, salt: randomBytes32() }),
              );
              if (res) onCreated(res.vault);
            }}
          >
            Create vault
          </button>
          {!ready && <span className="hint">{wrongNetwork ? "Switch your wallet to Aevum first." : "Connect a wallet first."}</span>}
        </div>
      </div>
    </section>
  );
}

export function Dashboard() {
  const { address } = useWallet();
  const vaults = useVaults(address);
  const [sel, setSel] = useState<Address>();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (vaults.data?.length && (!sel || !vaults.data.includes(sel))) setSel(vaults.data[vaults.data.length - 1]);
  }, [vaults.data, sel]);

  if (vaults.isLoading) {
    return (
      <div className="wrap">
        <div className="skel" style={{ width: 280, height: 34, marginBottom: 18 }} />
        <div className="skel" style={{ width: 180 }} />
      </div>
    );
  }
  if (vaults.isError) {
    return (
      <div className="wrap">
        <div className="banner stop" role="alert">
          <span>Could not read the factory at {short(FACTORY)}. Check the RPC and that this app points at the right deployment.</span>
          <button className="btn sm" onClick={() => vaults.refetch()}>Retry</button>
        </div>
      </div>
    );
  }

  const list = vaults.data ?? [];
  return (
    <div className="wrap">
      <NetworkBanner />
      {list.length === 0 || adding ? (
        <div className="onboard">
          <CreateVault
            first={list.length === 0}
            onCreated={(v) => {
              setSel(v);
              setAdding(false);
            }}
          />
          <ol className="steps" aria-label="Setup steps">
            <li><div><strong>Create a vault</strong>One contract per owner. Only your wallet can withdraw from it.</div></li>
            <li><div><strong>Deposit tUSD8</strong>Sign once and the relayer pays the gas, or send the transaction yourself.</div></li>
            <li><div><strong>Issue a mandate</strong>Give an agent address its limits and the merchants it may pay. Everything else is refused.</div></li>
          </ol>
        </div>
      ) : (
        sel && <VaultView vault={sel} vaults={list} onSelect={setSel} onAdd={() => setAdding(true)} />
      )}
    </div>
  );
}

function VaultView({ vault, vaults, onSelect, onAdd }: { vault: Address; vaults: readonly Address[]; onSelect: (v: Address) => void; onAdd: () => void }) {
  const data = useVault(vault);
  const audit = useAudit(vault);
  const [copied, setCopied] = useState(false);
  const [sheet, setSheet] = useState<null | { register: boolean }>(null);
  const s = data.data?.state;
  return (
    <>
      {sheet && <NewMandateSheet vault={vault} registerAgent={sheet.register} onClose={() => setSheet(null)} />}
      <div className="head">
        <div>
          <h1>Vault</h1>
          <div className="sub">
            <a className="mono" href={addrLink(vault)} target="_blank" rel="noreferrer">
              {vault}
            </a>
            <button
              className="link"
              onClick={() => {
                void navigator.clipboard.writeText(vault);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            {s?.frozen && <span className="chip stop">Frozen</span>}
          </div>
        </div>
        <div className="head-actions">
          {vaults.length > 1 && (
            <label className="field">
              <span className="sr">Vault</span>
              <select className="input" value={vault} onChange={(e) => onSelect(e.target.value as Address)} aria-label="Select vault">
                {vaults.map((v, i) => (
                  <option key={v} value={v}>
                    Vault {i + 1} · {short(v)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="btn quiet" onClick={onAdd}>New vault</button>
        </div>
      </div>

      {data.isError ? (
        <div className="banner stop" role="alert">
          <span>Could not read this vault. The RPC may be rate limiting; it retries automatically.</span>
          <button className="btn sm" onClick={() => data.refetch()}>Retry now</button>
        </div>
      ) : (
        <div className="grid">
          <div className="stack">
            <MandatePanel vault={vault} data={data.data} audit={audit.data} auditLoading={audit.isFetching} loading={data.isLoading} onNew={() => setSheet({ register: false })} />
            <ActivityPanel vault={vault} audit={audit.data} loading={audit.isLoading} error={audit.isError} />
          </div>
          <div className="stack">
            <BalancePanel vault={vault} state={s} />
            <PendingPanel vault={vault} pending={data.data?.pending} mandates={data.data?.mandates} loading={data.isLoading} />
            <SafetyPanel vault={vault} state={s} />
            <ReputationPanel mandates={data.data?.mandates} onRegister={() => setSheet({ register: true })} />
          </div>
        </div>
      )}
    </>
  );
}
