"use client";

import "./globals.css";

// Replaces the whole page when even the outer frame fails, so it brings its
// own <html> and keeps to plain links.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center bg-paper p-4 text-ink antialiased">
        <div className="w-full max-w-md rounded-3xl border border-line bg-card p-6 text-center shadow-premium sm:p-8">
          <div className="text-sm font-medium text-muted">Jayngol</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Jayngol didn&apos;t load</h1>
          <p className="mt-2 text-sm text-muted">Check your connection and try again. Nothing you saved has been lost.</p>
          {error.digest ? <p className="mt-3 text-xs text-muted">Code: <span className="font-mono">{error.digest}</span></p> : null}
          <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
            <button
              type="button"
              onClick={reset}
              className="min-h-12 rounded-xl bg-gold px-5 text-sm font-bold text-ink"
            >
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-line-strong px-5 text-sm font-semibold">
              Go to home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
