"use client";
import { useEffect, useState } from "react";
import { RELAYER_URL } from "./config";

export interface RelayerStatus {
  /** A public relayer URL is configured (not a placeholder). */
  configured: boolean;
  /** True once /health has answered ok. False if unconfigured, or the probe failed. Null while probing. */
  online: boolean | null;
}

/** Probe the configured relayer. Failures are quiet: the rest of the dashboard still works. */
export function useRelayer(): RelayerStatus {
  const [online, setOnline] = useState<boolean | null>(RELAYER_URL ? null : false);
  useEffect(() => {
    if (!RELAYER_URL) {
      setOnline(false);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    fetch(`${RELAYER_URL}/health`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => setOnline(j?.ok === true))
      .catch(() => setOnline(false));
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, []);
  return { configured: !!RELAYER_URL, online };
}

/** Short, non-blocking note when gasless relays are unavailable. */
export function RelayerNotice() {
  const { configured, online } = useRelayer();
  if (online === true || online === null) return null;
  return (
    <p className="hint" role="status" style={{ margin: 0 }}>
      Relayer offline. You can still read the chain and send deposits or approvals from your wallet; gasless relay will return once it is hosted.
      {!configured ? " The public relayer URL has not been set yet." : null}
    </p>
  );
}
