"use client";
import { Dashboard } from "@/components/Dashboard";
import { Header } from "@/components/Header";
import { Landing } from "@/components/Landing";
import { useWallet } from "@/lib/wallet";

export default function Page() {
  const { status } = useWallet();
  return (
    <>
      <Header />
      <main>{status === "connected" ? <Dashboard /> : <Landing />}</main>
    </>
  );
}
