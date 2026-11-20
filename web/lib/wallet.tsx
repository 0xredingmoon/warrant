"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createWalletClient, custom, getAddress, type Address, type WalletClient } from "viem";
import { aevum } from "./chain";
import { CHAIN_ID } from "./config";

interface Eip1193 {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, fn: (...a: any[]) => void) => unknown;
  removeListener?: (event: string, fn: (...a: any[]) => void) => unknown;
}

/**
 * What the page believes about the wallet:
 *  - checking:      asking the wallet (silently) whether this page already has access
 *  - unavailable:   no browser wallet
 *  - disconnected:  no access (never connected, disconnected here, or the wallet revoked it)
 *  - connecting:    the wallet's approval prompt is open
 *  - connected:     the wallet has given this page an account; `chainId` is the wallet's real network
 */
export type WalletStatus = "checking" | "unavailable" | "disconnected" | "connecting" | "connected";

interface Ctx {
  status: WalletStatus;
  address?: Address;
  /** the wallet's current network, which can be anything */
  chainId?: number;
  wrongNetwork: boolean;
  /** only defined when connected on Aevum */
  walletClient?: WalletClient;
  /** true when the page had access before and the wallet no longer grants it */
  lostAccess: boolean;
  /** why the last connect attempt did not work, in plain words (declines are not errors) */
  notice?: { tone: "neutral" | "error"; text: string };
  connect: () => Promise<void>;
  disconnect: () => void;
  /** call when a wallet request fails with "not authorized": the page drops back to disconnected */
  markUnauthorized: () => void;
  /** re-read the wallet's network (after a switch, in case the wallet is slow to announce it) */
  refreshChain: () => Promise<void>;
}

const C = createContext<Ctx | null>(null);
const FLAG = "warrant:wallet"; // "on" after a connect, "off" after Disconnect
const getProvider = (): Eip1193 | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: Eip1193 }).ethereum);
const toChain = (hex: unknown) => (typeof hex === "string" ? parseInt(hex, 16) : typeof hex === "number" ? hex : undefined);
const firstAccount = (a: unknown): Address | undefined => (Array.isArray(a) && typeof a[0] === "string" ? getAddress(a[0]) : undefined);
const code = (e: unknown) => (e as { code?: number })?.code ?? (e as any)?.cause?.code;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>("checking");
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [lostAccess, setLost] = useState(false);
  const [notice, setNotice] = useState<Ctx["notice"]>();
  const prov = useRef<Eip1193 | undefined>(undefined);
  const flag = (v: "on" | "off") => {
    try {
      localStorage.setItem(FLAG, v);
    } catch {
      /* private mode: the page just forgets */
    }
  };
  const was = () => {
    try {
      return localStorage.getItem(FLAG);
    } catch {
      return null;
    }
  };

  const drop = useCallback((lost: boolean) => {
    setAddress(undefined);
    setStatus("disconnected");
    setLost(lost);
  }, []);

  // read the wallet's state once, without a prompt, then follow its events
  useEffect(() => {
    const p = getProvider();
    prov.current = p;
    if (!p) {
      setStatus("unavailable");
      return;
    }
    let live = true;
    (async () => {
      if (was() === "off") return live && drop(false);
      try {
        const acct = firstAccount(await p.request({ method: "eth_accounts" }));
        if (!live) return;
        if (!acct) return drop(was() === "on");
        setChainId(toChain(await p.request({ method: "eth_chainId" })));
        setAddress(acct);
        setStatus("connected");
      } catch {
        if (live) drop(false);
      }
    })();
    const onChain = (c: unknown) => setChainId(toChain(c));
    const onAccounts = (a: unknown) => {
      const acct = firstAccount(a);
      if (!acct) return drop(was() === "on");
      setAddress(acct);
      setStatus("connected");
      setLost(false);
    };
    const onDisconnect = () => drop(was() === "on");
    p.on?.("chainChanged", onChain);
    p.on?.("accountsChanged", onAccounts);
    p.on?.("disconnect", onDisconnect);
    return () => {
      live = false;
      p.removeListener?.("chainChanged", onChain);
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("disconnect", onDisconnect);
    };
  }, [drop]);

  const connect = useCallback(async () => {
    const p = prov.current ?? getProvider();
    if (!p) return setStatus("unavailable");
    setNotice(undefined);
    setStatus("connecting");
    try {
      const acct = firstAccount(await p.request({ method: "eth_requestAccounts" }));
      if (!acct) throw new Error("The wallet did not share an account.");
      setChainId(toChain(await p.request({ method: "eth_chainId" })));
      setAddress(acct);
      setLost(false);
      flag("on");
      setStatus("connected");
    } catch (e) {
      setStatus("disconnected");
      if (code(e) === 4001) setNotice({ tone: "neutral", text: "You declined the connection in your wallet. Nothing happened." });
      else if (code(e) === -32002) setNotice({ tone: "neutral", text: "Your wallet already has a connection request open. Open it and approve or decline." });
      else setNotice({ tone: "error", text: ((e as Error).message ?? "Could not connect.").split("\n")[0]! });
    }
  }, []);

  const disconnect = useCallback(() => {
    flag("off");
    setNotice(undefined);
    drop(false);
    // best effort: ask the wallet to forget this site too (MetaMask supports it)
    void prov.current?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
  }, [drop]);

  const markUnauthorized = useCallback(() => drop(true), [drop]);
  const refreshChain = useCallback(async () => {
    try {
      const c = toChain(await prov.current?.request({ method: "eth_chainId" }));
      if (c !== undefined) setChainId(c);
    } catch {
      /* the next chainChanged event will do it */
    }
  }, []);

  const wrongNetwork = status === "connected" && chainId !== undefined && chainId !== CHAIN_ID;
  const walletClient = useMemo(() => {
    const p = prov.current;
    if (status !== "connected" || !address || !p || wrongNetwork || chainId === undefined) return undefined;
    return createWalletClient({ account: address, chain: aevum, transport: custom(p as any) });
  }, [status, address, wrongNetwork, chainId]);

  const value = useMemo<Ctx>(
    () => ({ status, address, chainId, wrongNetwork, walletClient, lostAccess, notice, connect, disconnect, markUnauthorized, refreshChain }),
    [status, address, chainId, wrongNetwork, walletClient, lostAccess, notice, connect, disconnect, markUnauthorized, refreshChain],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useWallet(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error("WalletProvider missing");
  return v;
}
