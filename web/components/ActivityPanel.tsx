"use client";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { AuditEntry } from "@warrant/sdk";
import { dateTime, txLink } from "@/lib/format";
import { useAuditProgress, useClient } from "@/lib/queries";

const tone = (k: AuditEntry["kind"]) =>
  k === "PaymentExecuted" || k === "Deposited" ? "pay" : k === "PaymentQueued" ? "queue" : k === "MandateRevoked" || k === "VaultFrozen" || k === "PendingRejected" || k === "PendingExpired" ? "stop" : "";

function When({ block }: { block: bigint }) {
  const client = useClient();
  const t = useQuery({
    queryKey: ["block-time", block.toString()],
    queryFn: async () => Number((await client.getBlock({ blockNumber: block })).timestamp),
    staleTime: Infinity,
  });
  return <time dateTime={t.data ? new Date(t.data * 1000).toISOString() : undefined}>{t.data ? dateTime(t.data) : `block ${block}`}</time>;
}

export function ActivityPanel({ vault, audit, loading, error }: { vault: Address; audit?: AuditEntry[]; loading: boolean; error: boolean }) {
  const progress = useAuditProgress(vault);
  // the vault's constructor emits GuardianSet first: present it as the creation event
  const all = (audit ?? []).map((e, i) =>
    i === 0 && e.kind === "GuardianSet"
      ? { ...e, summary: (e.args as any).guardian === "0x0000000000000000000000000000000000000000" ? "Vault created, no guardian" : `Vault created with guardian ${String((e.args as any).guardian).slice(0, 6)}…${String((e.args as any).guardian).slice(-4)}` }
      : e,
  );
  const rows = [...all].reverse();
  const shown = rows.slice(0, 60);
  return (
    <section className="panel" aria-labelledby="act-h">
      <div className="panel-h">
        <h2 id="act-h">Activity</h2>
        <span className="hint">Read from chain logs, newest first. Refreshes every few seconds.</span>
      </div>
      {loading && progress < 100 && (
        <div className="scan" aria-label={`Reading history ${progress}%`}><i style={{ width: `${progress}%` }} /></div>
      )}
      {error && !audit ? (
        <div className="empty"><strong>History unavailable</strong><p>The RPC refused the log query. It retries automatically.</p></div>
      ) : loading && !audit ? (
        <div className="panel-b stack" style={{ gap: 10 }}>
          <div className="skel" /><div className="skel" style={{ width: "80%" }} /><div className="skel" style={{ width: "60%" }} />
        </div>
      ) : rows.length === 0 ? (
        <div className="empty"><strong>Nothing has happened yet</strong><p>Deposits, mandates, payments, approvals and revocations show up here with a link to each transaction.</p></div>
      ) : (
        <>
          <ol className="log">
            {shown.map((e) => (
              <li key={`${e.txHash}-${e.logIndex}`}>
                <When block={e.blockNumber} />
                <span><i className={`kind ${tone(e.kind)}`} aria-hidden />{e.summary}</span>
                <a className="mono" href={txLink(e.txHash)} target="_blank" rel="noreferrer">{e.txHash.slice(0, 8)}… ↗</a>
              </li>
            ))}
          </ol>
          {rows.length > shown.length && <p className="hint" style={{ padding: "12px 18px" }}>Showing the latest {shown.length} of {rows.length} events.</p>}
        </>
      )}
    </section>
  );
}
