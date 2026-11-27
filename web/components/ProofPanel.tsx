"use client";
import { formatUsd, reasonName } from "@warrant/sdk";
import { PROOF_VAULT, RUNTIMES, txUrl, useKernelIdentity, useProofState, type Runtime } from "@/lib/proof";
import { addrLink, short } from "@/lib/format";

/**
 * The proof surface a judge can check without trusting this page. Every claim below is either an immutable
 * transaction hash or a value read from the contract at this moment: the vault holds one balance, two different kinds
 * of agent have each been refused by it, and one of those agents is a smart account whose spending policy is the
 * mandate. Nothing here is a screenshot.
 */
function RuntimeCard({ r, index, state }: { r: Runtime; index: number; state?: ReturnType<typeof useProofState>["data"] }) {
  const onChainAgent = state?.agents[index];
  const matches = onChainAgent ? onChainAgent.toLowerCase() === r.agent.toLowerCase() : undefined;
  const refusals = state?.refusals[index];
  const spent = state?.spent[index];

  return (
    <article className="proof-card">
      <header className="proof-card-h">
        <span className={`proof-kind ${r.kind}`}>{r.kind === "smart" ? "Smart account" : "Plain key"}</span>
        <span className="chip">mandate #{r.mandateId.toString()}</span>
      </header>
      <h3 className="proof-name">{r.label}</h3>
      <p className="proof-note">{r.note}</p>

      <dl className="proof-facts">
        <div>
          <dt>Agent on file</dt>
          <dd>
            <a href={addrLink(r.agent)} target="_blank" rel="noreferrer" className="mono" title={r.agent}>
              {short(r.agent)}
            </a>{" "}
            {matches === true ? <span className="proof-ok">matches the mandate</span> : matches === false ? <span className="proof-bad">mismatch</span> : null}
          </dd>
        </div>
        <div>
          <dt>Refused by the vault</dt>
          <dd className="num">{refusals !== undefined ? `${refusals.toString()} times` : "reading"}</dd>
        </div>
        <div>
          <dt>Spent under it</dt>
          <dd className="num">{spent !== undefined ? `${formatUsd(spent)} tUSD8` : "reading"}</dd>
        </div>
      </dl>

      <div className="proof-links">
        {r.refused ? (
          <a href={txUrl(r.refused.txHash)} target="_blank" rel="noreferrer" className="proof-link">
            <span className="proof-link-t">Refused {r.refused.amount} tUSD8</span>
            <span className="proof-link-s">{r.refused.reason} ({r.refused.reasonCode}), open the transaction</span>
          </a>
        ) : null}
        {r.paid ? (
          <a href={txUrl(r.paid.txHash)} target="_blank" rel="noreferrer" className="proof-link ok">
            <span className="proof-link-t">Paid {r.paid.amount} tUSD8</span>
            <span className="proof-link-s">inside the same limits, open the transaction</span>
          </a>
        ) : null}
      </div>
    </article>
  );
}

export function ProofPanel() {
  const { data: state, isError } = useProofState();
  const { data: kernel } = useKernelIdentity();
  const account = RUNTIMES[1].agent;

  return (
    <section className="panel proof" id="proof" aria-labelledby="proof-title">
      <div className="panel-h">
        <h2 id="proof-title">Proof you can check</h2>
        <span className="chip">read live from the chain</span>
      </div>
      <div className="panel-b stack-sm">
        <p className="proof-lead">
          One vault, <span className="mono" title={PROOF_VAULT}>{short(PROOF_VAULT)}</span>. Two agents of different
          kinds, the same rules for both.
        </p>

        <div className="proof-balance">
          <span className="muted">Vault holds now</span>
          <strong className="num">
            {state ? `${formatUsd(state.balance)} tUSD8` : "reading"}
            {state?.frozen ? <span className="chip stop" style={{ marginLeft: 10 }}>Frozen</span> : null}
          </strong>
          <span className="hint">A refusal moves nothing. The payments that did leave were inside the mandate.</span>
        </div>

        {isError ? (
          <p className="hint">The chain did not answer just now. The transaction links below still open the explorer.</p>
        ) : null}

        <div className="proof-grid">
          {RUNTIMES.map((r, i) => (
            <RuntimeCard key={r.agent} r={r} index={i} state={state} />
          ))}
        </div>

        <dl className="proof-kernel">
          <div>
            <dt>Account says it is</dt>
            <dd className="mono">{kernel?.accountId ?? "reading"}</dd>
          </div>
          <div>
            <dt>Root validator</dt>
            <dd className="mono" title={kernel?.rootValidator}>{kernel ? short(kernel.rootValidator, 6) : "reading"}</dd>
          </div>
          <div>
            <dt>The account</dt>
            <dd>
              <a href={addrLink(account)} target="_blank" rel="noreferrer" className="mono" title={account}>
                {short(account)}
              </a>
            </dd>
          </div>
        </dl>
        <p className="hint">
          Those two answers come from the account itself, so you do not have to take our word that it is a Kernel
          account. The mandate names it as its agent, and the vault checks its signature the same way it checks a key.
        </p>

        <div className="proof-check">
          <p className="proof-check-h">If you want to check this yourself</p>
          <ol className="proof-steps">
            <li>
              <span>Open the vault address in the explorer and read <span className="mono">getMandate(1)</span> and{" "}
              <span className="mono">getMandate(2)</span>. Their agent addresses must match the two cards above, in that
              order.</span>
            </li>
            <li>
              <span>Open either refusal transaction. Its logs carry <span className="mono">PaymentRefused</span> with the
              amount and the reason code, written by the vault, not by this page.</span>
            </li>
            <li>
              <span>Compare each card's balance and spend figures with the vault's token balance and mandate counters. They
              are read live while you look at them.</span>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}
