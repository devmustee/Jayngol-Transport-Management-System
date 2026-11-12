"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import { LinkButton } from "@/components/ui";
import { StatusPanel } from "./status-panel";

/**
 * Shown when a page fails to load, such as a dropped connection or a slow
 * database. The menus stay usable, and "Try again" reloads only this page.
 */
export function ErrorPanel({
  error,
  reset,
  home,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  home: string;
}) {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
  }, [error]);

  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  return (
    <StatusPanel
      code="Something went wrong"
      title="This page didn't load"
      actions={
        <>
          <button
            type="button"
            onClick={retry}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-gold-deep/20 bg-gradient-to-r from-gold to-gold-light px-5 py-2.5 text-sm font-bold text-ink shadow-gold-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98]"
          >
            <RotateCw size={16} aria-hidden />
            Try again
          </button>
          <LinkButton href={home} variant="secondary">Go to home</LinkButton>
        </>
      }
    >
      <p>Check your connection and try again. Nothing you saved has been lost.</p>
      {error.digest ? (
        <p className="mt-3 text-xs">
          If it keeps happening, tell the Manager this code: <span className="font-mono font-semibold text-ink">{error.digest}</span>
        </p>
      ) : null}
    </StatusPanel>
  );
}
