import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nav } from "../components/nav.tsx";
import { Providers } from "./providers.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Reorg-safe indexer", template: "%s · Reorg-safe indexer" },
  description: "Read-only dashboard for the reorg-safe Ethereum indexer: status, reorgs, data quality, reconciliation, explorer and analytics.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-blue-800"
        >
          Skip to content
        </a>
        <header className="border-b border-slate-300 bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3">
            <p className="text-lg font-semibold text-slate-900">Reorg-safe indexer</p>
            <Nav />
          </div>
        </header>
        <main id="main" className="mx-auto max-w-6xl px-4 py-6">
          <Providers>{children}</Providers>
        </main>
        <footer className="mx-auto max-w-6xl px-4 py-6 text-sm text-slate-700">All timestamps are UTC. Data is read-only.</footer>
      </body>
    </html>
  );
}
