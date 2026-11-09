import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Empty, LinkButton, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, formatDateTime, METHOD_LABELS, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listPayments } from "@/services/payments";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("finance.view");
  const requested = queryValue((await searchParams).date);
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : businessDate(ctx.clock());
  const rows = await listPayments(ctx, date);

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle={formatDate(date)}
        back={{ href: "/money", label: "Money" }}
        action={can(ctx.actor.role, "payment.record") ? <LinkButton href="/payments/new">Take payment</LinkButton> : undefined}
      />
      <form className="mb-4 flex gap-2">
        <input type="date" name="date" defaultValue={date} aria-label="Date" className="min-h-11 rounded-lg border border-line bg-card px-3" />
        <button className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">Show</button>
      </form>
      {rows.length === 0 ? (
        <Empty>No payments on this date.</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {rows.map((p) => (
            <li key={p.id}>
              <Link href={`/payments/${p.id}`} className="flex items-center justify-between gap-3 p-3 hover:bg-gold-wash">
                <div className="min-w-0">
                  <div className="truncate font-bold">{p.operatorName}</div>
                  <div className="text-sm text-muted">
                    {p.receiptNumber} · {METHOD_LABELS[p.method]} · {formatDateTime(p.receivedAt)}
                  </div>
                </div>
                {p.reversed ? <Badge tone="bad">Reversed</Badge> : <span className="font-bold tabular-nums">{formatNaira(p.amountKobo)}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
