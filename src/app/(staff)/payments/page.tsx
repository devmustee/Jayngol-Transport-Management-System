import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, formatDateTime, METHOD_LABELS, PAYMENT_PURPOSE_LABELS, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listPayments } from "@/services/payments";

export const metadata: Metadata = { title: "Payments" };

type Row = Awaited<ReturnType<typeof listPayments>>["forDay"][number];

const METHOD_ORDER = ["cash", "pos", "transfer", "deposit"];

function PaymentRow({ p, note }: { p: Row; note?: string }) {
  return (
    <li>
      <Link href={`/payments/${p.id}`} className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-gold-wash">
        <div className="min-w-0">
          <div className="font-bold leading-snug [overflow-wrap:anywhere]">{p.operatorName}</div>
          <div className="text-sm text-muted">
            {p.receiptNumber} · {METHOD_LABELS[p.method]} · {PAYMENT_PURPOSE_LABELS[p.purpose] ?? p.purpose} ·{" "}
            {formatDateTime(p.receivedAt)}
          </div>
          {note ? <div className="text-xs font-semibold text-gold-deep">{note}</div> : null}
        </div>
        <div className="shrink-0 text-right">
          <div className={`font-bold tabular-nums ${p.reversed ? "text-muted line-through" : ""}`}>{formatNaira(p.amountKobo)}</div>
          {p.reversed ? <Badge tone="bad">Reversed</Badge> : null}
        </div>
      </Link>
    </li>
  );
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("finance.view");
  const today = businessDate(ctx.clock());
  const requested = queryValue((await searchParams).date);
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : today;
  const day = await listPayments(ctx, date);
  const dayLabel = date === today ? "today" : formatDate(date);

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle={formatDate(date)}
        back={{ href: "/money", label: "Money" }}
        action={can(ctx.actor.role, "payment.record") ? <LinkButton href="/payments/new">Take payment</LinkButton> : undefined}
      />
      <form className="mb-4 flex gap-2">
        <input type="date" name="date" max={today} defaultValue={date} aria-label="Date" className="min-h-11 rounded-lg border border-line bg-card px-3" />
        <button className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">Show</button>
      </form>
      <div className="space-y-4">
        <Card title={`Taken ${dayLabel}`} subtitle="Payments entered on this day, as they reach the cash and the bank. Reversed payments are left out.">
          <dl className="divide-y divide-line">
            {METHOD_ORDER.filter((method) => (day.byMethod[method] ?? 0) > 0 || method !== "deposit").map((method) => (
              <div key={method} className="flex justify-between gap-3 py-2 text-sm">
                <dt>{METHOD_LABELS[method]}</dt>
                <dd className="tabular-nums">{formatNaira(day.byMethod[method] ?? 0)}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 py-2 font-bold">
              <dt>
                Total · {day.takenCount} payment{day.takenCount === 1 ? "" : "s"}
              </dt>
              <dd className="tabular-nums">{formatNaira(day.takenKobo)}</dd>
            </div>
            {day.reversedCount > 0 ? (
              <div className="flex justify-between gap-3 py-2 text-sm text-danger">
                <dt>
                  Reversed · {day.reversedCount} payment{day.reversedCount === 1 ? "" : "s"}
                </dt>
                <dd className="tabular-nums">{formatNaira(day.reversedKobo)}</dd>
              </div>
            ) : null}
          </dl>
        </Card>

        <section aria-label={`Paid for ${dayLabel}`} className="space-y-2">
          <h2 className="text-sm font-semibold text-muted">Paid for {dayLabel}</h2>
          {day.forDay.length === 0 ? (
            <Empty>No payments for this day.</Empty>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
              {day.forDay.map((p) => (
                <PaymentRow key={p.id} p={p} note={p.enteredOn !== date ? `Entered late, on ${formatDate(p.enteredOn)}` : undefined} />
              ))}
            </ul>
          )}
        </section>

        {day.lateEntries.length > 0 ? (
          <section aria-label="Entered for earlier days" className="space-y-2">
            <h2 className="text-sm font-semibold text-muted">Entered {dayLabel} for earlier days</h2>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
              {day.lateEntries.map((p) => (
                <PaymentRow key={p.id} p={p} note={`For ${formatDate(p.businessDate)}`} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
