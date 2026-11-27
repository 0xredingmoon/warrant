"use client";
import { useState } from "react";
import { useAttackDemo, useRunAttack, shortAddress, type AttackKind, type AttackOutcome } from "@/lib/attack-demo";

/**
 * One attack row: what the agent will try, a button, and the contract's answer once it has answered.
 *
 * The result is not a message that appears and fades. It stays attached to the row it belongs to, with the reason code
 * the contract used and a link to the transaction, because the whole claim of this page is that the refusal is
 * checkable rather than asserted.
 */
function AttackRow({ plan, agent, outcome, onRun, running }: {
  plan: { kind: AttackKind; attempted: string; amount: string; merchant: string; expectedReason: string };
  agent: string;
  outcome?: AttackOutcome;
  onRun: () => void;
  running: boolean;
}) {
  const refused = outcome?.status === "refused";
  return (
    <div className="attack-row">
      <div className="attack-main">
        <div className="attack-title">{plan.attempted}</div>
        <div className="hint">
          <span className="mono">{plan.amount} tUSD8</span> to{" "}
          <span className="mono" title={plan.merchant}>{shortAddress(plan.merchant)}</span>, signed by the agent key{" "}
          <span className="mono" title={agent}>{shortAddress(agent)}</span>
        </div>
      </div>
      <div className="attack-state">
        {outcome ? (
          refused ? (
            <span className="chip stop">Refused on-chain</span>
          ) : outcome.status === "rejected" ? (
            <span className="chip warn">Not sent</span>
          ) : (
            <span className="chip warn">{outcome.status}</span>
          )
        ) : (
          <button className="btn stop sm" onClick={onRun} disabled={running}>
            {running ? <><span className="spinner" aria-hidden /> Running</> : "Try it"}
          </button>
        )}
      </div>
      {outcome ? (
        <div className="attack-result" role="status">
          <p>
            <strong>The vault answered:</strong> {outcome.check.message}
          </p>
          {outcome.note ? <p className="err">{outcome.note}</p> : null}
          <div className="row">
            {outcome.check.reason ? <span className="tag">{outcome.check.reason}</span> : null}
            {outcome.txHash && outcome.explorerUrl ? (
              <a href={outcome.explorerUrl} target="_blank" rel="noreferrer">
                See the refusal on the explorer
              </a>
            ) : null}
            <button className="link" onClick={onRun} disabled={running}>
              run again
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Try the attack": a judge-facing panel that needs no wallet. The relayer holds the demonstration's agent key and
 * signs two fixed hostile payments; the vault refuses both and records the refusal on-chain. The point is that the
 * agent key really does sign, and the contract still says no.
 */
export function AttackPanel() {
  const { data: view, isLoading, isError } = useAttackDemo();
  const attack = useRunAttack();
  const [outcomes, setOutcomes] = useState<Partial<Record<AttackKind, AttackOutcome>>>({});
  const [error, setError] = useState<string | null>(null);

  // the relayer does not offer the demo (or is offline): say nothing rather than show an empty promise
  if (isLoading || isError || !view) return null;

  const run = (kind: AttackKind) => {
    setError(null);
    attack.mutate(kind, {
      onSuccess: (r) => setOutcomes((prev) => ({ ...prev, [kind]: r })),
      onError: (e) => setError((e as Error).message),
    });
  };
  const running = (kind: AttackKind) => attack.isPending && attack.variables === kind;
  const exhausted = view.terms.revoked || view.terms.expired || view.terms.frozen;

  return (
    <section className="panel attack" id="try-the-attack" aria-labelledby="attack-title">
      <div className="panel-h">
        <h2 id="attack-title">Try the attack</h2>
        <span className="chip">no wallet needed</span>
      </div>
      <div className="panel-b stack-sm">
        <p className="attack-lead">
          Give an agent a real mandate, then tell it to break it. Both payments below are signed for real and refused by
          the vault on Aevum testnet.
        </p>

        <dl className="facts">
          <div>
            <dt>Vault</dt>
            <dd>
              <a href={view.vaultUrl} target="_blank" rel="noreferrer" className="mono" title={view.vault}>
                {shortAddress(view.vault)}
              </a>
            </dd>
          </div>
          <div>
            <dt>Allowed merchant</dt>
            <dd className="mono" title={view.allowedMerchant}>{shortAddress(view.allowedMerchant)}</dd>
          </div>
          <div>
            <dt>Per payment</dt>
            <dd className="num">{view.terms.perTxCap} tUSD8</dd>
          </div>
          <div>
            <dt>Per period</dt>
            <dd className="num">{view.terms.periodCap} tUSD8</dd>
          </div>
        </dl>

        {exhausted ? (
          <p className="hint">
            This demonstration mandate is {view.terms.revoked ? "revoked" : view.terms.frozen ? "frozen" : "expired"}, so
            every attempt is refused for that reason rather than the rule it was testing. The refusals below still
            happened and are still on-chain.
          </p>
        ) : null}

        <div className="attack-rows">
          {view.attacks.map((a) => (
            <AttackRow
              key={a.kind}
              plan={a}
              agent={view.agent}
              outcome={outcomes[a.kind]}
              onRun={() => run(a.kind)}
              running={running(a.kind)}
            />
          ))}
        </div>

        {error ? <p className="err" role="alert">{error}</p> : null}
        {attack.isPending ? (
          <p className="hint waiting" role="status">
            <span className="spinner dark" aria-hidden /> The agent signed the payment. The relayer is sending it and
            waiting for the block that records the refusal.
          </p>
        ) : null}
        <p className="hint">
          The relayer signs only these two fixed payments with the demonstration key, and that key holds no tQDAY. It
          cannot pay anything, to anyone, even if this page asked it to.
        </p>
      </div>
    </section>
  );
}
