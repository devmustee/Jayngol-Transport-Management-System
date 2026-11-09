import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { formatDateTime, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listDeposits } from "@/services/deposits";

export const metadata: Metadata = { title: "Operator deposits" };

export default async function DepositsPage() {
  const ctx = await requirePage("finance.view");
  const { items, truncated, heldKobo } = await listDeposits(ctx);

  return (
    <>
      <PageHeader
        title="Operator deposits"
        subtitle="Money held for operators. It is not income."
        back={{ href: "/money", label: "Money" }}
        action={can(ctx.actor.role, "payment.record") ? <LinkButton href="/deposits/new">Record deposit</LinkButton> : undefined}
      />
      <div className="space-y-4">
        <Card>
          <p className="text-sm font-semibold text-muted">Total held</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{formatNaira(heldKobo)}</p>
        </Card>
        {truncated ? <p className="text-sm text-muted">Showing the latest 200 deposits. The total covers everything.</p> : null}
        {items.length === 0 ? (
          <Empty>No deposits recorded yet.</Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {items.map((deposit) => (
              <li key={deposit.id}>
                <Link href={`/deposits/${deposit.id}`} className="flex items-center justify-between gap-3 p-3 hover:bg-gold-wash">
                  <div className="min-w-0">
                    <div className="truncate font-bold">{deposit.operatorName}</div>
                    <div className="text-sm text-muted">
                      {deposit.receiptNumber} · {METHOD_LABELS[deposit.method]} · {formatDateTime(deposit.receivedAt)}
                    </div>
                  </div>
                  {deposit.reversedAt ? (
                    <Badge tone="bad">Reversed</Badge>
                  ) : (
                    <span className="shrink-0 font-bold tabular-nums">{formatNaira(deposit.amountKobo)}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
