"use client";
import type { Address } from "viem";
import { useWallet } from "@/lib/wallet";
import { approvePending, expirePending, formatUsd, rejectPending, relayApprove, signApproval, type Mandate, type Pending } from "@warrant/sdk";
import { CHAIN_ID, RELAYER_URL } from "@/lib/config";
import { addrLink, short, until } from "@/lib/format";
import { useClients } from "@/lib/hooks";
import { useTx } from "@/lib/tx";

export function PendingPanel({ vault, pending, mandates, loading }: { vault: Address; pending?: Pending[]; mandates?: Mandate[]; loading: boolean }) {
  const { address } = useWallet();
  const { clients, wallet, ready } = useClients();
  const { run, busy } = useTx();
  const now = Math.floor(Date.now() / 1000);
  const list = (pending ?? []).filter((p) => p.status === "Open");

  async function approve(p: Pending) {
    if (!clients || !wallet || !address) return;
    if (RELAYER_URL) {
      await run(`Approve ${formatUsd(p.amount)} tUSD8`, async () => {
        const deadline = BigInt(now + 900);
        const signature = await signApproval({ signer: wallet as any, chainId: CHAIN_ID, vault, pendingId: p.id, deadline });
        const r = await relayApprove({ relayerUrl: RELAYER_URL!, vault, pendingId: p.id, deadline, signature });
        if (r.status !== "executed") throw new Error(r.error ?? "The relayer could not submit the approval.");
        return { hash: r.txHash };
      });
    } else {
      await run(`Approve ${formatUsd(p.amount)} tUSD8`, () => approvePending(clients, vault, p.id));
    }
  }

  return (
    <section className="panel" aria-labelledby="pend-h">
      <div className="panel-h">
        <h2 id="pend-h">Waiting for you</h2>
        {list.length > 0 && <span className="chip warn">{list.length}</span>}
      </div>
      {loading ? (
        <div className="panel-b"><div className="skel" /></div>
      ) : list.length === 0 ? (
        <div className="empty" style={{ padding: "18px" }}>
          <p>No payments are waiting. A payment at or above a mandate's approval threshold lands here and moves no money until you approve it.</p>
        </div>
      ) : (
        list.map((p) => {
          const expired = p.expiresAt <= now;
          return (
            <div className="pend" key={p.id.toString()}>
              <div className="pend-top">
                <span className="pend-amt">{formatUsd(p.amount)} <small className="muted" style={{ fontSize: 13, fontFamily: "var(--sans)" }}>tUSD8</small></span>
                <span className={`chip ${expired ? "stop" : "warn"}`}>{expired ? "Expired" : `Decide ${until(p.expiresAt)}`}</span>
              </div>
              <div className="hint">
                To{" "}
                <a className="mono" href={addrLink(p.merchant)} target="_blank" rel="noreferrer">{short(p.merchant, 5)}</a>
                {" "}· mandate #{p.mandateId.toString()}
                {mandates && ` · agent ${short(mandates.find((m) => m.id === p.mandateId)?.params.agent ?? "0x0000000000", 4)}`}
              </div>
              <div className="row">
                {expired ? (
                  <button className="btn quiet sm" disabled={!ready || busy} onClick={() => run("Clear expired request", () => expirePending(clients!, vault, p.id))}>Clear</button>
                ) : (
                  <>
                    <button className="btn sm" disabled={!ready || busy} onClick={() => approve(p)}>Approve</button>
                    <button className="btn stop-quiet sm" disabled={!ready || busy} onClick={() => run("Reject payment", () => rejectPending(clients!, vault, p.id))}>Reject</button>
                  </>
                )}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
