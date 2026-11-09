import type { Metadata } from "next";
import { z } from "zod";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, queryValue } from "@/lib/format";
import { requirePage } from "@/lib/session";
import { inspectionCoverage } from "@/services/inspections";

export const metadata: Metadata = { title: "Inspection report" };

export default async function InspectionReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("inspection.report");
  const asked = queryValue((await searchParams).date);
  const date = z.iso.date().safeParse(asked).success ? asked! : businessDate(ctx.clock());
  const report = await inspectionCoverage(ctx, { date });
  const percent = report.expected ? Math.round((report.inspected / report.expected) * 100) : 0;

  return (
    <>
      <PageHeader title="Inspection report" subtitle={formatDate(date)} />
      <form className="mb-4 flex items-end gap-2">
        <label className="flex-1 font-medium">
          Date
          <input type="date" name="date" defaultValue={date} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-card px-3 text-base" />
        </label>
        <button className="min-h-11 rounded-lg bg-ink px-4 font-semibold text-gold-light">Show</button>
      </form>
      <div className="space-y-4">
        <Card title="Coverage">
          <div className="text-3xl font-bold">{percent}%</div>
          <p className="text-muted">
            {report.inspected} of {report.expected} tricycles inspected. The target is 90%.
          </p>
        </Card>
        <Card title="By supervisor">
          {report.bySupervisor.length === 0 ? (
            <p className="text-muted">No inspections on this date.</p>
          ) : (
            <ul className="divide-y divide-line">
              {report.bySupervisor.map((row) => (
                <li key={row.name} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-semibold">{row.name}</span>
                  <span className="text-sm text-muted">
                    {row.total} inspected, {row.problems} with problems
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Not inspected">
          {report.missed.length === 0 ? (
            <Empty>None missed.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {report.missed.map((row) => (
                <li key={row.tricycleId} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-semibold">{row.code}</span>
                  <Badge tone="plain">{row.operatorName}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
