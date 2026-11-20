"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/**
 * Folds part of a form away on phones behind a button, so the list below
 * starts higher up. On large screens the fields always show and the button is
 * hidden. The fields stay in the form when folded, so their values are still
 * sent. Starts open when any of them is in use.
 */
export function PhoneFold({ label, active = 0, children }: { label: string; active?: number; children: ReactNode }) {
  const [open, setOpen] = useState(active > 0);
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="col-span-full flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line px-3 font-semibold text-ink lg:hidden"
      >
        <span>
          {label}
          {active > 0 ? ` (${active} on)` : ""}
        </span>
        <ChevronDown size={18} aria-hidden className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <div id={id} className={open ? "contents" : "hidden lg:contents"}>
        {children}
      </div>
    </>
  );
}
