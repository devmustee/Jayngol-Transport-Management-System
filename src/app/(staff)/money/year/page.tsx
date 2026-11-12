import type { Metadata } from "next";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import type { ReactNode } from "react";
import { PrintButton } from "@/components/print-button";
import { Card, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import {
  annualBalance,
  monthName,
  parseYear,
  yearBounds,
  type MonthRow,
  type YearFigures,
} from "@/services/annual-balance";
import type { DateRange } from "@/lib/periods";

export const metadata: Metadata = { title: "Annual balance" };

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 to 4 Oct", or "28 Sep" for a single day. */
function shortRange({ from, to }: DateRange) {
  const month = SHORT_MONTHS[Number(from.slice(5, 7)) - 1];
  const a = Number(from.slice(8));
  const b = Number(to.slice(8));
  return a === b ? `${a} ${month}` : `${a} to ${b} ${month}`;
}

/** The eight figures each month, week and total shows, in table order. */
const COLUMNS: { label: string; value: (f: YearFigures) => number; phone?: boolean }[] = [
  { label: "Due", value: (f) => f.dueKobo, phone: true },
  { label: "Paid", value: (f) => f.paidKobo, phone: true },
  { label: "Owed", value: (f) => f.owedKobo, phone: true },
  { label: "Received", value: (f) => f.receivedKobo, phone: true },
  { label: "Expenses", value: (f) => f.expensesKobo },
  { label: "Loans given", value: (f) => f.loansGivenKobo },
  { label: "Loans repaid", value: (f) => f.forLoansKobo },
  { label: "Net", value: (f) => f.netKobo },
];

// One grid for the header, every month, week and total, so the columns line up.
// Phones: two columns of labelled figures. Tablets: the four main figures in a row.
// Large screens: all eight.
const ROW = "yr-row";
const SPAN_ALL = "col-span-2 lg:col-span-4 xl:col-span-8";
/** Where a column shows: the four main figures everywhere, the rest on large screens. */
const shown = (phone?: boolean) => (phone ? "" : "hidden xl:block");

function Figures({ figures, strong = false }: { figures: YearFigures; strong?: boolean }) {
  return (
    <>
      {COLUMNS.map((column) => {
        const value = column.value(figures);
        return (
          <div key={column.label} className={column.phone ? "yr-fig" : "yr-fig-wide"}>
            <span className="yr-label">{column.label}</span>
            <span
              className={`yr-val${strong ? " yr-strong" : ""}${
                (column.label === "Owed" && value > 0) || (column.label === "Net" && value < 0) ? " yr-bad" : ""
              }`}
            >
              {formatNaira(value)}
            </span>
          </div>
        );
      })}
    </>
  );
}

function MonthCard({ month, isCurrent }: { month: MonthRow; isCurrent: boolean }) {
  const name = monthName(month.month);
  if (month.future) {
    return (
      <div className={`${ROW} rounded-xl border border-dashed border-line px-4 py-3 text-muted`}>
        <div className="col-span-2 text-sm font-bold lg:col-span-1">{name}</div>
        <div className={`${SPAN_ALL} text-xs`}>Not started yet</div>
      </div>
    );
  }
  return (
    <details className="group rounded-xl border border-line bg-card shadow-sm" open={isCurrent}>
      <summary className={`${ROW} cursor-pointer list-none rounded-xl px-4 py-3 hover:bg-gold-wash/40 [&::-webkit-details-marker]:hidden`}>
        <div className="col-span-2 flex items-center justify-between gap-2 lg:col-span-1">
          <span className="font-extrabold text-ink">{name}</span>
          <span className="inline-flex items-center gap-1 text-xs font-bold text-gold-deep lg:hidden">
            <span className="group-open:hidden">Show weeks</span>
            <span className="hidden group-open:inline">Hide weeks</span>
            <ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden />
          </span>
          <ChevronDown size={16} className="hidden shrink-0 text-gold-deep transition-transform group-open:rotate-180 lg:block" aria-hidden />
        </div>
        <Figures figures={month.figures} strong />
      </summary>
      <div className="space-y-2 border-t border-line/70 px-4 py-3">
        {month.weeks.map((week) => (
          <div key={week.range.from} className={`${ROW} rounded-lg bg-card-subtle/60 px-3 py-2 text-sm`}>
            <div className="col-span-2 text-sm font-semibold text-ink-muted lg:col-span-1">Week {shortRange(week.range)}</div>
            <Figures figures={week.figures} />
          </div>
        ))}
        <div className={`${ROW} rounded-lg border border-gold-light/60 bg-gold-wash/40 px-3 py-2 text-sm`}>
          <div className="col-span-2 font-bold text-ink lg:col-span-1">{name} subtotal</div>
          <Figures figures={month.figures} strong />
        </div>
      </div>
    </details>
  );
}

/** A small table of one figure group per month, with the year total. */
function MonthTable({
  months,
  total,
  columns,
}: {
  months: MonthRow[];
  total: YearFigures;
  columns: { label: string; value: (f: YearFigures) => number }[];
}) {
  const shown = months.filter((m) => !m.future);
  const cell = "px-2 py-2 text-right tabular-nums";
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th className="px-2 py-2 text-left font-semibold">Month</th>
            {columns.map((c) => (
              <th key={c.label} className="px-2 py-2 text-right font-semibold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {shown.map((m) => (
            <tr key={m.month}>
              <td className="px-2 py-2 font-semibold">{SHORT_MONTHS[m.month - 1]}</td>
              {columns.map((c) => (
                <td key={c.label} className={cell}>
                  {formatNaira(c.value(m.figures))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line-strong font-extrabold">
            <td className="px-2 py-2">Year</td>
            {columns.map((c) => (
              <td key={c.label} className={cell}>
                {formatNaira(c.value(total))}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Headline({ label, value, note, tone }: { label: string; value: number; note: string; tone?: "bad" | "good" }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4 shadow-premium">
      <div className="text-xs font-bold uppercase tracking-wider text-muted">{label}</div>
      <div
        className={`mt-1.5 text-xl font-extrabold tabular-nums tracking-tight sm:text-2xl ${
          tone === "bad" ? "text-danger" : tone === "good" ? "text-ok" : "text-ink"
        }`}
      >
        {formatNaira(value)}
      </div>
      <div className="mt-1 text-xs leading-snug text-muted">{note}</div>
    </div>
  );
}

function YearLink({ year, enabled, children, label }: { year: number; enabled: boolean; children: ReactNode; label: string }) {
  const style = "flex h-11 w-11 items-center justify-center rounded-xl border border-line-strong bg-card";
  return enabled ? (
    <Link href={`/money/year?year=${year}`} aria-label={label} className={`${style} text-ink hover:bg-gold-wash`}>
      {children}
    </Link>
  ) : (
    <span aria-hidden className={`${style} text-muted/40`}>
      {children}
    </span>
  );
}

export default async function AnnualBalancePage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const ctx = await requirePage("finance.view");
  const today = businessDate(ctx.clock());
  const year = parseYear(queryValue((await searchParams).year), today);
  const { first, last } = yearBounds(today);
  const report = await annualBalance(ctx, year);
  const { total } = report;
  const currentMonth = year === last ? Number(today.slice(5, 7)) : 0;

  return (
    <>
      <PageHeader
        title={`Annual balance ${year}`}
        subtitle={
          year === last
            ? `January to today (${formatDate(report.upTo)}), by month and by week`
            : "January to December, by month and by week"
        }
        back={{ href: "/money", label: "Money" }}
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <nav aria-label="Choose a year" className="flex items-center gap-2">
          <YearLink year={year - 1} enabled={year > first} label={`Show ${year - 1}`}>
            <ChevronLeft size={18} />
          </YearLink>
          <span className="min-w-16 text-center text-lg font-extrabold tabular-nums">{year}</span>
          <YearLink year={year + 1} enabled={year < last} label={`Show ${year + 1}`}>
            <ChevronRight size={18} />
          </YearLink>
        </nav>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/api/annual-balance?year=${year}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-card px-4 font-semibold"
          >
            <Download size={16} aria-hidden />
            Download CSV
          </a>
          <PrintButton />
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Headline label="Balances due" value={total.dueKobo} note="Every daily balance charged this year" />
        <Headline label="Paid" value={total.paidKobo} note="Paid towards those balances, whenever it came in" />
        <Headline label="Still owed" value={total.owedKobo} note="Due less paid" tone={total.owedKobo > 0 ? "bad" : undefined} />
        <Headline label="Money received" value={total.receivedKobo} note="Every payment taken, less reversals" />
        <Headline
          label="Money out"
          value={total.expensesKobo + total.loansGivenKobo}
          note={`Expenses ${formatNaira(total.expensesKobo)} and loans ${formatNaira(total.loansGivenKobo)}`}
        />
        <Headline label="Net" value={total.netKobo} note="Money received less money out" tone={total.netKobo < 0 ? "bad" : "good"} />
      </div>

      <section aria-label="Months and weeks" className="mb-6 print:hidden">
        <div className={`${ROW} mb-2 hidden px-4 text-xs font-bold uppercase tracking-wider text-muted lg:grid`}>
          <div>Month</div>
          {COLUMNS.map((c) => (
            <div key={c.label} className={`${shown(c.phone)} text-right`}>
              {c.label}
            </div>
          ))}
        </div>
        <p className="mb-2 text-xs text-muted xl:hidden">
          Tap a month to see its weeks. Expenses, loans and Net are in the Money out table below.
        </p>
        <div className="space-y-2">
          {report.months.map((month) => (
            <MonthCard key={month.month} month={month} isCurrent={month.month === currentMonth} />
          ))}
          <div className={`${ROW} rounded-xl border-2 border-ink bg-ink px-4 py-3 text-gold-light [&_.yr-val:not(.yr-bad)]:text-gold-light [&_.yr-label]:text-gold-light/70`}>
            <div className="col-span-2 font-extrabold lg:col-span-1">{year} total</div>
            <Figures figures={total} strong />
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          A week that crosses a month end is split, so the weeks add up to each month and the months to the year. Due and
          Paid follow the day a balance was for. Received follows the day money came in.
        </p>
      </section>

      {/* The printed statement: every month on one page with all columns. */}
      <section className="mb-6 hidden print:block">
        <MonthTable months={report.months} total={total} columns={COLUMNS} />
      </section>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2 [&>*]:min-w-0">
        <Card title="Money received by method">
          <MonthTable
            months={report.months}
            total={total}
            columns={[
              { label: "Cash", value: (f) => f.cashKobo },
              { label: "POS", value: (f) => f.posKobo },
              { label: "Transfer", value: (f) => f.transferKobo },
              { label: "Total", value: (f) => f.receivedKobo },
            ]}
          />
        </Card>
        <Card title="What the money paid for" subtitle="Credit is money kept for an operator's next balance.">
          <MonthTable
            months={report.months}
            total={total}
            columns={[
              { label: "Balances", value: (f) => f.forBalancesKobo },
              { label: "Fines", value: (f) => f.forFinesKobo },
              { label: "Loans", value: (f) => f.forLoansKobo },
              { label: "Credit", value: (f) => f.creditKobo },
            ]}
          />
        </Card>
        <Card title="Money out and net" subtitle="Net is money received less expenses and loans given.">
          <MonthTable
            months={report.months}
            total={total}
            columns={[
              { label: "Expenses", value: (f) => f.expensesKobo },
              { label: "Loans given", value: (f) => f.loansGivenKobo },
              { label: "Net", value: (f) => f.netKobo },
            ]}
          />
        </Card>
        <Card title="Deposits taken" subtitle="Held for operators, so never counted as income or in Net.">
          <MonthTable months={report.months} total={total} columns={[{ label: "Deposits", value: (f) => f.depositsKobo }]} />
        </Card>
      </div>
    </>
  );
}
