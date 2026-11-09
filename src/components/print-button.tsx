"use client";

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">
      Save as PDF
    </button>
  );
}
