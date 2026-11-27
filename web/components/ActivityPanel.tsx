"use client";
import { useState } from "react";
import type { Address } from "viem";
import { markCreation, type AuditEntry } from "@warrant/sdk";
import { txLink } from "@/lib/format";
import { useAuditProgress, useAuditSource } from "@/lib/queries";
import { BlockTime } from "./BlockTime";

// enough to reach the deposit and the mandate that created the vault in the demonstration, without a wall of refusals
const INITIAL_ROWS = 12;

/**
 * A recorded run leaves long bursts of the same refusal: the same agent, the same merchant, the same reason, and they
 * interleave with each other, so a run of twenty rows is really just two refusals alternating. Laid out one per row
 * they bury the handful of events that carry the story (a payment that went through, a mandate, the deposit).
 *
 * Group by what makes the refusal identical rather than by adjacency, keep each group where it most recently happened,
 * and count it. Everything that is not a repeated refusal is left exactly as it was.
 */
type Row = AuditEntry & { repeat?: number };

const refusalKey = (e: AuditEntry) =>
  `${String(e.args.mandateId)}|${String(e.args.merchant).toLowerCase()}|${String(e.args.reason)}`;

function groupRefusals(rows: readonly AuditEntry[]): Row[] {
  const groups = new Map<string, Row>();
  const order: string[] = [];
  for (const e of rows) {
    if (e.kind !== "PaymentRefused") {
      // a non-refusal breaks nothing; it simply appears where it happened
      order.push(`solo:${order.length}`);
      groups.set(`solo:${order.length - 1}`, { ...e });
      continue;
    }
    const key = refusalKey(e);
    const found = groups.get(key);
    if (found) {
      // rows arrive newest first, so the first sighting is the most recent one: keep its block and link, just count
      found.repeat = (found.repeat ?? 1) + 1;
    } else {
      groups.set(key, { ...e });
      order.push(key);
    }
  }
  return order.map((k) => groups.get(k)!);
}

const tone = (k: AuditEntry["kind"]) =>
  k === "PaymentExecuted" || k === "Deposited" ? "pay" : k === "PaymentQueued" ? "queue" : k === "PaymentRefused" || k === "MandateRevoked" || k === "VaultFrozen" || k === "PendingRejected" || k === "PendingExpired" ? "stop" : "";

export function ActivityPanel({ vault, audit, loading, error }: { vault: Address; audit?: AuditEntry[]; loading: boolean; error: boolean }) {
  const progress = useAuditProgress(vault);
  const source = useAuditSource(vault);
  const all = markCreation(audit ?? []);
  const rows = groupRefusals([...all].reverse());
  const [expanded, setExpanded] = useState(false);
  // A recorded run leaves dozens of refusals in a row, and rendering all of them buries the few events that matter:
  // the payments that went through, the mandates, the deposit. Show the recent ones, and let the reader ask for the rest.
  const shown = expanded ? rows : rows.slice(0, INITIAL_ROWS);
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
                  {e.repeat && e.repeat > 1 && (
                    <span className="repeat" title={`The same refusal was logged ${e.repeat} times, each in its own transaction`}>
                      ×{e.repeat}
                    </span>
                  )}
                </span>
                <a className="mono" href={txLink(e.txHash)} target="_blank" rel="noreferrer">{e.txHash.slice(0, 8)}… ↗</a>
              </li>
            ))}
          </ol>
          {rows.length > INITIAL_ROWS && (
            <div className="log-more">
              <button className="btn quiet sm" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                {expanded ? "Show the latest only" : `Show all ${rows.length} entries`}
              </button>
              <span className="hint">
                {expanded
                  ? "Oldest at the bottom."
                  : rows.length < all.length
                    ? `Latest ${INITIAL_ROWS} of ${rows.length} entries, from ${all.length} on-chain events. Repeated refusals are counted together.`
                    : `Showing the latest ${INITIAL_ROWS} of ${rows.length}.`}
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
