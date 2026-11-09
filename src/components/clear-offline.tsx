"use client";

import { useEffect } from "react";

/**
 * Removes the saved inspection page when nobody is logged in, so the next
 * person on a shared phone cannot open it. Unsent inspections stay queued and
 * are only sent once their owner logs back in.
 */
export function ClearOffline() {
  useEffect(() => {
    if ("caches" in window) void caches.delete("jayngol-pages-v1");
  }, []);
  return null;
}
