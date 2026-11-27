"use client";
import { useEffect } from "react";
import { useWallet } from "@/lib/wallet";
import { CHAIN_ID, EXPLORER, FACTORY, REGISTRY, TOKEN } from "@/lib/config";
import { short } from "@/lib/format";
import { PROOF_VAULT } from "@/lib/proof";
import { AttackPanel } from "./AttackPanel";
import { ChainStatus } from "./ChainStatus";
import { CodeBlock } from "./CodeBlock";
import { ConnectButton } from "./Header";
import { FlowDiagram } from "./FlowDiagram";
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

const SDK_CODE = `import { WarrantAgent } from "@warrant/sdk";

const agent = new WarrantAgent({
  signer: agentAccount,
  publicClient,
  chainId: 44005,
  vault,
  mandateId: 1n,
  relayerUrl,
});

const r = await agent.pay({
  merchant,
  amount: "0.15",
  invoiceRef,
  context: { task: "ACME brief" },
});

// r.status: "executed" | "queued" | "refused" | "rejected"
// r.message: plain language, straight from the vault
// r.explorerUrl: the transaction, when there is one`;

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
          <p className="hero-eyebrow">
            <span>Aevum builder challenge</span>
            <span className="sep" aria-hidden />
            <span>chain {CHAIN_ID}</span>
          </p>
          <h1>
            Give an AI agent a spending <em>mandate</em>, not a wallet key.
          </h1>
          <p className="lead">
            Deposit tUSD8 into a vault you own. The agent signs payment requests; the contract pays only merchants you
            listed, within per-payment, daily and total limits, until the mandate expires. Large payments wait for your
            approval. Revoking takes one transaction.
          </p>
          <div className="cta">
            {/* With no wallet installed, asking someone to install one before they can look at anything is the wrong
                first move. Point at the live test instead, and keep the wallet prompt for people who can act on it. */}
            {status === "unavailable" ? (
              <a className="btn lg" href="#try-the-attack">
                Run the test, no wallet needed
              </a>
            ) : (
              <ConnectButton big />
            )}
            {/* The product itself is one click away and needs no wallet: the demo vault is on a public chain, so its
                balance, mandates and refusals are readable by anyone. */}
            <a className="btn quiet lg" href="#app">
              Open the vault
            </a>
            {status === "connecting" ? (
              <span className="hint waiting" role="status">
                <span className="spinner dark" aria-hidden /> Waiting for your wallet. Approve the connection in its
                window; nothing is sent.
              </span>
            ) : (
              <Tour onOpenMine={openMine} />
            )}
          </div>

          <dl className="hero-facts">
            <div>
              <dt>Holds the money</dt>
              <dd>Your vault</dd>
            </div>
            <div>
              <dt>Holds the gas</dt>
              <dd>Relayer</dd>
            </div>
            <div>
              <dt>Enforced</dt>
              <dd>On-chain</dd>
            </div>
          </dl>

          <ChainStatus />
        </div>

        <div id="decisions">
          <p className="ticket-cap">One day under one mandate</p>
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
          <p className="hint" style={{ marginTop: 12 }}>
            A recorded run, not a mock-up. Every refusal below is a real transaction on the testnet.
          </p>
        </div>
      </section>

      {/* the demonstration comes first: it is the one thing a visitor can check without trusting us */}
      <div className="tour-steps" id="demo">
        <AttackPanel />
      </div>

      <ProofPanel />

      <section className="section" id="how">
        <div className="section-h">
          <p className="section-kicker">
            <span className="rule" aria-hidden />
            How a payment moves
          </p>
          <h2>Three parties, one transaction.</h2>
          <p>
            The agent never touches the money and never needs gas. It signs an intent; the relayer submits it; the vault
            checks every rule before a single token leaves.
          </p>
        </div>
        <FlowDiagram />
        <div className="facts3">
          <div>
            <h3>The contract is the policy</h3>
            <p>
              The rules run inside the payment transaction. A compromised or prompt-injected agent can ask, but the
              vault decides, and it says why in a code the agent can read back.
            </p>
          </div>
          <div>
            <h3>The agent never needs gas</h3>
            <p>
              The agent signs an EIP-712 intent. A relayer submits it and pays the fee, so the agent key holds no funds
              and cannot be drained.
            </p>
          </div>
          <div>
            <h3>Merchants verify from chain data</h3>
            <p>
              A merchant serves a request after reading the payment event from the vault. Paid invoices build a
              receipt-bound reputation for the agent.
            </p>
          </div>
        </div>
      </section>

      <section className="section" id="code">
        <div className="section-h">
          <p className="section-kicker">
            <span className="rule" aria-hidden />
            Integrate
          </p>
          <h2>Two lines to give an agent a budget.</h2>
          <p>
            The SDK wraps signing, relaying and error decoding, so an agent gets a spending limit the same way it gets
            an API key. A companion package, <span className="mono">@warrant/mcp</span>, exposes the same calls as MCP
            tools for agents that work through tool use.
          </p>
        </div>
        <CodeBlock title="agent.ts" code={SDK_CODE} />
      </section>

      <footer className="foot">
        <div className="foot-h">
          <h3>Read the code that holds the money</h3>
          <p>
            The three Warrant contracts are source-verified on the Aevum explorer, so the exact code that holds funds is
            readable there, not only the address. tUSD8 is the testnet token this project did not write, so it is not
            verified; it is listed so you can check a balance.
          </p>
        </div>
        <dl className="foot-links">
          <div>
            <dt>
              WarrantVault (demo) <span className="verified">verified</span>
            </dt>
            <dd>
              <a
                href={`${EXPLORER}/address/${PROOF_VAULT}?tab=contract`}
                target="_blank"
                rel="noreferrer"
                className="mono"
                title={PROOF_VAULT}
              >
                {short(PROOF_VAULT, 6)}
              </a>
            </dd>
          </div>
          <div>
            <dt>
              WarrantFactory <span className="verified">verified</span>
            </dt>
            <dd>
              <a href={`${EXPLORER}/address/${FACTORY}?tab=contract`} target="_blank" rel="noreferrer" className="mono" title={FACTORY}>
                {short(FACTORY, 6)}
              </a>
            </dd>
          </div>
          <div>
            <dt>
              AgentRegistry <span className="verified">verified</span>
            </dt>
            <dd>
              <a href={`${EXPLORER}/address/${REGISTRY}?tab=contract`} target="_blank" rel="noreferrer" className="mono" title={REGISTRY}>
                {short(REGISTRY, 6)}
              </a>
            </dd>
          </div>
          <div>
            <dt>tUSD8 · not ours</dt>
            <dd>
              <a href={`${EXPLORER}/address/${TOKEN}`} target="_blank" rel="noreferrer" className="mono" title={TOKEN}>
                {short(TOKEN, 6)}
              </a>
            </dd>
          </div>
        </dl>
        <p className="foot-note">
          Aevum testnet, chain {CHAIN_ID}. Testnet only, not audited. The relayer pays gas; the agent keys hold none. MIT
          licensed.
        </p>
      </footer>
    </div>
  );
}
