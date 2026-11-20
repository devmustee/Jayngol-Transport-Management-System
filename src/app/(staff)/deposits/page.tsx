import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { formatDate, formatDateTime, METHOD_LABELS, OPERATOR_STATUS_LABELS, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listDeposits } from "@/services/deposits";
import { depositsToSettle, listSettlements, monthEnd, notSavingThisMonth } from "@/services/deposit-settlements";
import { moneySources } from "@/services/cash-book";
import { RefundAllForm } from "@/components/forms/refund-all-form";
import { businessDate } from "@/lib/clock";

export const metadata: Metadata = { title: "Operator savings" };

const METHOD_ORDER = ["cash", "pos", "transfer"];

export default async function DepositsPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const ctx = await requirePage("finance.view");
  const today = businessDate(ctx.clock());
  const requested = queryValue((await searchParams).date);
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : today;
  const dayLabel = date === today ? "today" : formatDate(date);
  const canSettle = can(ctx.actor.role, "deposit.settle");
  const [day, toSettle, settled, notSaving, sources] = await Promise.all([
    listDeposits(ctx, date),
    depositsToSettle(undefined, today),
    listSettlements(ctx),
    notSavingThisMonth(undefined, today),
    canSettle ? moneySources(ctx) : [],
  ]);
  const refundDay = monthEnd(today) === today;
  const month = new Date(`${today}T00:00:00Z`).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });

  return (
    <>
      <PageHeader
        title="Operator savings"
        subtitle="Saved by operators through the month and given back at the month end. It is not income."
        back={{ href: "/money", label: "Money" }}
        action={can(ctx.actor.role, "payment.record") ? <LinkButton href="/deposits/new">Record saving</LinkButton> : undefined}
      />
      <div className="space-y-4">
        <Card>
          <p className="text-sm font-semibold text-muted">Total held</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{formatNaira(day.heldKobo)}</p>
          <p className="mt-1 text-sm text-muted">Savings not yet given back.</p>
        </Card>
        {toSettle.length > 0 ? (
          <Card
            title={refundDay ? `To give back for ${month}` : "To give back"}
            subtitle={
              canSettle
                ? "Every debt is cleared from each person's savings and the rest given back. Untick anyone with damage and give back on their own page."
                : "The Manager gives savings back at the month end."
            }
          >
            {canSettle ? (
              <RefundAllForm
                label={refundDay ? `Give back all for ${month}` : "Give back all ticked"}
                sources={sources}
                rows={toSettle.map((row) => ({
                  operatorId: row.operator_id,
                  name: row.name,
                  heldKobo: row.held,
                  owedKobo: row.owed,
                  workshop: row.workshop_this_month,
                  blocked:
                    row.status !== "active" && row.has_tricycle
                      ? `${OPERATOR_STATUS_LABELS[row.status as keyof typeof OPERATOR_STATUS_LABELS] ?? row.status}: tricycle not returned yet`
                      : null,
                }))}
              />
            ) : (
              <ul className="divide-y divide-line">
                {toSettle.map((row) => (
                  <li key={row.operator_id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                    <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{row.name}</span>
                    <span className="shrink-0 font-bold tabular-nums">{formatNaira(row.held)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : (
          <p className="text-sm text-muted">Savings are given back on {formatDate(monthEnd(today))}.</p>
        )}
        {notSaving.length > 0 ? (
          <Card title={`Not saving this month (${notSaving.length})`} subtitle={`Working operators with nothing saved since the 1st. A reminder ${Number(today.slice(8)) >= 5 ? "went out" : "goes out"} on the 5th.`}>
            <p className="text-sm [overflow-wrap:anywhere]">
              {notSaving.map((row, i) => (
                <span key={row.operator_id}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/operators/${row.operator_id}`} className="hover:text-gold-deep">
                    {row.name}
                  </Link>
                </span>
              ))}
            </p>
          </Card>
        ) : null}
        {settled.length > 0 ? (
          <Card title="Given back">
            <ul className="divide-y divide-line">
              {settled.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/operators/${s.operatorId}#deposit`}
                    className="flex min-h-12 items-center justify-between gap-3 py-2 hover:text-gold-deep"
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold [overflow-wrap:anywhere]">{s.operatorName}</span>
                      <span className="text-sm text-muted">
                        {formatDate(s.businessDate)} · cleared {formatNaira(s.clearedKobo)} · given back {formatNaira(s.givenBackKobo)}
                        {s.keptKobo > 0 ? ` · damage ${formatNaira(s.keptKobo)}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-bold tabular-nums">{formatNaira(s.heldKobo)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <section aria-labelledby="saved-day" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id="saved-day" className="text-lg font-bold">
              Saved {dayLabel}
            </h2>
            <form className="flex gap-2">
              <input
                type="date"
                name="date"
                max={today}
                defaultValue={date}
                aria-label="Date"
                className="min-h-11 rounded-lg border border-line bg-card px-3"
              />
              <button className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">Show</button>
            </form>
          </div>
          <Card subtitle="Savings taken on this day, as they reach the cash and the bank. Reversed savings are left out.">
            <dl className="divide-y divide-line">
              {METHOD_ORDER.map((method) => (
                <div key={method} className="flex justify-between gap-3 py-2 text-sm">
                  <dt>{METHOD_LABELS[method]}</dt>
                  <dd className="tabular-nums">{formatNaira(day.byMethod[method] ?? 0)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 py-2 font-bold">
                <dt>
                  Total · {day.takenCount} saving{day.takenCount === 1 ? "" : "s"}
                </dt>
                <dd className="tabular-nums">{formatNaira(day.takenKobo)}</dd>
              </div>
              {day.reversedCount > 0 ? (
                <div className="flex justify-between gap-3 py-2 text-sm text-danger">
                  <dt>
                    Reversed · {day.reversedCount} saving{day.reversedCount === 1 ? "" : "s"}
                  </dt>
                  <dd className="tabular-nums">{formatNaira(day.reversedKobo)}</dd>
                </div>
              ) : null}
            </dl>
          </Card>
          {day.truncated ? <p className="text-sm text-muted">Showing the latest 200 savings of this day. The totals cover those shown.</p> : null}
          {day.items.length === 0 ? (
            <Empty>No savings recorded {dayLabel}.</Empty>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
              {day.items.map((deposit) => (
                <li key={deposit.id}>
                  <Link href={`/deposits/${deposit.id}`} className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-gold-wash">
                    <div className="min-w-0">
                      <div className="font-bold leading-snug [overflow-wrap:anywhere]">{deposit.operatorName}</div>
                      <div className="text-sm text-muted">
                        {deposit.receiptNumber} · {METHOD_LABELS[deposit.method]} · {formatDateTime(deposit.receivedAt)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`font-bold tabular-nums ${deposit.reversedAt ? "text-muted line-through" : ""}`}>
                        {formatNaira(deposit.amountKobo)}
                      </div>
                      {deposit.reversedAt ? (
                        <Badge tone="bad">Reversed</Badge>
                      ) : deposit.settlementId ? (
                        <Badge tone="plain">Given back</Badge>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
