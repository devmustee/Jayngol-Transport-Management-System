import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { formatDate, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { repeatPaymentDays, unusedCredit, type ReviewPayment } from "@/services/payment-review";

export const metadata: Metadata = { title: "Payments to review" };

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" });

const PURPOSE_LABELS: Record<string, string> = {
  day_balance: "Day's balance",
  old_balance: "Older days",
  fine: "Fines",
  loan: "Loan",
  general: "Before the once-a-day rule",
};

function Receipt({ payment, extra }: { payment: ReviewPayment; extra?: string }) {
  return (
    <Link
      href={`/payments/${payment.id}`}
      className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm hover:text-gold-deep"
    >
      <span className="min-w-0">
        <span className="font-medium text-ink">{payment.receiptNumber}</span>
        <span className="text-muted">
          {" · "}
          {timeFormat.format(payment.receivedAt)} by {payment.receivedBy} · {METHOD_LABELS[payment.method] ?? payment.method}
          {" · "}
          {PURPOSE_LABELS[payment.purpose] ?? payment.purpose}
        </span>
      </span>
      <span className="shrink-0 text-right tabular-nums">
        {formatNaira(payment.amountKobo)}
        {extra ? <span className="block text-xs text-muted">{extra}</span> : null}
      </span>
    </Link>
  );
}

export default async function PaymentReviewPage() {
  const ctx = await requirePage("payment.reverse");
  const [repeats, credit] = await Promise.all([repeatPaymentDays(ctx), unusedCredit(ctx)]);
  const likely = repeats.filter((day) => day.sameAmount).length;
  const creditTotal = credit.reduce((sum, c) => sum + c.unusedKobo, 0);

  return (
    <>
      <PageHeader
        title="Payments to review"
        subtitle="Payments that may have been taken twice"
        back={{ href: "/money", label: "Money" }}
      />
      <p className="mb-6 text-sm text-muted">
        This page changes nothing. Open a receipt and use Reverse payment for any that were a mistake. Real advances and
        payments for older days can be left as they are.
      </p>

      <div className="space-y-6">
        <section aria-label="More than one payment on a day">
          <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
            <h2 className="text-sm font-medium text-muted">More than one payment on a day ({repeats.length})</h2>
            {likely > 0 ? (
              <span className="text-sm text-muted">
                {likely} with the same amount twice
              </span>
            ) : null}
          </div>
          {repeats.length === 0 ? (
            <Empty>No operator paid towards balances more than once on the same day.</Empty>
          ) : (
            <div className="space-y-3">
              {repeats.map((day) => (
                <Card key={`${day.operatorId}:${day.date}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/operators/${day.operatorId}/statement`} className="font-semibold text-ink hover:underline">
                        {day.operatorName}
                      </Link>
                      <div className="text-sm text-muted">
                        {formatDate(day.date)}
                        {day.tricycleCode ? ` · ${day.tricycleCode}` : ""}
                        {" · "}
                        {day.dueKobo !== null ? `balance ${formatNaira(day.dueKobo)}` : "no balance that day"}
                        {" · "}
                        taken {formatNaira(day.totalKobo)}
                      </div>
                    </div>
                    {day.sameAmount ? <Badge tone="bad">Same amount twice</Badge> : <Badge tone="plain">Check</Badge>}
                  </div>
                  <div className="mt-2 divide-y divide-line border-t border-line">
                    {day.payments.map((p) => (
                      <Receipt key={p.id} payment={p} />
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section aria-label="Money not used yet">
          <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
            <h2 className="text-sm font-medium text-muted">Money not used yet ({credit.length})</h2>
            {creditTotal > 0 ? (
              <span className="text-sm font-semibold tabular-nums text-ink">{formatNaira(creditTotal)}</span>
            ) : null}
          </div>
          {credit.length === 0 ? (
            <Empty>Every payment has been used on a balance, fine or loan.</Empty>
          ) : (
            <Card subtitle="Kept as credit. The nightly job uses it on the next balances, so a repeat here pays days ahead.">
              <div className="divide-y divide-line">
                {credit.map((c) => (
                  <div key={c.id}>
                    <Link
                      href={`/operators/${c.operatorId}/statement`}
                      className="block pt-2 text-sm font-semibold text-ink hover:underline"
                    >
                      {c.operatorName} · {formatDate(c.businessDate)}
                    </Link>
                    <Receipt payment={c} extra={`${formatNaira(c.unusedKobo)} not used`} />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </section>
      </div>
    </>
  );
}
