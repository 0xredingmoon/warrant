"use client";
import type { Address } from "viem";
import { markCreation, type AuditEntry } from "@warrant/sdk";
import { txLink } from "@/lib/format";
import { useAuditProgress, useAuditSource } from "@/lib/queries";
import { BlockTime } from "./BlockTime";

const tone = (k: AuditEntry["kind"]) =>
  k === "PaymentExecuted" || k === "Deposited" ? "pay" : k === "PaymentQueued" ? "queue" : k === "PaymentRefused" || k === "MandateRevoked" || k === "VaultFrozen" || k === "PendingRejected" || k === "PendingExpired" ? "stop" : "";

export function ActivityPanel({ vault, audit, loading, error }: { vault: Address; audit?: AuditEntry[]; loading: boolean; error: boolean }) {
  const progress = useAuditProgress(vault);
  const source = useAuditSource(vault);
  const all = markCreation(audit ?? []);
  const rows = [...all].reverse();
  const shown = rows.slice(0, 60);
  return (
    <section className="panel" aria-labelledby="act-h">
      <div className="panel-h">
        <h2 id="act-h">Activity</h2>
        <span className="hint">
          Chain logs, newest first{source ? (source === "indexer" ? ", history from the explorer index" : ", history from the RPC") : ""}. Refreshes every few seconds.
        </span>
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
                <BlockTime block={e.blockNumber} />
                <span>
                  <i className={`kind ${tone(e.kind)}`} aria-hidden />
                  {e.kind === "PaymentRefused" && <strong className="refused-tag">Refused on-chain</strong>}
                  {e.summary}
                </span>
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
