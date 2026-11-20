"use client";
import { useAccount } from "wagmi";
import { Dashboard } from "@/components/Dashboard";
import { Header } from "@/components/Header";
import { Landing } from "@/components/Landing";

export default function Page() {
  const { isConnected, status } = useAccount();
  return (
    <>
      <Header />
      <main>
        {isConnected ? (
          <Dashboard />
        ) : status === "connecting" || status === "reconnecting" ? (
          <div className="wrap"><div className="skel" style={{ width: 240, height: 30 }} /></div>
        ) : (
          <Landing />
        )}
      </main>
    </>
  );
}
