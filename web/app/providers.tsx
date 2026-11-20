"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { TxProvider, Toasts } from "@/lib/tx";
import { WalletProvider } from "@/lib/wallet";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 2000, refetchOnWindowFocus: true } } }));
  return (
    <QueryClientProvider client={qc}>
      <WalletProvider>
        <TxProvider>
          {children}
          <Toasts />
        </TxProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
}
