"use client";
import { useEffect, useState } from "react";
import { Dashboard, DemoDashboard } from "@/components/Dashboard";
import { Header } from "@/components/Header";
import { Landing } from "@/components/Landing";
import { RelayerNotice } from "@/lib/relayer";
import { useWallet } from "@/lib/wallet";

/**
 * Two views, chosen by the URL hash so the choice survives a reload and can be linked to: the landing page at `/`, and
 * the vault dashboard at `/#app`.
 *
 * The dashboard no longer requires a wallet. A visitor who arrives without one sees the demonstration vault reading its
 * real state off the chain, which is what makes this app legible to someone who will not install MetaMask just to look.
 * Connecting a wallet switches the same view to the visitor's own vault; the write controls were always gated on role,
 * so nothing becomes actionable to a stranger.
 */
export default function Page() {
  const { status } = useWallet();
  const connected = status === "connected";
  const [route, setRoute] = useState<"home" | "app">("home");

  useEffect(() => {
    const read = () => setRoute(window.location.hash === "#app" ? "app" : "home");
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  // a connected owner always lands in their own vault, whatever the hash said
  const inApp = connected || route === "app";

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Header inApp={inApp} />
      <div className="wrap" style={{ paddingTop: 0, paddingBottom: 0 }}>
        <RelayerNotice />
      </div>
      {/* tabIndex -1 so the skip link actually moves focus here, not just the scroll position */}
      <main id="main" tabIndex={-1}>{inApp ? connected ? <Dashboard /> : <DemoDashboard /> : <Landing />}</main>
    </>
  );
}
