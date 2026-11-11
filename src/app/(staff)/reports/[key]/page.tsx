import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, queryValue } from "@/lib/format";
import { readHistoryFilter } from "@/lib/history-filter";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { GROUPING_LABELS, GROUPINGS, isReportKey, parseGrouping, runReport, type Column } from "@/services/reports";

export const metadata: Metadata = { title: "Report" };

const INPUT = "mt-1 min-h-11 w-full rounded-lg border border-line bg-card px-3 text-base";

function money(kobo: number) {
  return `${kobo < 0 ? "-" : ""}${formatNaira(Math.abs(kobo))}`;
}

function show(column: Column, value: string | number | undefined) {
  if (value === undefined || value === null || value === "") return "—";
  if (column.kind === "naira") return money(Number(value));
  if (column.kind === "date") return formatDate(String(value));
  if (column.kind === "number") return Number(value).toLocaleString("en-NG");
  return column.labels?.[String(value)] ?? String(value);
}

const alignment = (column: Column) => (column.kind === "naira" || column.kind === "number" ? "text-right tabular-nums" : "text-left");

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("finance.view");
  const { key } = await params;
  if (!isReportKey(key)) notFound();
  const query = await searchParams;
  const filter = readHistoryFilter(query);
  const today = businessDate(ctx.clock());
  const [from, to] = [filter.from ?? `${today.slice(0, 8)}01`, filter.to ?? today].sort() as [string, string];
  const report = await runReport(ctx, key, { from, to }, parseGrouping(queryValue(query.group)));
  const csvHref = `/api/reports/${key}?from=${from}&to=${to}${report.groupable ? `&group=${report.group}` : ""}`;

  return (
    <>
      <PageHeader
        title={report.title}
        subtitle={report.ranged ? `${formatDate(from)} to ${formatDate(to)}` : `As of ${formatDate(today)}`}
        back={{ href: "/reports", label: "Reports" }}
      />
      <div className="mb-4 space-y-3 print:hidden">
        {report.ranged ? (
          <form className={`grid grid-cols-2 items-end gap-3 ${report.groupable ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
            <label className="min-w-0 font-medium">
              From
              <input type="date" name="from" defaultValue={from} className={INPUT} />
            </label>
            <label className="min-w-0 font-medium">
              To
              <input type="date" name="to" defaultValue={to} className={INPUT} />
            </label>
            {report.groupable ? (
              <label className="col-span-2 min-w-0 font-medium sm:col-span-1">
                Group by
                <select name="group" defaultValue={report.group} className={INPUT}>
                  {GROUPINGS.map((group) => (
                    <option key={group} value={group}>
                      {GROUPING_LABELS[group]}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button className="col-span-2 min-h-11 rounded-lg bg-ink px-4 font-semibold text-gold-light sm:col-span-1">Show</button>
          </form>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <a href={csvHref} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-card px-4 font-semibold">
            Download CSV
          </a>
          <PrintButton />
        </div>
      </div>
      {report.rows.length === 0 ? (
        <Empty>Nothing to show for these dates.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-card print:overflow-visible print:border-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                {report.columns.map((column) => (
                  <th key={column.key} scope="col" className={`px-3 py-2 font-semibold whitespace-nowrap ${alignment(column)}`}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {report.rows.map((row, index) => (
                <tr key={index}>
                  {report.columns.map((column) => (
                    <td key={column.key} className={`px-3 py-2 whitespace-nowrap ${alignment(column)}`}>{show(column, row[column.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {Object.keys(report.totals).length > 0 ? (
              <tfoot>
                <tr className="border-t-2 border-line font-bold">
                  {report.columns.map((column, index) => (
                    <td key={column.key} className={`px-3 py-2 whitespace-nowrap ${alignment(column)}`}>
                      {column.total ? show(column, report.totals[column.key]) : index === 0 ? "Total" : ""}
                    </td>
                  ))}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </>
  );
}
