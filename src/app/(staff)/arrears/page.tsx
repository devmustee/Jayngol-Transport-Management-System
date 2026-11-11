import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Empty, PageHeader } from "@/components/ui";
import { formatDate, OPERATOR_STATUS_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { parseRange } from "@/lib/periods";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listArrears } from "@/services/finance";

export const metadata: Metadata = { title: "Unpaid balances" };

export default async function ArrearsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requirePage("finance.view");
  const range = parseRange(await searchParams);
  const rows = await listArrears(ctx, range ?? undefined);
  const total = formatNaira(rows.reduce((sum, r) => sum + r.owed, 0));
  return (
    <>
      <PageHeader
        title="Unpaid balances"
        subtitle={range ? `${total} for ${formatDate(range.from)} to ${formatDate(range.to)}` : `Total ${total}`}
        back={{ href: "/money", label: "Money" }}
      />
      {range ? (
        <p className="mb-3 text-sm text-muted">
          Only balances for these days.{" "}
          <Link href="/arrears" className="font-semibold text-gold-deep underline underline-offset-2">
            Show every unpaid balance
          </Link>
        </p>
      ) : null}
      {rows.length === 0 ? (
        <Empty>{range ? "Every balance for these days is paid." : "Every balance is paid."}</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/operators/${r.id}/statement`} className="flex items-center justify-between gap-3 p-3 hover:bg-gold-wash">
                <div className="min-w-0">
                  <div className="truncate font-bold">{r.name}</div>
                  <div className="text-sm text-muted">
                    {formatPhone(r.phone)} · since {formatDate(r.oldest)}
                  </div>
                  {r.status !== "active" ? <Badge tone="bad">{OPERATOR_STATUS_LABELS[r.status]}</Badge> : null}
                </div>
                <div className="text-right">
                  <div className="font-bold tabular-nums">{formatNaira(r.owed)}</div>
                  <Badge tone={r.days >= 3 ? "bad" : "gold"}>
                    {r.days} day{r.days === 1 ? "" : "s"}
                  </Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
