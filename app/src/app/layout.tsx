import type { Metadata } from "next";
import "./globals.css";
import { WalletButton } from "@/components/WalletButton";
import { WalletRepLink } from "@/components/WalletRepLink";

export const metadata: Metadata = {
  title: "CircleUp — On-Chain Savings Circles",
  description:
    "Rotating savings & credit associations (Ajo / Esusu / Tanda / Chama) on Stellar Soroban",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50">
        <nav className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <span className="text-2xl">🔄</span>
          <span className="font-bold text-slate-800 text-lg">CircleUp</span>
          <span className="text-slate-400 text-sm hidden sm:block">
            Trustless savings circles on Stellar
          </span>
          <div className="ml-auto flex gap-4 text-sm">
            <a href="/" className="text-slate-600 hover:text-brand-600 transition-colors">
              Circles
            </a>
            <a href="/create" className="text-slate-600 hover:text-brand-600 transition-colors">
              Create
            </a>
            <WalletRepLink />
            <WalletButton />
          </div>
        </nav>
        <main className="max-w-5xl mx-auto px-4 py-8">{children}</main>
        <footer className="text-center text-xs text-slate-400 py-8">
          Built on Stellar Soroban · Testnet
        </footer>
      </body>
    </html>
  );
}
