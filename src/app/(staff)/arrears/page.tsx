import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Wallet } from "lucide-react";
import { Badge, Empty, PageHeader } from "@/components/ui";
import { formatDate, OPERATOR_STATUS_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { parseRange } from "@/lib/periods";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listArrears } from "@/services/finance";

export const metadata: Metadata = { title: "Unpaid balances" };

type Row = Awaited<ReturnType<typeof listArrears>>[number];

const sumOwed = (rows: Row[]) => rows.reduce((sum, r) => sum + r.owed, 0);

function Group({ title, rows, canCollect }: { title: string; rows: Row[]; canCollect: boolean }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted">
          {title} ({rows.length})
        </h2>
        <span className="text-sm font-bold tabular-nums text-ink">{formatNaira(sumOwed(rows))}</span>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card shadow-premium">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
            <Link
              href={`/operators/${r.id}/statement`}
              className="group flex min-h-12 min-w-0 flex-1 items-center justify-between gap-3 rounded-lg hover:text-gold-deep"
            >
              <div className="min-w-0">
                <div className="font-bold leading-snug [overflow-wrap:anywhere]">{r.name}</div>
                <div className="text-sm text-muted">
                  {formatPhone(r.phone)} · since {formatDate(r.oldest)}
                </div>
                {r.status !== "active" ? (
                  <div className="mt-1">
                    <Badge tone="bad">{OPERATOR_STATUS_LABELS[r.status]}</Badge>
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="text-right">
                  <div className="font-bold tabular-nums text-ink">{formatNaira(r.owed)}</div>
                  <Badge tone={r.days >= 3 ? "bad" : "gold"}>
                    {r.days} day{r.days === 1 ? "" : "s"}
                  </Badge>
                </div>
                <ChevronRight size={18} aria-hidden className="text-muted/60 group-hover:text-gold-deep" />
              </div>
            </Link>
            {canCollect ? (
              <Link
                href={`/payments/new?operator=${r.id}&for=balance`}
                aria-label={`Take payment from ${r.name}`}
                className="inline-flex min-h-11 items-center justify-center gap-2 self-end rounded-xl bg-gradient-to-r from-gold to-gold-light px-4 text-sm font-bold text-ink shadow-gold-sm transition-all hover:brightness-105 active:scale-[0.98] sm:self-center"
              >
                <Wallet size={16} aria-hidden />
                Take payment
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function ArrearsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requirePage("finance.view");
  const range = parseRange(await searchParams);
  const rows = await listArrears(ctx, range ?? undefined);
  const canCollect = can(ctx.actor.role, "payment.record");
  const working = rows.filter((r) => r.status === "active");
  const gone = rows.filter((r) => r.status !== "active");
  const total = formatNaira(sumOwed(rows));
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
          <Link href="/arrears" className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline underline-offset-2">
            Show every unpaid balance
          </Link>
        </p>
      ) : null}
      {rows.length === 0 ? (
        <Empty>{range ? "Every balance for these days is paid." : "Every balance is paid."}</Empty>
      ) : (
        <div className="space-y-6">
          {canCollect ? (
            <p className="text-sm text-muted">
              Take payment fills in everything the operator owes. A payment always clears the oldest days first.
            </p>
          ) : null}
          <Group title="Working operators" rows={working} canCollect={canCollect} />
          <Group title="No longer working" rows={gone} canCollect={canCollect} />
        </div>
      )}
    </>
  );
}
