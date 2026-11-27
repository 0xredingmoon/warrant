"use client";

/**
 * The payment path, drawn once as a real SVG so it can be scanned rather than read. It is a diagram of the contract's
 * control flow, not an illustration: each step names a thing that can say no, and refusal is the branch that carries
 * the state colour. Every colour comes from a token, so the diagram follows the page into dark mode.
 *
 * The agent's edge is routed under the row rather than across it, so no line ever crosses a box. Below 700px the same
 * content is offered as a list instead: at that width this SVG's 12px labels would render at about 4px.
 */
const CHECKS: [string, string, string][] = [
  ["Signature", "by this agent", "Signed by the agent this mandate names"],
  ["Merchant", "on the allowlist", "On the allowlist the owner wrote"],
  ["Per payment", "under the cap", "At or under the per-payment cap"],
  ["Per window", "rolling window", "A rolling window, not a calendar day"],
  ["Lifetime", "within total", "Within the total the mandate allows"],
  ["Expiry", "revoked / expired", "Not expired and not revoked"],
];

export function FlowDiagram() {
  return (
    <div className="flow-card">
      <svg
        className="flow-svg"
        viewBox="0 0 1040 344"
        role="img"
        aria-labelledby="flow-title flow-desc"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id="flow-title">How a payment moves through a Warrant mandate</title>
        <desc id="flow-desc">
          The agent signs an intent and hands it to a relayer, which submits it to the vault and pays the gas. The vault
          checks the signature, the merchant allowlist, the per-payment, periodic and lifetime limits, and the expiry. It
          either pays the merchant or books a refusal with a reason code. The owner funds the vault and can revoke or
          freeze at any time.
        </desc>

        <defs>
          <marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-4)" />
          </marker>
          <marker id="fa-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ok)" />
          </marker>
        </defs>

        {/* ---------------- row: owner → vault → merchant ---------------- */}
        <g>
          <rect x="8" y="24" width="168" height="72" rx="12" fill="var(--card-2)" stroke="var(--line-2)" />
          <text x="24" y="48" fontSize="10" fontWeight="700" letterSpacing="1" fill="var(--ink-3)">OWNER</text>
          <text x="24" y="70" fontWeight="600" fontSize="14" fill="var(--ink)">Funds the vault</text>
          <text x="24" y="87" fontSize="11.5" fill="var(--ink-3)">Can revoke or freeze</text>

          <rect x="264" y="12" width="232" height="96" rx="14" fill="var(--accent)" />
          <text x="284" y="38" fontSize="10" fontWeight="700" letterSpacing="1" fill="var(--accent-fg)" opacity="0.62">WARRANT VAULT</text>
          <text x="284" y="64" fontWeight="600" fontSize="15" fill="var(--accent-fg)">Holds the tUSD8</text>
          <text x="284" y="85" fontSize="12" fill="var(--accent-fg)" opacity="0.7">Checks every rule inside</text>
          <text x="284" y="100" fontSize="12" fill="var(--accent-fg)" opacity="0.7">the payment transaction</text>

          <rect x="584" y="24" width="168" height="72" rx="12" fill="var(--card-2)" stroke="var(--line-2)" />
          <text x="600" y="48" fontSize="10" fontWeight="700" letterSpacing="1" fill="var(--ink-3)">MERCHANT</text>
          <text x="600" y="70" fontWeight="600" fontSize="14" fill="var(--ink)">Serves the goods</text>
          <text x="600" y="87" fontSize="11.5" fill="var(--ink-3)">After reading the event</text>

          <rect x="840" y="12" width="192" height="96" rx="14" fill="var(--card)" stroke="var(--line-2)" />
          <text x="858" y="38" fontSize="10" fontWeight="700" letterSpacing="1" fill="var(--ink-3)">AGENT</text>
          <text x="858" y="64" fontWeight="600" fontSize="14" fill="var(--ink)">Signs the intent</text>
          <text x="858" y="85" fontSize="11.5" fill="var(--ink-3)">EIP-712 · holds no funds</text>
          <text x="858" y="100" fontSize="11.5" fill="var(--ink-3)">holds no gas</text>

          {/* owner funds the vault */}
          <path d="M 180 60 H 258" stroke="var(--ink-4)" strokeWidth="1.4" fill="none" markerEnd="url(#fa)" />
          <text x="192" y="52" fontSize="11" fill="var(--ink-3)">funds</text>

          {/* the vault pays the merchant */}
          <path d="M 500 60 H 578" stroke="var(--ok)" strokeWidth="1.6" fill="none" markerEnd="url(#fa-ok)" />
          <text x="524" y="52" fontSize="11" fill="var(--ok)" fontWeight="600">pays</text>

          {/* the agent's signed intent, routed under the row so the line never crosses a box */}
          <path
            d="M 932 108 V 148 H 380 V 114"
            stroke="var(--ink-4)"
            strokeWidth="1.4"
            fill="none"
            strokeLinejoin="round"
            markerEnd="url(#fa)"
          />
          <text x="500" y="172" fontSize="11" fill="var(--ink-3)">signed intent → relayer submits it and pays the gas</text>
        </g>

        {/* ---------------- row: the checks ---------------- */}
        <line x1="8" y1="196" x2="1032" y2="196" stroke="var(--line)" strokeWidth="1" />
        <text x="8" y="220" fontSize="10" fontWeight="700" letterSpacing="1" fill="var(--ink-3)">
          WHAT THE VAULT CHECKS BEFORE ANY TOKEN MOVES
        </text>

        {CHECKS.map(([title, detail, long], i) => {
          const x = 8 + i * 172;
          return (
            <g key={title}>
              <circle cx={x + 11} cy={252} r="11" fill="var(--card-2)" stroke="var(--line-3)" />
              <text x={x + 11} y={256} textAnchor="middle" fontSize="10.5" fontWeight="700" fill="var(--ink-2)">{i + 1}</text>
              <text x={x + 30} y={248} fontWeight="600" fontSize="12.5" fill="var(--ink)">{title}</text>
              <text x={x + 30} y={264} fontSize="11" fill="var(--ink-3)">{detail}</text>
              <title>{long}</title>
            </g>
          );
        })}

        <rect x="8" y="290" width="700" height="40" rx="10" fill="var(--stop-bg)" stroke="var(--stop-line)" />
        <text x="26" y="315" fontSize="12.5" fill="var(--stop)">
          <tspan fontWeight="700">If any check fails → </tspan>
          <tspan>a PaymentRefused event is written on-chain with a reason code, and no money moves.</tspan>
        </text>
      </svg>

      {/* the same content, legible on a phone */}
      <ol className="flow-list">
        {CHECKS.map(([, , long], i) => (
          <li key={long}>
            <span className="flow-n" aria-hidden>{i + 1}</span>
            <span>
              <span>{long}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="flow-refuse">
        <strong>If any check fails →</strong> a PaymentRefused event is written on-chain with a reason code, and no money
        moves.
      </p>
      <p className="hint" style={{ marginTop: 10 }}>
        These are the six an owner sets. The contract also refuses a merchant past its own per-merchant caps, an invoice
        reference it has already seen, a payment larger than the vault holds, and one above the approval threshold.
      </p>

      <div className="flow-legend">
        <div>
          <b>Owner</b>
          <span>Funds, approves, revokes, freezes. The only party that can withdraw.</span>
        </div>
        <div>
          <b>Vault</b>
          <span>One contract per owner. Every rule lives in it, not in the agent's prompt.</span>
        </div>
        <div>
          <b>Relayer</b>
          <span>Submits signed intents and pays gas. It cannot change what was signed.</span>
        </div>
        <div>
          <b>Agent</b>
          <span>Holds a key and a mandate. No funds, no gas, nothing to drain.</span>
        </div>
      </div>
    </div>
  );
}
