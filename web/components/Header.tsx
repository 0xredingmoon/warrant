"use client";
import { formatEther } from "viem";
import { asset } from "@/lib/config";
import { short } from "@/lib/format";
import { useGasBalance } from "@/lib/queries";
import { useWallet } from "@/lib/wallet";

const NAMES: Record<number, string> = { 1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 137: "Polygon", 8453: "Base", 42161: "Arbitrum One", 11155111: "Sepolia" };

export function ConnectButton({ big = false }: { big?: boolean }) {
  const { status, connect, notice, lostAccess } = useWallet();
  if (status === "unavailable") {
    return (
      <span className="hint" role="alert">
        No browser wallet found. Install MetaMask or Rabby, then reload.
      </span>
    );
  }
  const waiting = status === "connecting";
  return (
    <span style={{ display: "inline-grid", gap: 6, justifyItems: "start" }}>
      <button className="btn" style={big ? { padding: "12px 20px", fontSize: 15 } : undefined} disabled={waiting || status === "checking"} onClick={() => void connect()}>
        {waiting ? "Waiting for your wallet…" : lostAccess ? "Reconnect wallet" : "Connect wallet"}
      </button>
      {lostAccess && !notice && <span className="hint" role="status">Your wallet no longer shares an account with this page. Reconnect to continue.</span>}
      {notice && <span className={notice.tone === "error" ? "err" : "hint"} role="status">{notice.text}</span>}
    </span>
  );
}

export function Header() {
  const { status, address, chainId, wrongNetwork, disconnect } = useWallet();
  const connected = status === "connected" && !!address;
  const gas = useGasBalance(connected && !wrongNetwork ? address : undefined);
  return (
    <header className="bar">
      <div className="bar-in">
        <a className="wordmark" href={asset("/")}>
          Warrant<small>Aevum testnet</small>
        </a>
        <span className={`net ${wrongNetwork ? "bad" : ""}`} role="status">
          <i className={`dot ${wrongNetwork ? "off" : connected ? "" : "idle"}`} aria-hidden />
          <span>
            {wrongNetwork
              ? `Wallet is on ${NAMES[chainId!] ?? `chain ${chainId}`}, not Aevum`
              : connected
                ? "Connected to Aevum"
                : "Aevum testnet · wallet not connected"}
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
        ) : status === "checking" ? null : (
          <ConnectButton />
        )}
      </div>
    </header>
  );
}
