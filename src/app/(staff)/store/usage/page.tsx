import type { Metadata } from "next";
import Link from "next/link";
import { HistoryFilters } from "@/components/history-filters";
import { Card, Empty, PageHeader } from "@/components/ui";
import { formatDateTime, WORK_TYPE_LABELS } from "@/lib/format";
import { readHistoryFilter } from "@/lib/history-filter";
import { formatNaira } from "@/lib/money";
import { formatStock } from "@/lib/quantity";
import { requirePage } from "@/lib/session";
import { HISTORY_LIMIT, listStockUsage, stockItemChoices } from "@/services/store";
import { tricycleChoices } from "@/services/tricycles";

export const metadata: Metadata = { title: "Store usage" };

export default async function StoreUsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("stock.view");
  const filter = readHistoryFilter(await searchParams);
  const [usage, tricycles, items] = await Promise.all([
    listStockUsage(ctx, filter),
    tricycleChoices(ctx),
    stockItemChoices(ctx),
  ]);

  return (
    <>
      <PageHeader title="Store usage" subtitle="What was used, on which tricycle, and when" back={{ href: "/store", label: "Store" }} />
      <HistoryFilters clearHref="/store/usage" tricycles={tricycles} items={items} filter={filter} />
      <div className="space-y-4">
        {usage.totals.length > 0 ? (
          <Card title={`Total used: ${formatNaira(usage.totalCostKobo)}`}>
            <ul className="divide-y divide-line">
              {usage.totals.map((row) => (
                <li key={row.itemName} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-semibold">{row.itemName}</span>
                  <span className="text-right text-sm text-muted">
                    {formatStock(row.quantityMilli, row.unit)} · {formatNaira(row.costKobo)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {usage.truncated ? <p className="text-sm text-muted">Showing the latest {HISTORY_LIMIT}. The totals cover everything. Narrow the dates to see older entries.</p> : null}
        {usage.rows.length === 0 ? (
          <Empty>Nothing was used for these filters.</Empty>
        ) : (
          <ul className="space-y-3">
            {usage.rows.map((row) => (
              <li key={row.id}>
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold">{row.itemName}, {formatStock(-row.quantityMilli, row.unit)}</div>
                      <div>
                        <Link href={`/tricycles/${row.tricycleId}`} className="font-semibold text-gold-deep underline">{row.tricycleCode}</Link>
                        {" · "}
                        <Link href={`/workshop/${row.workOrderId}`} className="text-gold-deep underline">{WORK_TYPE_LABELS[row.workType]}</Link>
                      </div>
                      <div className="text-sm text-muted">{formatDateTime(row.usedAt)} · Issued by {row.issuedBy}</div>
                    </div>
                    <span className="shrink-0 font-semibold">{formatNaira(-row.costKobo)}</span>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
