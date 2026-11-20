"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MANDATE_TEMPLATES,
  createMandate,
  formatUsd,
  parseUsd,
  registerAgent,
  setAgentWallet,
  signAgentWallet,
  templateToParams,
  type MandateTemplate,
} from "@warrant/sdk";
import { CHAIN_ID, REGISTRY } from "@/lib/config";
import { cleanAmount, short } from "@/lib/format";
import { useClients } from "@/lib/hooks";
import { useTx } from "@/lib/tx";
import { useVault } from "@/lib/queries";

const toStr = (t: MandateTemplate) => ({
  perTx: t.perTx,
  period: t.period,
  total: t.total,
  periodHours: String(t.periodHours),
  durationDays: String(t.durationDays),
  threshold: t.approvalAbove,
  windowHours: String(t.approvalWindowHours),
});

const num = (s: string) => (s === "" || s === "." ? 0n : parseUsd(s));
const int = (s: string) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);

export function NewMandateSheet({ vault, vaultName, onClose, registerAgent: presetRegister = false }: { vault: Address; vaultName: string; onClose: () => void; registerAgent?: boolean }) {
  const { clients, ready } = useClients();
  const { run, busy } = useTx();
  const held = useVault(vault).data?.state.balance;
  const [tpl, setTpl] = useState<string>(MANDATE_TEMPLATES[0]!.id);
  const [f, setF] = useState(toStr(MANDATE_TEMPLATES[0]!));
  // opened from "Register agent": start with a fresh key and registration switched on
  const [genKey, setGenKey] = useState<Hex | undefined>(() => (presetRegister ? generatePrivateKey() : undefined));
  const [agent, setAgent] = useState(() => (genKey ? privateKeyToAccount(genKey).address : ""));
  const [register, setRegister] = useState(presetRegister);
  const [note, setNote] = useState("");
  const [merchants, setMerchants] = useState("");
  const [shown, setShown] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  // focus the first control once on open; the parent re-renders on every poll and must not steal focus mid-typing
  useEffect(() => {
    first.current?.focus();
  }, []);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !latest.current.busy && latest.current.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setTpl("custom");
    setNote("");
    setF({ ...f, [k]: k.includes("Hours") || k === "durationDays" ? e.target.value.replace(/[^\d.]/g, "") : cleanAmount(e.target.value) });
  };

  const merchantList = useMemo(() => merchants.split(/[\s,]+/).filter(Boolean), [merchants]);
  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!isAddress(agent)) e.agent = "Enter the agent's address, or generate a key below.";
    const bad = merchantList.filter((m) => !isAddress(m));
    if (merchantList.length === 0) e.merchants = "List at least one merchant address. An unlisted merchant can never be paid.";
    else if (bad.length) e.merchants = `Not an address: ${bad[0]}`;
    else if (new Set(merchantList.map((m) => m.toLowerCase())).size !== merchantList.length) e.merchants = "A merchant is listed twice.";
    else if (merchantList.length > 32) e.merchants = "At most 32 merchants per mandate.";
    const perTx = num(f.perTx), period = num(f.period), total = num(f.total), thr = num(f.threshold);
    if (perTx === 0n) e.perTx = "Must be above zero.";
    else if (perTx > period) e.period = "The daily/period limit can't be below the per-payment limit.";
    if (period > total) e.total = "The lifetime limit can't be below the period limit.";
    if (thr > perTx && perTx > 0n) e.threshold = `Can't be above the per-payment limit of ${formatUsd(perTx)}. A payment never gets that large, so nothing would ever wait for you.`;
    if (!(int(f.periodHours) >= 1)) e.periodHours = "At least 1 hour.";
    if (!(int(f.durationDays) > 0) || int(f.durationDays) > 365) e.durationDays = "Between 1 and 365 days.";
    if (thr > 0n && !(int(f.windowHours) >= 1)) e.windowHours = "Give yourself at least 1 hour to decide.";
    return e;
  }, [agent, merchantList, f]);
  const valid = Object.keys(errors).length === 0;

  // leaving the per-payment field with a lower figure than the approval threshold: pull the threshold down to match, and say so
  const settlePerTx = () => {
    const perTx = num(f.perTx), thr = num(f.threshold);
    if (perTx > 0n && thr > perTx) {
      setF({ ...f, threshold: f.perTx });
      setNote(`Approval threshold lowered to ${formatUsd(perTx)} so it fits under the per-payment limit.`);
    }
  };

  function pick(t: MandateTemplate) {
    setNote("");
    setTpl(t.id);
    setF(toStr(t));
  }

  async function submit() {
    if (!clients || !valid) return;
    const agentAddr = getAddress(agent);
    const res = await run(`Issue mandate in ${vaultName}`, async () => {
      let agentId = 0n;
      if (genKey && register && privateKeyToAccount(genKey).address === agentAddr) {
        const reg = await registerAgent({ clients, registry: REGISTRY, agentURI: `warrant:agent:${agentAddr.toLowerCase()}` });
        agentId = reg.agentId;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const signature = await signAgentWallet({ signer: privateKeyToAccount(genKey), chainId: CHAIN_ID, registry: REGISTRY, agentId, newWallet: agentAddr, owner: clients.walletClient.account!.address, deadline });
        await setAgentWallet({ clients, registry: REGISTRY, agentId, newWallet: agentAddr, deadline, signature });
      }
      const now = Math.floor(Date.now() / 1000);
      const thr = num(f.threshold);
      const params = templateToParams(
        { id: "c", name: "", description: "", perTx: f.perTx, period: f.period, total: f.total, periodHours: int(f.periodHours), durationDays: int(f.durationDays), approvalAbove: f.threshold || "0", approvalWindowHours: thr > 0n ? int(f.windowHours) : 0 },
        agentAddr,
        { agentId, now },
      );
      return createMandate({ clients, vault, params, merchants: merchantList.map((m) => ({ address: getAddress(m) })) });
    });
    if (res) onClose();
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="nm-h">
        <div className="row">
          <div>
            <h2 id="nm-h">New mandate</h2>
            <div className="hint">in {vaultName} · {short(vault)}</div>
          </div>
          <button className="btn quiet sm sheet-x" onClick={onClose} disabled={busy}>Close</button>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 8 }}>Start from a template</div>
          <div className="tpls">
            {MANDATE_TEMPLATES.map((t, i) => (
              <button key={t.id} ref={i === 0 ? first : undefined} className="tpl" aria-pressed={tpl === t.id} onClick={() => pick(t)}>
                <strong>{t.name}</strong>
                <span>{t.description}</span>
                <span className="num">
                  {formatUsd(parseUsd(t.perTx))} tUSD8 per payment · {formatUsd(parseUsd(t.period))} per {t.periodHours >= 24 && t.periodHours % 24 === 0 ? (t.periodHours === 24 ? "day" : `${t.periodHours / 24} days`) : `${t.periodHours} h`} · {formatUsd(parseUsd(t.total))} over {t.durationDays === 1 ? "1 day" : `${t.durationDays} days`}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="form-grid">
          <label className="field wide">
            <span>Agent address</span>
            <input className={`input mono ${errors.agent && agent ? "bad" : ""}`} value={agent} onChange={(e) => { setAgent(e.target.value.trim()); setGenKey(undefined); }} placeholder="0x… the key the agent signs with" spellCheck={false} />
            {agent && errors.agent ? <span className="err">{errors.agent}</span> : <span className="hint">The agent only signs payment requests. It never needs tQDAY.</span>}
          </label>
          <div className="wide">
            {genKey ? (
              <div className="key-box">
                <strong>New agent key. Copy it now; this page does not store it.</strong>
                <code>{shown ? genKey : "•".repeat(40)}</code>
                <div className="row">
                  <button className="btn quiet sm" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Reveal"}</button>
                  <button className="btn quiet sm" onClick={() => navigator.clipboard.writeText(genKey)}>Copy key</button>
                </div>
                <label className="check">
                  <input type="checkbox" checked={register} onChange={(e) => setRegister(e.target.checked)} />
                  <span>Also register this agent in the AgentRegistry. That adds 2 transactions before the mandate (register, then link its wallet); merchants can then rate it against paid receipts.</span>
                </label>
              </div>
            ) : (
              <button
                className="link hint"
                onClick={() => {
                  const k = generatePrivateKey();
                  setGenKey(k);
                  setAgent(privateKeyToAccount(k).address);
                  setShown(false);
                }}
              >
                Generate a new agent key in this browser
              </button>
            )}
          </div>

          <label className="field wide">
            <span>Merchants the agent may pay (one address per line)</span>
            <textarea className={`input mono ${errors.merchants && merchants ? "bad" : ""}`} rows={3} value={merchants} onChange={(e) => setMerchants(e.target.value)} placeholder={"0x…\n0x…"} spellCheck={false} />
            {merchants && errors.merchants ? <span className="err">{errors.merchants}</span> : <span className="hint">Anyone not on this list is refused, whatever the agent is told to do.</span>}
          </label>

          <Amount label="Per payment, at most" v={f.perTx} onChange={set("perTx")} onBlur={settlePerTx} err={errors.perTx} />
          <Amount label="Per window, at most" v={f.period} onChange={set("period")} err={errors.period} />
          <Amount label="Lifetime total, at most" v={f.total} onChange={set("total")} err={errors.total} />
          <Plain label="Window length" suffix="hours" v={f.periodHours} onChange={set("periodHours")} err={errors.periodHours} />
          <Plain label="Valid for" suffix="days" v={f.durationDays} onChange={set("durationDays")} err={errors.durationDays} />
          <div className="wide">
            <Amount label="Ask me from this amount (0 = never)" v={f.threshold} onChange={set("threshold")} err={errors.threshold} />
            {errors.threshold && num(f.perTx) > 0n && (
              <button className="link hint" style={{ marginTop: 4 }} onClick={() => { setNote(""); setF({ ...f, threshold: f.perTx }); }}>
                Set it to {formatUsd(num(f.perTx))}
              </button>
            )}
            {note && !errors.threshold && <p className="note" role="status" style={{ marginTop: 6 }}>{note}</p>}
          </div>
          {num(f.threshold) > 0n && <Plain label="Time I have to decide" suffix="hours" v={f.windowHours} onChange={set("windowHours")} err={errors.windowHours} />}
        </div>

        <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 18, gap: 12 }}>
          {valid && held !== undefined && (num(f.total) > held || num(f.perTx) > held) && (
            <p className="note" role="status">
              {held === 0n
                ? "This vault is empty. The mandate can still be issued, but every payment fails until you deposit."
                : num(f.perTx) > held
                  ? `A single payment of up to ${formatUsd(num(f.perTx))} is allowed here, but the vault holds only ${formatUsd(held)}. Larger payments fail until you deposit more.`
                  : `The lifetime limit (${formatUsd(num(f.total))}) is above what the vault holds (${formatUsd(held)}). That is allowed: the vault's balance is the real ceiling until you deposit more.`}
            </p>
          )}
          <div className="row">
            <button className="btn" disabled={!ready || !valid || busy} onClick={submit}>
              {busy ? "Working…" : "Issue mandate"}
            </button>
            <span className="hint">
              {valid
                ? `Up to ${formatUsd(num(f.total))} tUSD8 can leave the vault under this mandate${held !== undefined ? `; the vault holds ${formatUsd(held)} now` : ""}.`
                : `Can't issue yet: ${Object.values(errors)[0]}`}
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Amount({ label, v, onChange, onBlur, err }: { label: string; v: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; onBlur?: () => void; err?: string }) {
  return <Plain label={label} suffix="tUSD8" v={v} onChange={onChange} onBlur={onBlur} err={err} />;
}
function Plain({ label, suffix, v, onChange, onBlur, err }: { label: string; suffix: string; v: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; onBlur?: () => void; err?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="affix" style={err ? { borderColor: "var(--stop)" } : undefined}>
        <input inputMode="decimal" value={v} onChange={onChange} onBlur={onBlur} aria-invalid={!!err} />
        <em>{suffix}</em>
      </div>
      {err && <span className="err">{err}</span>}
    </label>
  );
}
