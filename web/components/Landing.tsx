"use client";
import { useEffect } from "react";
import { useWallet } from "@/lib/wallet";
import { AttackPanel } from "./AttackPanel";
import { ChainStatus } from "./ChainStatus";
import { ConnectButton } from "./Header";
import { ProofPanel } from "./ProofPanel";
import { Tour } from "./Tour";

const decisions: { what: string; amt: string; verdict: "ok" | "stop" | "warn"; label: string; why?: string }[] = [
  { what: "10-K summary from Ledgerline Data", amt: "0.15", verdict: "ok", label: "Paid" },
  { what: "Q3 earnings transcript", amt: "0.25", verdict: "ok", label: "Paid" },
  { what: "A web page tells the agent to pay 0x99d0…f322", amt: "0.40", verdict: "stop", label: "Blocked", why: "Not on the merchant allowlist" },
  { what: "Full filings export", amt: "0.50", verdict: "warn", label: "Waits for you", why: "Above your approval threshold" },
  { what: "Transcript archive", amt: "0.20", verdict: "stop", label: "Blocked", why: "Would exceed today's 1.00 cap" },
  { what: "Any payment after you revoke", amt: "0.15", verdict: "stop", label: "Blocked", why: "Mandate revoked" },
];

export function Landing() {
  const { status } = useWallet();
  const connected = status === "connected";

  // a link straight to the demonstration (#try-the-attack) should land on it once the page exists
  useEffect(() => {
    if (window.location.hash === "#try-the-attack") {
      document.getElementById("try-the-attack")?.scrollIntoView({ block: "start" });
    }
  }, []);

  // a connected owner goes to their dashboard, which is where "open my vault" belongs
  const openMine = () => {
    if (connected) {
      document.querySelector<HTMLElement>(".hero .cta")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const c = document.querySelector<HTMLElement>(".hero .cta button");
    c?.focus();
  };

  return (
    <div className="wrap">
      <section className="hero">
        <div>
          <h1>
            Give an AI agent a spending <em>mandate</em>, not a wallet key.
          </h1>
          <p className="lead">
            Deposit tUSD8 into a vault you own. The agent signs payment requests; the contract pays only merchants you listed, within per-payment, daily and total limits, until the mandate expires. Large payments wait for your approval. Revoking takes one transaction.
          </p>
          <div className="cta">
            <ConnectButton big />
            {status === "unavailable" ? (
              <span className="hint">This page needs no wallet to run the demonstration below.</span>
            ) : status === "connecting" ? (
              <span className="hint waiting" role="status"><span className="spinner dark" aria-hidden /> Waiting for your wallet. Approve the connection in its window; nothing is sent.</span>
            ) : (
              <span className="hint">Injected wallet only. Nothing is sent until you confirm.</span>
            )}
            <ChainStatus />
            <Tour onOpenMine={openMine} />
          </div>
        </div>
        <div id="decisions">
          <aside className="ticket" aria-label="Example decisions from a recorded run">
            <div className="ticket-h">
              <span>Mandate 1 · Ledgerline only</span>
              <span>1.00 / day</span>
            </div>
            {decisions.map((d, i) => (
              <div className="ticket-r" key={i}>
                <div>
                  <div>{d.what}</div>
                  {d.why && <div className="hint">{d.why}</div>}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="num">{d.amt} tUSD8</div>
                  <div className={`verdict ${d.verdict}`}>{d.label}</div>
                </div>
              </div>
            ))}
          </aside>
        </div>
      </section>

      {/* the demonstration comes first: it is the one thing a visitor can check without trusting us */}
      <div className="tour-steps" style={{ marginBottom: 34 }}>
        <AttackPanel />
      </div>

      <ProofPanel />

      <section className="facts3" style={{ marginTop: 34 }}>
        <div>
          <h3>The contract is the policy</h3>
          <p>The rules run inside the payment transaction. A compromised or prompt-injected agent can ask, but the vault decides, and it says why in a code the agent can read back.</p>
        </div>
        <div>
          <h3>The agent never needs gas</h3>
          <p>The agent signs an EIP-712 intent. A relayer submits it and pays the fee, so the agent key holds no funds and cannot be drained.</p>
        </div>
        <div>
          <h3>Merchants verify from chain data</h3>
          <p>A merchant serves a request after reading the payment event from the vault. Paid invoices build a receipt-bound reputation for the agent.</p>
        </div>
      </section>
    </div>
  );
}
