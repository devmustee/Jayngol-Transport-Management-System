import type { Metadata } from "next";
import Link from "next/link";
import { HistoryFilters } from "@/components/history-filters";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { formatDate, formatDateTime, WORK_STATUS_LABELS, WORK_TYPE_LABELS } from "@/lib/format";
import { readHistoryFilter } from "@/lib/history-filter";
import { formatNaira } from "@/lib/money";
import { formatStock } from "@/lib/quantity";
import { requirePage } from "@/lib/session";
import { tricycleChoices } from "@/services/tricycles";
import { listWorkHistory } from "@/services/workshop";

export const metadata: Metadata = { title: "Service and repair history" };

const TONE = { scheduled: "gold", checked_in: "gold", completed: "good", missed: "bad", cancelled: "plain" } as const;

export default async function WorkHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("workorder.view");
  const filter = readHistoryFilter(await searchParams);
  const [history, tricycles] = await Promise.all([listWorkHistory(ctx, filter), tricycleChoices(ctx)]);
  const total = history.rows.reduce((sum, row) => sum + row.partsKobo + row.labourKobo, 0);

  return (
    <>
      <PageHeader title="Service and repair history" subtitle="All tricycles" back={{ href: "/workshop", label: "Workshop" }} />
      <HistoryFilters clearHref="/workshop/history" tricycles={tricycles} showType filter={filter} />
      <div className="space-y-4">
        {history.showCost && !history.truncated && history.rows.length > 0 ? (
          <p className="font-semibold">Total parts and labour: {formatNaira(total)}</p>
        ) : null}
        {history.truncated ? <p className="text-sm text-muted">Showing the latest {history.rows.length}. Narrow the dates to see older entries.</p> : null}
        {history.rows.length === 0 ? (
          <Empty>No services or repairs for these filters.</Empty>
        ) : (
          <ul className="space-y-3">
            {history.rows.map((row) => (
              <li key={row.id}>
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/workshop/${row.id}`} className="font-bold text-gold-deep underline">
                        {row.code} {WORK_TYPE_LABELS[row.type].toLowerCase()}
                      </Link>
                      <div className="text-sm text-muted">{formatDate(row.date)}</div>
                    </div>
                    <Badge tone={TONE[row.status]}>{WORK_STATUS_LABELS[row.status]}</Badge>
                  </div>
                  {row.fault ? <p className="mt-2 text-sm"><strong>Fault:</strong> {row.fault}</p> : null}
                  {row.findings ? <p className="mt-1 text-sm"><strong>Done:</strong> {row.findings}</p> : null}
                  {row.parts.length > 0 ? (
                    <p className="mt-1 text-sm">
                      <strong>Used:</strong> {row.parts.map((part) => `${part.itemName} ${formatStock(part.quantityMilli, part.unit)}`).join(", ")}
                    </p>
                  ) : null}
                  {row.completedAt ? (
                    <p className="mt-1 text-sm text-muted">
                      Completed {formatDateTime(row.completedAt)}{row.completedByName ? ` by ${row.completedByName}` : ""}
                    </p>
                  ) : null}
                  {history.showCost && row.partsKobo + row.labourKobo > 0 ? (
                    <p className="mt-1 text-sm font-semibold">
                      {formatNaira(row.partsKobo + row.labourKobo)}
                      <span className="font-normal text-muted"> ({formatNaira(row.partsKobo)} parts, {formatNaira(row.labourKobo)} labour)</span>
                    </p>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
