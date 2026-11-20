"use client";
import { formatUsd, type Mandate } from "@warrant/sdk";
import { REGISTRY } from "@/lib/config";
import { addrLink, short } from "@/lib/format";
import { useReputation } from "@/lib/queries";

function Agent({ id, wallet }: { id: bigint; wallet: string }) {
  const r = useReputation(id);
  return (
    <div className="rep">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Agent #{id.toString()}</strong>
        <a className="mono hint" href={addrLink(wallet)} target="_blank" rel="noreferrer">{short(wallet, 5)}</a>
      </div>
      {r.isLoading ? (
        <div className="skel" />
      ) : r.isError || !r.data ? (
        <span className="err">Could not read the registry.</span>
      ) : (
        <>
          <div className="rep-nums">
            <div><b>{r.data.paymentCount}</b><span>verified payments</span></div>
            <div><b>{formatUsd(r.data.verifiedVolume)}</b><span>tUSD8 paid out</span></div>
            <div><b>{r.data.feedbackCount ? r.data.averageValue.toFixed(0) : "–"}</b><span>{r.data.feedbackCount ? `avg of ${r.data.feedbackCount} rating${r.data.feedbackCount > 1 ? "s" : ""}` : "no ratings yet"}</span></div>
          </div>
        </>
      )}
    </div>
  );
}

export function ReputationPanel({ mandates }: { mandates?: Mandate[] }) {
  const ids = new Map<string, { id: bigint; wallet: string }>();
  for (const m of mandates ?? []) if (m.params.agentId > 0n) ids.set(m.params.agentId.toString(), { id: m.params.agentId, wallet: m.params.agent });
  const unregistered = (mandates ?? []).filter((m) => m.params.agentId === 0n).length;
  return (
    <section className="panel" aria-labelledby="rep-h">
      <div className="panel-h">
        <h2 id="rep-h">Agent reputation</h2>
        <a className="hint" href={addrLink(REGISTRY)} target="_blank" rel="noreferrer">Registry ↗</a>
      </div>
      {ids.size === 0 ? (
        <div className="empty" style={{ padding: 18 }}>
          <p>
            {unregistered > 0
              ? `${unregistered} mandate${unregistered > 1 ? "s use" : " uses"} an unregistered agent address. Generate the key in New mandate to register an identity, and merchants can rate it against paid receipts.`
              : "Registered agents appear here with their verified payment count, volume and merchant ratings."}
          </p>
        </div>
      ) : (
        [...ids.values()].map((a) => <Agent key={a.id.toString()} {...a} />)
      )}
    </section>
  );
}
