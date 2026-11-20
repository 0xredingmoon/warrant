"use client";
import { useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { freezeAll, setGuardian, unfreeze, type VaultState } from "@warrant/sdk";
import { short } from "@/lib/format";
import { useClients } from "@/lib/hooks";
import { useTx } from "@/lib/tx";

const ZERO = "0x0000000000000000000000000000000000000000";

export function SafetyPanel({ vault, state }: { vault: Address; state?: VaultState }) {
  const { address } = useAccount();
  const { clients, ready } = useClients();
  const { run, busy } = useTx();
  const [editing, setEditing] = useState(false);
  const [g, setG] = useState("");
  const [confirm, setConfirm] = useState(false);
  if (!state) return null;
  const isOwner = address?.toLowerCase() === state.owner.toLowerCase();
  const isGuardian = address?.toLowerCase() === state.guardian.toLowerCase() && state.guardian !== ZERO;
  const hasGuardian = state.guardian !== ZERO;
  return (
    <section className="panel" aria-labelledby="safe-h">
      <div className="panel-h">
        <h2 id="safe-h">Safety</h2>
        <span className={`chip ${state.frozen ? "stop" : "ok"}`}>{state.frozen ? "Frozen" : "Open"}</span>
      </div>
      <div className="panel-b stack" style={{ gap: 14 }}>
        <p style={{ color: "var(--ink-2)", fontSize: 14 }}>
          {state.frozen
            ? "Every payment is refused, including queued ones, until you unfreeze."
            : "Freezing stops every mandate on this vault at once. Withdrawals stay available to you."}
        </p>
        {state.frozen ? (
          <button className="btn" disabled={!ready || !isOwner || busy} onClick={() => run("Unfreeze vault", () => unfreeze(clients!, vault))}>Unfreeze vault</button>
        ) : confirm ? (
          <div className="confirm">
            <span>Freeze all payments on this vault now?</span>
            <div className="row">
              <button className="btn stop" disabled={busy} onClick={async () => { const r = await run("Freeze vault", () => freezeAll(clients!, vault)); if (r) setConfirm(false); }}>Freeze</button>
              <button className="btn quiet" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="btn stop-quiet" disabled={!ready || !(isOwner || isGuardian)} onClick={() => setConfirm(true)}>Freeze all payments</button>
        )}

        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <div className="label">Guardian</div>
          {editing ? (
            <div className="stack" style={{ gap: 10, marginTop: 8 }}>
              <input className="input mono" placeholder={hasGuardian ? short(state.guardian, 6) : "0x… or leave empty to remove"} value={g} onChange={(e) => setG(e.target.value.trim())} spellCheck={false} />
              <div className="row">
                <button className="btn sm" disabled={busy || !ready || (g !== "" && !isAddress(g))} onClick={async () => { const r = await run("Set guardian", () => setGuardian(clients!, vault, g ? getAddress(g) : ZERO)); if (r) { setEditing(false); setG(""); } }}>Save</button>
                <button className="btn quiet sm" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 4, justifyContent: "space-between" }}>
              <span className={hasGuardian ? "mono" : "muted"}>{hasGuardian ? short(state.guardian, 6) : "None set"}</span>
              {isOwner && <button className="link hint" onClick={() => setEditing(true)}>{hasGuardian ? "Change" : "Add"}</button>}
            </div>
          )}
          <p className="hint" style={{ marginTop: 6 }}>A guardian can freeze the vault and revoke mandates. It can't spend, withdraw or unfreeze.</p>
        </div>
      </div>
    </section>
  );
}
