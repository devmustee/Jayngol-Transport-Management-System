import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PaymentForm } from "@/components/forms/payment-form";
import { Badge, Card, Details, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import { formatDate, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listOperators } from "@/services/operators";
import { paymentContext } from "@/services/payments";

export const metadata: Metadata = { title: "Take payment" };

export default async function TakePaymentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("payment.record");
  const params = await searchParams;
  const q = queryValue(params.q);
  const operatorId = queryValue(params.operator);

  if (operatorId) {
    const data = isUuid(operatorId) ? await paymentContext(ctx, operatorId) : null;
    if (!data) notFound();
    const { operator, current, balances } = data;
    return (
      <>
        <PageHeader
          title={operator.name}
          subtitle={current ? `Tricycle ${current.codeNumber}` : "No tricycle"}
          back={{ href: "/payments/new", label: "Choose another operator" }}
          action={operator.status !== "active" ? <Badge tone="bad">{operator.status}</Badge> : undefined}
        />
        <div className="space-y-4">
          <Card title="Owed now">
            <Details
              rows={[
                ["Unpaid balance", formatNaira(data.balanceOwedKobo)],
                ["Unpaid days", String(balances.length)],
                ["Oldest unpaid", balances[0] ? formatDate(balances[0].businessDate) : null],
                ["Penalties", formatNaira(data.penaltiesOwedKobo)],
                ...(data.loanOwedKobo > 0 ? ([["Loan", formatNaira(data.loanOwedKobo)]] as [string, string][]) : []),
              ]}
            />
          </Card>
          <Card title="Record payment">
            <PaymentForm
              operatorId={operator.id}
              clientId={randomUUID()}
              today={businessDate(ctx.clock())}
              hasTricycle={!!current && current.status !== "off_road"}
              penaltiesOwed={data.penaltiesOwedKobo > 0}
              loanOwed={data.loanOwedKobo > 0}
              canBackdate={can(ctx.actor.role, "payment.backdate")}
            />
          </Card>
        </div>
      </>
    );
  }

  const results = q?.trim() ? (await listOperators(ctx, { q })).slice(0, 20) : [];
  return (
    <>
      <PageHeader title="Take payment" back={{ href: "/money", label: "Money" }} />
      <form className="mb-4 flex gap-2" role="search">
        <input
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="Tricycle code, name or phone"
          aria-label="Find operator"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-base"
        />
        <button className="min-h-11 rounded-lg bg-ink px-4 font-semibold text-gold-light">Find</button>
      </form>
      {q?.trim() ? (
        results.length === 0 ? (
          <Empty>No operator found.</Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {results.map((o) => (
              <li key={o.id}>
                <Link href={`/payments/new?operator=${o.id}`} className="block p-3 hover:bg-gold-wash">
                  <div className="font-bold">{o.name}</div>
                  <div className="text-sm text-muted">
                    {o.tricycleCode ?? "No tricycle"} · {formatPhone(o.phone)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </>
  );
}
