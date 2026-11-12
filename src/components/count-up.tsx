"use client";

import { useEffect, useRef, useState } from "react";
import { formatNaira } from "@/lib/money";

const DURATION_MS = 600;
const signed = (kobo: number) => `${kobo < 0 ? "-" : ""}${formatNaira(Math.abs(kobo))}`;

/**
 * A money figure that counts to its value once, from the last value this
 * person saw here, so a returning visit moves only by what changed. The real
 * figure is always in the page for screen readers, copying and printing, and
 * it appears at once when the phone asks for less motion.
 */
export function CountUp({ kobo, id }: { kobo: number; id: string }) {
  const key = `jayngol:count:${id}`;
  const [shown, setShown] = useState(kobo);
  const frame = useRef(0);

  useEffect(() => {
    let from = kobo;
    try {
      const seen = sessionStorage.getItem(key);
      from = seen === null ? 0 : Number(seen);
      sessionStorage.setItem(key, String(kobo));
    } catch {
      from = kobo;
    }
    // Nothing to count, or the effect ran again (React does this in development):
    // always settle on the real figure.
    if (
      from === kobo ||
      !Number.isFinite(from) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(kobo);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - (1 - t) ** 3;
      // Whole naira while moving, the exact figure at the end.
      setShown(t < 1 ? Math.round((from + (kobo - from) * eased) / 100) * 100 : kobo);
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    setShown(from);
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [kobo, key]);

  return (
    <>
      <span className="sr-only">{signed(kobo)}</span>
      <span aria-hidden className="print:hidden">{signed(shown)}</span>
      <span aria-hidden className="hidden print:inline">{signed(kobo)}</span>
    </>
  );
}
