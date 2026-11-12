"use client";

import { CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const EVENT = "jayngol:toast";
const SHOW_FOR_MS = 3000;

/** Shows a short "saved" message at the top of the screen. */
export function showToast(message: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: message }));
}

type Toast = { id: number; message: string; leaving: boolean };

/**
 * The pop-up for saved actions, so success is seen even when the form's own
 * message is below the screen. Screen readers already hear that message, so
 * this one is visual only.
 */
export function Toaster() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const onToast = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      timers.current.forEach(clearTimeout);
      const id = Date.now();
      setToast({ id, message, leaving: false });
      timers.current = [
        setTimeout(() => setToast((t) => (t?.id === id ? { ...t, leaving: true } : t)), SHOW_FOR_MS),
        setTimeout(() => setToast((t) => (t?.id === id ? null : t)), SHOW_FOR_MS + 250),
      ];
    };
    window.addEventListener(EVENT, onToast);
    return () => {
      window.removeEventListener(EVENT, onToast);
      timers.current.forEach(clearTimeout);
    };
  }, []);

  if (!toast) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[70] flex justify-center px-4 print:hidden"
    >
      <div
        key={toast.id}
        className={`pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-2xl border border-line bg-card px-4 py-3 text-sm font-semibold text-ink shadow-[0_8px_24px_-10px_rgb(26_21_12/0.25)] ${
          toast.leaving ? "animate-toast-out" : "animate-toast-in"
        }`}
        onClick={() => setToast(null)}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ok-wash">
          <CheckCircle2 size={18} className="text-ok" aria-hidden />
        </span>
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
