"use client";

import { useEffect } from "react";

/**
 * Takes one-time notes such as ?given=1 out of the address once the page has
 * shown them, so a refresh or coming back does not show them again.
 */
export function ForgetParams({ names }: { names: string[] }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    let changed = false;
    for (const name of names) {
      if (url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    if (changed) window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [names]);
  return null;
}
