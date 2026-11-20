"use client";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { formatUsd, revokeMandate, type AuditEntry, type Mandate, type Pending, type VaultState } from "@warrant/sdk";
import { addrLink, dateTime, duration, pct, short, until } from "@/lib/format";
import { useClients } from "@/lib/hooks";
import { useTx } from "@/lib/tx";
import { NewMandateSheet } from "./NewMandateSheet";

type Data = { state: VaultState; mandates: Mandate[]; pending: Pending[] } | undefined;

function merchantsFor(audit: AuditEntry[] | undefined, id: bigint) {
  const m = new Map<string, { allowed: boolean; perTxCap: bigint; totalCap: bigint }>();
  for (const e of audit ?? []) {
    if (e.kind === "MerchantRuleSet" && (e.args as any).mandateId === id) {
      const a = e.args as any;
      m.set(a.merchant, { allowed: a.allowed, perTxCap: a.perTxCap, totalCap: a.totalCap });
    }
  }
  return [...m.entries()].filter(([, r]) => r.allowed).map(([addr, r]) => ({ addr, ...r }));
}

function Meter({ label, spent, cap, note }: { label: string; spent: bigint; cap: bigint; note?: string }) {
  const p = pct(spent, cap);
  return (
    <div>
      <div className="meter-l">
        <span>{label}</span>
        <span className="num">
          {formatUsd(spent)} / {formatUsd(cap)}
        </span>
      </div>
      <div className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        <i className={p >= 100 ? "full" : p >= 80 ? "hot" : ""} style={{ width: `${p}%` }} />
      </div>
      {note && <div className="hint" style={{ marginTop: 4 }}>{note}</div>}
    </div>
  );
}

function MandateCard({ m, vault, frozen, merchants, canAct }: { m: Mandate; vault: Address; frozen: boolean; merchants: ReturnType<typeof merchantsFor>; canAct: boolean }) {
  const { clients } = useClients();
  const { run, busy } = useTx();
  const [confirming, setConfirming] = useState(false);
  const now = Math.floor(Date.now() / 1000);
  const p = m.params;
  const idx = BigInt(Math.floor(Math.max(0, now - p.validAfter) / p.periodLength));
  const periodSpent = m.periodIndex === idx ? m.periodSpent : 0n;
  const resetAt = p.validAfter + (Number(idx) + 1) * p.periodLength;
  const status = m.revoked
    ? { label: "Revoked", cls: "stop" }
    : now >= p.expiry
      ? { label: "Expired", cls: "" }
      : now < p.validAfter
        ? { label: "Not started", cls: "warn" }
        : frozen
          ? { label: "Paused: vault frozen", cls: "warn" }
          : { label: "Active", cls: "ok" };
  const live = !m.revoked && now < p.expiry;
  return (
    <article className="mandate" aria-label={`Mandate ${m.id}`}>
      <div className="m-top">
        <div className="m-title">
          <strong>Mandate #{m.id.toString()}</strong>
          <span>
            Agent{" "}
            <a className="mono" href={addrLink(p.agent)} target="_blank" rel="noreferrer">
              {short(p.agent, 5)}
            </a>
            {p.agentId > 0n && <> · identity #{p.agentId.toString()}</>}
          </span>
        </div>
        <span className={`chip ${status.cls}`}>{status.label}</span>
      </div>

      <div className="meters">
        <Meter label={`Current ${duration(p.periodLength)} window`} spent={periodSpent} cap={p.periodCap} note={live ? `Resets ${until(resetAt)}` : undefined} />
        <Meter label="Lifetime" spent={m.spentTotal} cap={p.totalCap} />
      </div>

      <dl className="facts">
        <div>
          <dt>Per payment</dt>
          <dd className="num">up to {formatUsd(p.perTxCap)}</dd>
        </div>
        <div>
          <dt>Owner approval</dt>
          <dd className="num">{p.approvalThreshold === 0n ? "never required" : `from ${formatUsd(p.approvalThreshold)}, ${duration(p.approvalWindow)} to decide`}</dd>
        </div>
        <div>
          <dt>{now >= p.expiry ? "Expired" : "Expires"}</dt>
          <dd>{dateTime(p.expiry)} <span className="muted">({until(p.expiry)})</span></dd>
        </div>
      </dl>

      <div>
        <div className="label" style={{ marginBottom: 6 }}>Allowed merchants</div>
        {merchants.length === 0 ? (
          <span className="hint">None listed in the loaded history yet.</span>
        ) : (
          <div className="tags">
            {merchants.map((x) => (
              <a key={x.addr} className="tag" href={addrLink(x.addr)} target="_blank" rel="noreferrer" title={x.perTxCap || x.totalCap ? `Merchant limits: ${x.perTxCap ? `${formatUsd(x.perTxCap)} per payment` : ""} ${x.totalCap ? `${formatUsd(x.totalCap)} total` : ""}` : x.addr}>
                {short(x.addr, 5)}
              </a>
            ))}
          </div>
        )}
      </div>

      {live &&
        (confirming ? (
          <div className="confirm" role="alertdialog" aria-label="Confirm revoke">
            <span>Revoking is permanent. The agent can no longer pay under this mandate, and any queued payment under it can no longer be approved.</span>
            <div className="row">
              <button
                className="btn stop"
                disabled={busy || !clients}
                onClick={async () => {
                  const r = await run(`Revoke mandate #${m.id}`, () => revokeMandate(clients!, vault, m.id));
                  if (r) setConfirming(false);
                }}
              >
                Revoke now
              </button>
              <button className="btn quiet" onClick={() => setConfirming(false)}>Keep it</button>
            </div>
          </div>
        ) : (
          <div>
            <button className="btn stop-quiet sm" disabled={!canAct} onClick={() => setConfirming(true)}>
              Revoke mandate
            </button>
          </div>
        ))}
    </article>
  );
}

export function MandatePanel({ vault, data, audit, loading }: { vault: Address; data: Data; audit?: AuditEntry[]; loading: boolean }) {
  const { ready } = useClients();
  const [open, setOpen] = useState(false);
  const ordered = useMemo(() => [...(data?.mandates ?? [])].reverse(), [data?.mandates]);
  const hasFunds = (data?.state.balance ?? 0n) > 0n;
  return (
    <section className="panel" aria-labelledby="man-h">
      <div className="panel-h">
        <h2 id="man-h">Mandates</h2>
        <button className="btn sm" disabled={!ready} onClick={() => setOpen(true)}>
          New mandate
        </button>
      </div>
      {loading ? (
        <div className="panel-b stack" style={{ gap: 10 }}>
          <div className="skel" style={{ width: "40%" }} />
          <div className="skel" />
          <div className="skel" style={{ width: "70%" }} />
        </div>
      ) : ordered.length === 0 ? (
        <div className="empty">
          <strong>No mandates yet</strong>
          <p>
            {hasFunds
              ? "An agent can't spend until you give it one. Pick a template, name the merchants it may pay, and set the limits."
              : "Deposit some tUSD8 first, then issue a mandate to your agent. The vault is empty right now."}
          </p>
          <button className="btn" disabled={!ready} onClick={() => setOpen(true)}>
            {hasFunds ? "Step 3 of 3 · Issue a mandate" : "Issue a mandate"}
          </button>
        </div>
      ) : (
        ordered.map((m) => (
          <MandateCard key={m.id.toString()} m={m} vault={vault} frozen={!!data?.state.frozen} merchants={merchantsFor(audit, m.id)} canAct={ready} />
        ))
      )}
      {open && <NewMandateSheet vault={vault} onClose={() => setOpen(false)} />}
    </section>
  );
}
