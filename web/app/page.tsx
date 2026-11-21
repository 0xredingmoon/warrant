"use client";
import { Dashboard } from "@/components/Dashboard";
import { Header } from "@/components/Header";
import { Landing } from "@/components/Landing";
import { RelayerNotice } from "@/lib/relayer";
import { useWallet } from "@/lib/wallet";

export default function Page() {
  const { status } = useWallet();
  return (
    <>
      <Header />
      <div className="wrap" style={{ paddingTop: 10, paddingBottom: 0 }}>
        <RelayerNotice />
      </div>
      <main>{status === "connected" ? <Dashboard /> : <Landing />}</main>
    </>
  );
}
