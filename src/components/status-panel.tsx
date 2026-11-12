import type { ReactNode } from "react";

/** The one look for "not found" and "something went wrong", everywhere. */
export function StatusPanel({
  code,
  title,
  children,
  actions,
}: {
  code: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center py-8">
      <div className="w-full max-w-md animate-page-in rounded-3xl border border-line bg-card p-6 text-center shadow-premium sm:p-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/jayngol-mark.svg" alt="" width={56} height={56} className="mx-auto" />
        <div className="mt-4 text-xs font-bold tracking-[0.2em] text-gold-deep uppercase">{code}</div>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
        <div className="mt-2 text-sm leading-relaxed text-muted">{children}</div>
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">{actions}</div>
      </div>
    </div>
  );
}
