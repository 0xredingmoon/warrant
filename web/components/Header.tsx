"use client";
import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { formatEther } from "viem";
import { useEffect, useState } from "react";
import { short } from "@/lib/format";

export function ConnectButton({ big = false }: { big?: boolean }) {
  const { connectors, connect, isPending, error } = useConnect();
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  useEffect(() => setHasWallet(typeof window !== "undefined" && !!(window as any).ethereum), []);
  const connector = connectors[0];
  if (hasWallet === false) {
    return (
      <span className="hint" role="alert">
        No browser wallet found. Install MetaMask or Rabby, then reload.
      </span>
    );
  }
  return (
    <span style={{ display: "inline-grid", gap: 6 }}>
      <button className="btn" style={big ? { padding: "12px 20px", fontSize: 15 } : undefined} disabled={!connector || isPending} onClick={() => connector && connect({ connector })}>
        {isPending ? "Waiting for wallet…" : "Connect wallet"}
      </button>
      {error && <span className="err">{error.message.split("\n")[0]}</span>}
    </span>
  );
}

export function Header() {
  const { address, isConnected, status } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: gas } = useBalance({ address, query: { refetchInterval: 10_000 } });
  return (
    <header className="bar">
      <div className="bar-in">
        <a className="wordmark" href="/">
          Warrant<small>Aevum testnet</small>
        </a>
        <span className="net">
          <i className="dot" aria-hidden />
          <span>chain 44005</span>
        </span>
        {isConnected && address ? (
          <>
            {gas && (
              <span className="num muted" title="tQDAY for gas" style={{ fontSize: 13 }}>
                {Number(formatEther(gas.value)).toFixed(4)} tQDAY
              </span>
            )}
            <button className="btn quiet sm" onClick={() => disconnect()} title="Disconnect">
              <span className="mono">{short(address)}</span> · Disconnect
            </button>
          </>
        ) : status === "connecting" || status === "reconnecting" ? (
          <span className="muted" style={{ fontSize: 13 }}>Connecting…</span>
        ) : (
          <ConnectButton />
        )}
      </div>
    </header>
  );
}
