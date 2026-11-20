"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { explainError, isUnauthorized, isUserRejection } from "@warrant/sdk";
import { txLink } from "./format";
import { useWallet } from "./wallet";

export interface Toast {
  id: number;
  /** neutral: the owner said no in their wallet. Not a failure. */
  tone: "pending" | "ok" | "error" | "neutral";
  title: string;
  detail?: string;
  hash?: string;
}

interface Ctx {
  toasts: Toast[];
  dismiss: (id: number) => void;
  /**
   * Run a transaction flow with progress and error reporting. Returns the result, or undefined if it failed.
   * `onSuccess` runs the moment the flow resolves (receipt in hand), before the slower refetch: use it to update what is on screen.
   */
  run: <T extends { hash?: string }>(title: string, fn: () => Promise<T>, opts?: { onSuccess?: (res: T) => void }) => Promise<T | undefined>;
  busy: boolean;
}

const C = createContext<Ctx | null>(null);
const MAX_TOASTS = 3;
const AUTO_DISMISS = { ok: 6000, neutral: 7000 } as const;

export function TxProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busyCount, setBusy] = useState(0);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const qc = useQueryClient();
  const { markUnauthorized } = useWallet();

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const settle = useCallback(
    (id: number, p: Partial<Toast> & { tone: Toast["tone"] }) => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, ...p } : x)));
      const ms = p.tone === "ok" ? AUTO_DISMISS.ok : p.tone === "neutral" ? AUTO_DISMISS.neutral : 0;
      if (ms) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const run: Ctx["run"] = useCallback(
    async (title, fn, opts) => {
      const id = next.current++;
      setToasts((t) => {
        // one toast per action: a repeat replaces the earlier one, and only the newest few stay on screen
        const rest = t.filter((x) => x.title !== title);
        return [...rest, { id, tone: "pending" as const, title, detail: "Confirm in your wallet, then wait for the block." }].slice(-MAX_TOASTS);
      });
      setBusy((n) => n + 1);
      try {
        const res = await fn();
        settle(id, { tone: "ok", detail: undefined, hash: res?.hash });
        opts?.onSuccess?.(res);
        // refresh in the background; the screen already shows the result
        void qc.invalidateQueries();
        setTimeout(() => void qc.invalidateQueries(), 3000);
        return res;
      } catch (e) {
        if (isUserRejection(e)) settle(id, { tone: "neutral", detail: explainError(e) });
        else {
          if (isUnauthorized(e)) markUnauthorized();
          settle(id, { tone: "error", detail: explainError(e) });
        }
        return undefined;
      } finally {
        setBusy((n) => n - 1);
      }
    },
    [markUnauthorized, qc, settle],
  );

  const value = useMemo(() => ({ toasts, dismiss, run, busy: busyCount > 0 }), [toasts, dismiss, run, busyCount]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export const useTx = () => {
  const v = useContext(C);
  if (!v) throw new Error("TxProvider missing");
  return v;
};

export function Toasts() {
  const { toasts, dismiss } = useTx();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <div className="toast-main">
            <strong>{t.title}</strong>
            {t.tone === "pending" && <span className="spinner" aria-hidden />}
            {t.tone === "ok" && <span className="muted">Done</span>}
          </div>
          {t.detail && <p>{t.detail}</p>}
          {t.hash && (
            <a href={txLink(t.hash)} target="_blank" rel="noreferrer" className="mono">
              View transaction ↗
            </a>
          )}
          {t.tone !== "pending" && (
            <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
