"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { explainError } from "@warrant/sdk";
import { txLink } from "./format";

export interface Toast {
  id: number;
  tone: "pending" | "ok" | "error";
  title: string;
  detail?: string;
  hash?: string;
}

interface Ctx {
  toasts: Toast[];
  dismiss: (id: number) => void;
  /** Run a transaction flow with progress and error reporting. Returns the result, or undefined if it failed. */
  run: <T extends { hash?: string }>(title: string, fn: () => Promise<T>) => Promise<T | undefined>;
  busy: boolean;
}

const C = createContext<Ctx | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busyCount, setBusy] = useState(0);
  const next = useRef(1);
  const qc = useQueryClient();

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const patch = useCallback((id: number, p: Partial<Toast>) => setToasts((t) => t.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  const run: Ctx["run"] = useCallback(
    async (title, fn) => {
      const id = next.current++;
      setToasts((t) => [...t, { id, tone: "pending", title, detail: "Confirm in your wallet, then wait for the block." }]);
      setBusy((n) => n + 1);
      try {
        const res = await fn();
        patch(id, { tone: "ok", detail: undefined, hash: res?.hash });
        setTimeout(() => dismiss(id), 6000);
        await qc.invalidateQueries();
        return res;
      } catch (e) {
        patch(id, { tone: "error", detail: explainError(e) });
        return undefined;
      } finally {
        setBusy((n) => n - 1);
      }
    },
    [dismiss, patch, qc],
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
      {toasts.slice(-3).map((t) => (
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
