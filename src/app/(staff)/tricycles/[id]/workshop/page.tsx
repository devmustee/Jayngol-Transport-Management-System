import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PeriodPicker } from "@/components/period-picker";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import { formatDate, formatDateTime, WORK_STATUS_LABELS, WORK_TYPE_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { formatStock } from "@/lib/quantity";
import { readReportPeriod } from "@/lib/report-period";
import { requirePage } from "@/lib/session";
import { tricycleWorkshopReport } from "@/services/workshop";

export const metadata: Metadata = { title: "Workshop report" };

const TONE = { checked_in: "gold", completed: "good", missed: "bad" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4 break-inside-avoid">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-ink">{value}</div>
      {note ? <div className="mt-0.5 text-xs text-muted">{note}</div> : null}
    </div>
  );
}

export default async function TricycleWorkshopReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("workorder.view");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const today = businessDate(ctx.clock());
  const period = readReportPeriod(await searchParams, today);
  const report = await tricycleWorkshopReport(ctx, id, period);
  if (!report) notFound();
  const { tricycle, summary, showCost, partsByItem, jobs } = report;
  const href = `/tricycles/${id}/workshop`;

  return (
    <>
      <PageHeader
        title={`${tricycle.code} workshop report`}
        subtitle={`${period.label}${tricycle.registration ? ` · ${tricycle.registration}` : ""}`}
        back={{ href: `/tricycles/${id}`, label: tricycle.code }}
      />
      <p className="mb-4 hidden text-sm text-muted print:block">
        Jayngol Transport · printed {formatDate(today)}
      </p>
      <PeriodPicker href={href} period={period} />

      <div className="space-y-5">
        <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-3 print:grid-cols-3">
          {showCost ? (
            <div className="col-span-2 lg:col-span-1 print:col-span-1">
              <Figure
                label="Spent on this tricycle"
                value={formatNaira(summary.totalKobo)}
                note={`${formatNaira(summary.partsKobo)} parts, ${formatNaira(summary.labourKobo)} labour`}
              />
            </div>
          ) : null}
          <Figure
            label="Services"
            value={`${summary.servicesDone} done`}
            note={summary.servicesMissed > 0 ? `${summary.servicesMissed} missed` : "None missed"}
          />
          <Figure label="Repairs" value={String(summary.repairs)} note={summary.inWorkshop ? "In the workshop now" : undefined} />
          <Figure label="Days off the road" value={String(summary.offRoadDays)} note="No balance charged on these days" />
          <Figure
            label="Last service"
            value={summary.lastService ? formatDate(summary.lastService) : "None yet"}
            note={summary.nextService ? `Next ${formatDate(summary.nextService)}` : undefined}
          />
        </section>

        <Card title="Parts used" subtitle="Taken from the store for this tricycle, less anything returned">
          {partsByItem.length === 0 ? (
            <Empty>No parts in this period.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {partsByItem.map((item) => (
                <li key={item.itemName} className="flex justify-between gap-3 py-2 text-sm">
                  <span>
                    <span className="font-semibold text-ink">{item.itemName}</span>{" "}
                    <span className="text-muted">{formatStock(item.quantityMilli, item.unit)}</span>
                  </span>
                  {showCost ? <span className="tabular-nums">{formatNaira(item.costKobo)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <section aria-label="Every job">
          <h2 className="mb-2 px-1 text-sm font-medium text-muted">Every service and repair ({jobs.length})</h2>
          {jobs.length === 0 ? (
            <Empty>No services or repairs in this period.</Empty>
          ) : (
            <ul className="space-y-3">
              {jobs.map((job) => (
                <li key={job.id} className="break-inside-avoid">
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={`/workshop/${job.id}`} className="font-semibold text-gold-deep underline">
                          {WORK_TYPE_LABELS[job.type]}, {formatDate(job.date)}
                        </Link>
                        {job.offRoadDays > 0 ? (
                          <div className="text-sm text-muted">{plural(job.offRoadDays, "day")} off the road</div>
                        ) : null}
                      </div>
                      <Badge tone={TONE[job.status]}>{WORK_STATUS_LABELS[job.status]}</Badge>
                    </div>
                    <dl className="mt-2 space-y-1 text-sm">
                      {job.fault ? (
                        <div>
                          <dt className="inline font-semibold">Fault: </dt>
                          <dd className="inline">{job.fault}</dd>
                        </div>
                      ) : null}
                      {job.holder ? (
                        <div>
                          <dt className="inline font-semibold">Held by: </dt>
                          <dd className="inline">
                            <Link href={`/operators/${job.holder.id}`} className="underline">
                              {job.holder.name}
                            </Link>{" "}
                            when the fault was reported
                          </dd>
                        </div>
                      ) : null}
                      {job.findings ? (
                        <div>
                          <dt className="inline font-semibold">Done: </dt>
                          <dd className="inline">{job.findings}</dd>
                        </div>
                      ) : null}
                      {job.parts.length > 0 ? (
                        <div>
                          <dt className="inline font-semibold">Used: </dt>
                          <dd className="inline">
                            {job.parts.map((part) => `${part.itemName} ${formatStock(part.quantityMilli, part.unit)}`).join(", ")}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                    {showCost && job.partsKobo + job.labourKobo > 0 ? (
                      <p className="mt-2 text-sm font-semibold">
                        {formatNaira(job.partsKobo + job.labourKobo)}
                        <span className="font-normal text-muted">
                          {" "}
                          ({formatNaira(job.partsKobo)} parts, {formatNaira(job.labourKobo)} labour)
                        </span>
                      </p>
                    ) : null}
                    {job.completedAt ? (
                      <p className="mt-1 text-xs text-muted">
                        Completed {formatDateTime(job.completedAt)}
                        {job.completedByName ? ` by ${job.completedByName}` : ""}
                      </p>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
