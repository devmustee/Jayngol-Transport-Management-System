"use client";

import { useState } from "react";
import { Printer, Share2 } from "lucide-react";

/**
 * Print the receipt, or share it as text (WhatsApp, SMS) from a phone. Where
 * sharing is not offered, the text is copied instead.
 */
export function ReceiptActions({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title, text });
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Cancelled, or not allowed: nothing to do.
    }
  };
  const button =
    "inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-card px-4 text-sm font-semibold text-ink hover:bg-gold-wash";
  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      <button type="button" onClick={() => window.print()} className={button}>
        <Printer size={16} aria-hidden /> Print
      </button>
      <button type="button" onClick={share} className={button}>
        <Share2 size={16} aria-hidden /> {copied ? "Copied" : "Share"}
      </button>
    </div>
  );
}
