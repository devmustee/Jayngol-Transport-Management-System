import Link from "next/link";
import { PrintButton } from "@/components/print-button";
import { PERIODS, type ReportPeriod } from "@/lib/report-period";

const INPUT = "mt-1 min-h-11 w-full rounded-lg border border-line bg-card px-3 text-base";

/** Period chips, chosen dates and Save as PDF for a workshop report. Hidden when printed. */
export function PeriodPicker({ href, period }: { href: string; period: ReportPeriod }) {
  return (
    <div className="mb-5 space-y-3 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Choose a period" className="flex flex-wrap gap-2">
          {PERIODS.map((p) => {
            const active = period.key === p.key;
            return (
              <Link
                key={p.key}
                href={p.key === "month" ? href : `${href}?period=${p.key}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold ${
                  active ? "border-ink bg-ink text-gold-light" : "border-line bg-card text-ink hover:border-line-strong"
                }`}
              >
                {p.label}
              </Link>
            );
          })}
        </nav>
        <PrintButton />
      </div>
      <details className="group rounded-xl border border-line bg-card px-4 py-1" open={period.key === "custom"}>
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink">Choose dates</summary>
        <form action={href} className="grid grid-cols-2 items-end gap-3 pb-3 sm:grid-cols-3">
          <label className="min-w-0 text-sm font-medium">
            From
            <input type="date" name="from" defaultValue={period.from} max={period.to} className={INPUT} />
          </label>
          <label className="min-w-0 text-sm font-medium">
            To
            <input type="date" name="to" defaultValue={period.to} className={INPUT} />
          </label>
          <button className="col-span-2 min-h-11 rounded-lg bg-ink px-4 font-semibold text-gold-light sm:col-span-1">
            Show
          </button>
        </form>
      </details>
    </div>
  );
}
