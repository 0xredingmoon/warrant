import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Instrument_Serif } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";
import { BASE_PATH, asset } from "@/lib/config";

// Inter stands in for SF Pro: the same tall x-height and tight, neutral tracking, for the interface.
// Instrument Serif carries the headline only. One display face against a neutral interface is what stops the page
// from looking like every other generated dashboard; it also gives the large headline a voice of its own.
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const display = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-display", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Warrant: spending mandates for AI agents",
  description: "Give an AI agent a spending mandate instead of a wallet key. Caps, an allowlist, an approval step and instant revoke, enforced by a contract on Aevum.",
  // GitHub Pages serves the app under /warrant/; metadata URLs should match.
  metadataBase: new URL(BASE_PATH ? `https://0xredingmoon.github.io${BASE_PATH}/` : "http://localhost:3000/"),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <head>
        {/* deploy-time settings (relayer URL etc.); a plain blocking script so it runs before the app reads its config */}
        <script src={asset("/config.js")} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
