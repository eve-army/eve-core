"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { useState } from "react";

const SolanaConnectors = toSolanaWalletConnectors();

/** Mirrors social-tts `providers.tsx` — Solana-only wallets for ops login. */
const privyConfig = {
  appearance: {
    theme: "dark" as const,
    accentColor: "#22d3ee" as const,
    walletChainType: "solana-only" as const,
    walletList: ["phantom", "solflare", "detected_solana_wallets"],
  },
  externalWallets: {
    solana: {
      connectors: SolanaConnectors,
    },
  },
} satisfies PrivyClientConfig;

export function OpsPrivyShell({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() || "";

  if (!appId) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center p-6 text-amber-400 text-sm text-center">
        Set <code className="text-cyan-300">NEXT_PUBLIC_PRIVY_APP_ID</code> for Privy (same app as
        social-tts).
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <PrivyProvider appId={appId} config={privyConfig}>
        {children}
      </PrivyProvider>
    </QueryClientProvider>
  );
}
