"use client";
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet";

/**
 * A short guided walk through the page. It does not explain the whole product: it moves the page to the thing being
 * talked about, names it in one or two sentences, and gets out of the way. Works with no wallet. For a connected
 * owner, the last beat can open the real mandate sheet, so the tour ends at the place where they create their own.

 * Deliberately no auto-advance timer: a reader controls the pace, and nothing runs behind their back.
 */
export interface TourStep {
  /** CSS selector of the element to bring into view */
  target: string;
  title: string;
  body: string;
  /** run an app action (a connected owner can open a sheet); the panel is closed first */
  action?: "openMine";
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: ".hero",
    title: "Start with the shape of the thing",
    body: "An owner funds a vault and hands an agent a mandate: which merchants, how much per payment, per day and in total, and until when. The agent signs payment requests. It never holds the money or the gas, so a stolen agent key cannot drain the vault. On this page you can watch what happens when an agent turns hostile, without connecting a wallet.",
  },
  {
    target: "#try-the-attack",
    title: "Watch a payment get refused",
    body: "These two buttons make a real payment request on Aevum testnet, signed by the demonstration's own agent key. The first tries to pay 250 tUSD8 when the mandate allows 2 per payment. The second pays an address the owner never allowed. The contract refuses both and writes the refusal on-chain. Each result carries the reason code the contract used and a link to the transaction, so you can check it on the explorer yourself.",
  },
  {
    target: ".tour-steps",
    title: "Why the refusal is the interesting part",
    body: "A rejection that only shows up as a message to the agent proves nothing to anyone else. Here the vault records a PaymentRefused event with the amount and a fixed reason code. That record is what the panel reads back, and it is what any other program can read too, without trusting this page.",
  },
  {
    target: "#proof",
    title: "Two kinds of agent, one set of rules",
    body: "The same vault has held a mandate for an ordinary key and for an ERC-4337 smart account. Both tried to overspend and both were refused. The numbers here are read from the contract as you look at them, and each transaction link opens the explorer, so this is not a screenshot of a demo.",
  },
  {
    target: "#decisions",
    title: "The same rules, on a normal day",
    body: "This is what a mandate looks like while an agent behaves. Small purchases to an allowed merchant go through. A page that tries to make the agent pay a stranger is refused. A larger payment waits for the owner. After the owner revokes, everything stops.",
  },
  {
    target: ".hero .cta",
    title: "Now use it with your own wallet",
    body: "Connect an injected wallet on the Aevum testnet to create a vault and issue a mandate. The tour ends here; everything after this point is your own vault and your own rules.",
    action: "openMine",
  },
];

export function Tour({ onOpenMine }: { onOpenMine?: () => void }) {
  const connected = useWallet().status === "connected";
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const step = TOUR_STEPS[i];

  const go = useCallback(
    (n: number) => {
      const next = Math.max(0, Math.min(TOUR_STEPS.length - 1, n));
      setI(next);
      const el = document.querySelector(TOUR_STEPS[next].target);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      // the card sits at the bottom of the viewport; keep what we just scrolled to clear of it
      if (el) {
        const card = document.querySelector<HTMLElement>(".tour");
        const cardH = card?.offsetHeight ?? 0;
        const r = el.getBoundingClientRect();
        if (r.bottom > window.innerHeight - cardH - 16) window.scrollBy({ top: r.bottom - (window.innerHeight - cardH - 24), behavior: "smooth" });
      }
    },
    [],
  );

  // keyboard: arrows move, Escape leaves
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowRight") go(i + 1);
      if (e.key === "ArrowLeft") go(i - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, i, go]);

  const start = () => {
    setOpen(true);
    go(0);
  };
  const close = () => setOpen(false);
  const openMine = () => {
    close();
    onOpenMine?.();
  };

  if (!open) {
    return (
      <button className="btn quiet sm tour-open" onClick={start} aria-label="Start the short tour of this page">
        Take the tour
      </button>
    );
  }

  const last = i === TOUR_STEPS.length - 1;
  return (
    <>
      <div className="tour" role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body">
        <div className="tour-h">
          <span className="tour-count">Step {i + 1} of {TOUR_STEPS.length}</span>
          <button className="tour-x link" onClick={close} aria-label="Close the tour">Close</button>
        </div>
        <h3 id="tour-title">{step.title}</h3>
        <p id="tour-body">{step.body}</p>
        <div className="row tour-actions">
          <button className="btn quiet sm" onClick={() => go(i - 1)} disabled={i === 0}>Back</button>
          {last ? (
            step.action === "openMine" && connected ? (
              <button className="btn sm" onClick={openMine}>Open my vault</button>
            ) : (
              <button className="btn sm" onClick={close}>Done</button>
            )
          ) : (
            <button className="btn sm" onClick={() => go(i + 1)}>Next</button>
          )}
        </div>
      </div>
    </>
  );
}
