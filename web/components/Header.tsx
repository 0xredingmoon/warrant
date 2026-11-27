"use client";
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { asset } from "@/lib/config";
import { short } from "@/lib/format";
import { useGasBalance } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";

const NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  11155111: "Sepolia",
};

/** The marks in the bar. They only exist on the landing page, where there is something to jump to. */
const SECTIONS = [
  { id: "try-the-attack", label: "Live demo" },
  { id: "proof", label: "Proof" },
  { id: "how", label: "How it works" },
  { id: "code", label: "API" },
];

export function ConnectButton({ big = false }: { big?: boolean }) {
  const { status, connect, notice, lostAccess } = useWallet();
  if (status === "unavailable") {
    // the one place this sentence appears; the header only carries a status chip
    return (
      <span className="hint" role="alert">
        No browser wallet found. Install MetaMask or Rabby, then reload.
      </span>
    );
  }
  const waiting = status === "connecting";
  return (
    <span style={{ display: "inline-grid", gap: 6, justifyItems: "start" }}>
      <button
        className={`btn${big ? " lg" : ""}`}
        disabled={waiting || status === "checking"}
        onClick={() => void connect()}
      >
        {waiting ? "Waiting for your wallet…" : lostAccess ? "Reconnect wallet" : "Connect wallet"}
      </button>
      {lostAccess && !notice && (
        <span className="hint" role="status">Your wallet no longer shares an account with this page. Reconnect to continue.</span>
      )}
      {notice && <span className={notice.tone === "error" ? "err" : "hint"} role="status">{notice.text}</span>}
    </span>
  );
}

/**
 * Which section the reader is actually inside, so the bar can say where they are. Observer thresholds are deliberately
 * loose: the bar should settle on the section being read, not flicker between two that are both half on screen.
 */
function useActiveSection(enabled: boolean) {
  const [active, setActive] = useState<string>();
  useEffect(() => {
    if (!enabled) return;
    // The attack panel renders nothing until its first read resolves, so #try-the-attack does not exist on mount. Watch
    // the DOM for the sections as they appear instead of querying once and losing the first one for good.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        let best: string | undefined;
        let bestRatio = 0;
        for (const [id, r] of seen) if (r > bestRatio) { best = id; bestRatio = r; }
        setActive(bestRatio > 0.08 ? best : undefined);
      },
      // the bar height is a token that changes between phone and desktop; read it rather than hard-coding one value
      { rootMargin: `-${getComputedStyle(document.documentElement).getPropertyValue("--bar-h").trim() || "56px"} 0px -45% 0px`, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    const seen = new Map<string, number>();
    const watched = new Set<Element>();
    const attach = () => {
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && !watched.has(el)) { watched.add(el); io.observe(el); }
      }
    };
    attach();
    const mo = new MutationObserver(attach);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, [enabled]);
  return active;
}

export function Header({ inApp = false }: { inApp?: boolean }) {
  const { status, address, chainId, wrongNetwork, disconnect } = useWallet();
  const connected = status === "connected" && !!address;
  const gas = useGasBalance(connected && !wrongNetwork ? address : undefined);
  // the section marks only point at things on the landing page, so they hide when the dashboard is showing
  const onLanding = !connected && !inApp;
  const active = useActiveSection(onLanding);

  return (
    <header className="bar">
      <div className="bar-in">
        <a className="wordmark" href={asset("/")} aria-label="Warrant, home">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="1.2" y="1.2" width="21.6" height="21.6" rx="5.4" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 12.4l3.1 3.2 6.9-7.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Warrant<small>Aevum testnet</small>
        </a>

        {onLanding ? (
          <nav className="nav" aria-label="Sections">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined}>
                {s.label}
              </a>
            ))}
          </nav>
        ) : (
          <a className="link" href={asset("/")} style={{ fontSize: 14 }}>
            ← Overview
          </a>
        )}

        <span className={`net ${wrongNetwork ? "bad" : ""}`} role="status">
          <i className={`dot ${wrongNetwork ? "off" : connected ? "" : "idle"}`} aria-hidden />
          {/* On a phone the dot stays but the full sentence does not fit; the short form keeps the dot meaning
              something instead of leaving an unlabelled mark for a sighted reader and nothing at all for a
              screen reader. */}
          <span className="net-full">
            {wrongNetwork
              ? `Wallet is on ${NAMES[chainId!] ?? `chain ${chainId}`}, not Aevum`
              : connected
                ? "Connected to Aevum"
                : "Aevum testnet · wallet not connected"}
          </span>
          {/* The short form is what fits on a phone. It stays in the accessibility tree with its own label, because
              hiding the full sentence on small screens must not leave a screen reader hearing a bare "Not connected"
              with no idea what is not connected. */}
          <span className="net-short" aria-label={
            wrongNetwork
              ? `Wallet is on ${NAMES[chainId!] ?? `chain ${chainId}`}, not Aevum`
              : connected
                ? "Wallet connected to Aevum testnet"
                : "Aevum testnet, wallet not connected"
          }>
            {wrongNetwork ? "Wrong network" : connected ? "Connected" : "Not connected"}
          </span>
        </span>

        {connected ? (
          <>
            {gas.data !== undefined && !wrongNetwork && (
              <span className="num muted" title="tQDAY for gas" style={{ fontSize: 13 }}>
                {Number(formatEther(gas.data)).toFixed(4)} tQDAY
              </span>
            )}
            <button className="btn quiet sm" onClick={disconnect} title="Disconnect">
              <span className="mono">{short(address!)}</span> · Disconnect
            </button>
          </>
        ) : status === "connecting" ? (
          <span className="muted" style={{ fontSize: 13 }}>Waiting for your wallet…</span>
        ) : status === "checking" ? null : status === "unavailable" ? null : (
          <ConnectButton />
        )}
      </div>

      {/* On a phone the marks cannot fit in the bar, so they become a scrollable rail directly under it. Same
          targets, same order, nothing hidden behind a menu. */}
      {onLanding ? (
        <nav className="nav-rail" aria-label="Sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined}>
              {s.label}
            </a>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
