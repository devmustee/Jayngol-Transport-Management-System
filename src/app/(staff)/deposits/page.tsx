import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { formatDate, formatDateTime, METHOD_LABELS, OPERATOR_STATUS_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listDeposits } from "@/services/deposits";
import { depositsToSettle, listSettlements } from "@/services/deposit-settlements";

export const metadata: Metadata = { title: "Operator deposits" };

export default async function DepositsPage() {
  const ctx = await requirePage("finance.view");
  const [{ items, truncated, heldKobo }, toSettle, settled] = await Promise.all([
    listDeposits(ctx),
    depositsToSettle(),
    listSettlements(ctx),
  ]);

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
          <p className="mt-1 text-sm text-muted">Deposits not yet reversed or settled.</p>
        </Card>
        {toSettle.length > 0 ? (
          <Card title="To settle" subtitle="Operators who stopped working with a deposit still held, oldest first.">
            <ul className="divide-y divide-line">
              {toSettle.map((row) => (
                <li key={row.operator_id}>
                  <Link
                    href={`/operators/${row.operator_id}#deposit`}
                    className="flex min-h-12 items-center justify-between gap-3 py-2 hover:text-gold-deep"
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold [overflow-wrap:anywhere]">{row.name}</span>
                      <span className="text-sm text-muted">
                        {OPERATOR_STATUS_LABELS[row.status as keyof typeof OPERATOR_STATUS_LABELS] ?? row.status} · held since{" "}
                        {formatDate(row.since)}
                      </span>
                    </span>
                    <span className="shrink-0 font-bold tabular-nums">{formatNaira(row.held)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {settled.length > 0 ? (
          <Card title="Settled">
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
                        {s.keptKobo > 0 ? ` · kept ${formatNaira(s.keptKobo)}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-bold tabular-nums">{formatNaira(s.heldKobo)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {truncated ? <p className="text-sm text-muted">Showing the latest 200 deposits. The total covers everything.</p> : null}
        {items.length === 0 ? (
          <Empty>No deposits recorded yet.</Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {items.map((deposit) => (
              <li key={deposit.id}>
                <Link href={`/deposits/${deposit.id}`} className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-gold-wash">
                  <div className="min-w-0">
                    <div className="font-bold leading-snug [overflow-wrap:anywhere]">{deposit.operatorName}</div>
                    <div className="text-sm text-muted">
                      {deposit.receiptNumber} · {METHOD_LABELS[deposit.method]} · {formatDateTime(deposit.receivedAt)}
                    </div>
                  </div>
                  {deposit.reversedAt ? (
                    <Badge tone="bad">Reversed</Badge>
                  ) : (
                    <span className="flex shrink-0 items-center gap-2">
                      {deposit.settlementId ? <Badge tone="plain">Settled</Badge> : null}
                      <span className="font-bold tabular-nums">{formatNaira(deposit.amountKobo)}</span>
                    </span>
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
