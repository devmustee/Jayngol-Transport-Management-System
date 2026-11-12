import type { Metadata } from "next";
import Link from "next/link";
import { PeriodPicker } from "@/components/period-picker";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { readReportPeriod, type ReportPeriod } from "@/lib/report-period";
import { requirePage } from "@/lib/session";
import { fleetWorkshopReport, type FleetRow } from "@/services/workshop";

export const metadata: Metadata = { title: "Workshop report" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The same period carried over to one tricycle's report. */
function periodQuery(period: ReportPeriod) {
  if (period.key === "custom") return `?${period.from ? `from=${period.from}&` : ""}to=${period.to}`;
  return period.key === "month" ? "" : `?period=${period.key}`;
}

function Flags({ row }: { row: FleetRow }) {
  if (row.servicesMissed === 0 && !row.mostRepairs && !row.retired) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {row.servicesMissed > 0 ? <Badge tone="bad">{plural(row.servicesMissed, "missed service")}</Badge> : null}
      {row.mostRepairs ? <Badge tone="warning">Most repairs</Badge> : null}
      {row.retired ? <Badge tone="plain">Retired</Badge> : null}
    </span>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4 break-inside-avoid">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-ink">{value}</div>
      {note ? <div className="mt-0.5 text-xs text-muted">{note}</div> : null}
    </div>
  );
}

export default async function FleetWorkshopReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("workorder.view");
  const today = businessDate(ctx.clock());
  const period = readReportPeriod(await searchParams, today);
  const { rows, totals, showCost } = await fleetWorkshopReport(ctx, period);
  const query = periodQuery(period);
  const anyWork = rows.some((row) => row.servicesDone + row.servicesMissed + row.repairs > 0);

  return (
    <>
      <PageHeader
        title="Workshop report"
        subtitle={`All tricycles · ${period.label}`}
        back={{ href: "/workshop", label: "Workshop" }}
      />
      <p className="mb-4 hidden text-sm text-muted print:block">Jayngol Transport · printed {formatDate(today)}</p>
      <PeriodPicker href="/workshop/report" period={period} />

      <div className="space-y-5">
        <section aria-label="Fleet totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4 print:grid-cols-4">
          {showCost ? (
            <div className="col-span-2 lg:col-span-1 print:col-span-1">
              <Figure
                label="Spent on the fleet"
                value={formatNaira(totals.totalKobo)}
                note={`${formatNaira(totals.partsKobo)} parts, ${formatNaira(totals.labourKobo)} labour`}
              />
            </div>
          ) : null}
          <Figure
            label="Services"
            value={`${totals.servicesDone} done`}
            note={totals.servicesMissed > 0 ? `${totals.servicesMissed} missed` : "None missed"}
          />
          <Figure label="Repairs" value={String(totals.repairs)} />
          <Figure label="Days off the road" value={String(totals.offRoadDays)} note={`Across ${plural(totals.tricycles, "tricycle")}`} />
        </section>

        {rows.length === 0 ? (
          <Empty>No tricycles yet.</Empty>
        ) : (
          <>
            {!anyWork ? <Empty>No services or repairs in this period.</Empty> : null}

            {/* Phones: one card per tricycle. */}
            <ul className="space-y-2 md:hidden print:hidden">
              {rows.map((row) => (
                <li key={row.tricycleId}>
                  <Link href={`/tricycles/${row.tricycleId}/workshop${query}`} className="block">
                    <Card className="hover:border-line-strong">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="font-bold text-ink">{row.code}</div>
                          <Flags row={row} />
                        </div>
                        {showCost ? (
                          <div className="shrink-0 text-right">
                            <div className="font-bold tabular-nums">{formatNaira(row.totalKobo)}</div>
                            <div className="text-xs text-muted tabular-nums">
                              {formatNaira(row.partsKobo)} parts · {formatNaira(row.labourKobo)} labour
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-2 text-sm text-muted">
                        {plural(row.servicesDone, "service")} · {plural(row.repairs, "repair")} ·{" "}
                        {plural(row.offRoadDays, "day")} off the road
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>

            {/* Wider screens and print: a table. */}
            <div className="hidden overflow-hidden rounded-2xl border border-line bg-card md:block print:block">
              <table className="w-full text-sm">
                <thead className="bg-card-subtle text-left text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Tricycle</th>
                    <th className="px-3 py-3 text-right font-medium">Services done</th>
                    <th className="px-3 py-3 text-right font-medium">Missed</th>
                    <th className="px-3 py-3 text-right font-medium">Repairs</th>
                    <th className="px-3 py-3 text-right font-medium">Days off road</th>
                    {showCost ? (
                      <>
                        <th className="px-3 py-3 text-right font-medium">Parts</th>
                        <th className="px-3 py-3 text-right font-medium">Labour</th>
                        <th className="px-4 py-3 text-right font-medium">Total</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line tabular-nums">
                  {rows.map((row) => (
                    <tr key={row.tricycleId} className="break-inside-avoid">
                      <td className="px-4 py-3">
                        <Link href={`/tricycles/${row.tricycleId}/workshop${query}`} className="font-semibold text-gold-deep underline">
                          {row.code}
                        </Link>
                        <div className="mt-1 print:hidden">
                          <Flags row={row} />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">{row.servicesDone}</td>
                      <td className={`px-3 py-3 text-right ${row.servicesMissed > 0 ? "font-semibold text-danger" : ""}`}>
                        {row.servicesMissed}
                      </td>
                      <td className={`px-3 py-3 text-right ${row.mostRepairs ? "font-semibold" : ""}`}>{row.repairs}</td>
                      <td className="px-3 py-3 text-right">{row.offRoadDays}</td>
                      {showCost ? (
                        <>
                          <td className="px-3 py-3 text-right">{formatNaira(row.partsKobo)}</td>
                          <td className="px-3 py-3 text-right">{formatNaira(row.labourKobo)}</td>
                          <td className="px-4 py-3 text-right font-semibold">{formatNaira(row.totalKobo)}</td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-line font-semibold tabular-nums">
                  <tr>
                    <td className="px-4 py-3">All tricycles</td>
                    <td className="px-3 py-3 text-right">{totals.servicesDone}</td>
                    <td className="px-3 py-3 text-right">{totals.servicesMissed}</td>
                    <td className="px-3 py-3 text-right">{totals.repairs}</td>
                    <td className="px-3 py-3 text-right">{totals.offRoadDays}</td>
                    {showCost ? (
                      <>
                        <td className="px-3 py-3 text-right">{formatNaira(totals.partsKobo)}</td>
                        <td className="px-3 py-3 text-right">{formatNaira(totals.labourKobo)}</td>
                        <td className="px-4 py-3 text-right">{formatNaira(totals.totalKobo)}</td>
                      </>
                    ) : null}
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
