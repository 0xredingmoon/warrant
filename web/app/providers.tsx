"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { TxProvider, Toasts } from "@/lib/tx";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 2000, refetchOnWindowFocus: true } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <TxProvider>
          {children}
          <Toasts />
        </TxProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
