import type { ReactNode } from "react";
import { Badge, Card, Details, Empty } from "@/components/ui";
import { AWARD_LABELS, CHARGE_LABELS, formatDate, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { getStatement } from "@/services/finance";

type Statement = Awaited<ReturnType<typeof getStatement>>;

export function StatementView({ data, afterOwed }: { data: Statement; afterOwed?: ReactNode }) {
  return (
    <div className="space-y-4">
      <Card title="Owed now">
        <Details
          rows={[
            ["Unpaid balance", formatNaira(data.balanceOwedKobo)],
            ["Unpaid days", String(data.unpaidDays)],
            ["Penalties", formatNaira(data.penaltiesOwedKobo)],
            ...(data.loanOwedKobo > 0 ? ([["Loan", formatNaira(data.loanOwedKobo)]] as [string, string][]) : []),
            ...(data.creditKobo > 0 ? ([["Paid in advance", formatNaira(data.creditKobo)]] as [string, string][]) : []),
          ]}
        />
      </Card>
      {afterOwed}
      {data.awards.length > 0 ? (
        <Card title="Awards">
          <ul className="divide-y divide-line">
            {data.awards.map((award) => (
              <li key={award.id} className="py-2">
                <div className="font-medium">{AWARD_LABELS[award.type]}: {award.given}</div>
                <div className="text-sm text-muted">{formatDate(award.given_on)}</div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card title="Charges">
        {data.charges.length === 0 ? (
          <Empty>No charges yet.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {data.charges.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <div className="font-medium">{CHARGE_LABELS[c.type]}</div>
                  <div className="text-sm text-muted">{formatDate(c.business_date)}</div>
                </div>
                <div className="text-right">
                  <div className={`font-medium tabular-nums ${c.voided ? "line-through" : ""}`}>{formatNaira(c.amount)}</div>
                  {c.voided ? (
                    <Badge tone="plain">Cancelled</Badge>
                  ) : c.paid >= c.amount ? (
                    <Badge tone="good">Paid</Badge>
                  ) : c.paid > 0 ? (
                    <Badge tone="gold">{formatNaira(c.amount - c.paid)} left</Badge>
                  ) : (
                    <Badge tone="bad">Unpaid</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Payments">
        {data.payments.length === 0 ? (
          <Empty>No payments yet.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {data.payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <div className="font-medium">{p.receipt_number}</div>
                  <div className="text-sm text-muted">
                    {formatDate(p.business_date)} · {METHOD_LABELS[p.method]}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-medium tabular-nums ${p.reversed ? "line-through" : ""}`}>{formatNaira(p.amount)}</div>
                  {p.reversed ? <Badge tone="bad">Reversed</Badge> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
