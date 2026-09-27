import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Product Intelligence Engine',
  description: 'Evidence-first product research and validation.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-neutral-200 dark:border-neutral-800">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <a href="/" className="text-sm font-semibold tracking-tight">
              Product Intelligence Engine
            </a>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Phase 1 — evidence-first research
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
