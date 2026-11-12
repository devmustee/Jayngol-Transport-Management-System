"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

/**
 * A thin gold bar across the top from the moment an in-app link is tapped
 * until the next page is showing, so a slow connection never looks frozen.
 */
function Bar() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const giveUp = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
      // Same page, or only a #section of it: nothing will load.
      if (url.pathname === location.pathname && url.search === location.search) return;
      setState("loading");
      clearTimeout(giveUp.current);
      giveUp.current = setTimeout(() => setState("idle"), 15_000);
    };
    // Capture: Next.js links cancel the browser's own navigation, so by the
    // time a click bubbles up it already looks "prevented".
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // The new page is showing.
  useEffect(() => {
    clearTimeout(giveUp.current);
    setState((now) => (now === "loading" ? "done" : now));
    const hide = setTimeout(() => setState((now) => (now === "done" ? "idle" : now)), 300);
    return () => clearTimeout(hide);
  }, [pathname, search]);

  if (state === "idle") return null;
  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] print:hidden"
    >
      <div
        className={`h-full bg-gold ${
          state === "loading" ? "animate-nav-progress" : "w-full opacity-0 transition-opacity duration-300"
        }`}
      />
    </div>
  );
}

export function NavProgress() {
  return (
    <Suspense fallback={null}>
      <Bar />
    </Suspense>
  );
}
