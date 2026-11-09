import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DepositForm } from "@/components/forms/deposit-form";
import { Card, Empty, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { queryValue } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listOperators } from "@/services/operators";
import { paymentContext } from "@/services/payments";

export const metadata: Metadata = { title: "Record deposit" };

export default async function RecordDepositPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const ctx = await requirePage("payment.record");
  const params = await searchParams;
  const q = queryValue(params.q);
  const operatorId = queryValue(params.operator);

  if (operatorId) {
    const data = isUuid(operatorId) ? await paymentContext(ctx, operatorId) : null;
    if (!data) notFound();
    return (
      <>
        <PageHeader
          title={data.operator.name}
          subtitle={data.current ? `Tricycle ${data.current.codeNumber}` : "No tricycle"}
          back={{ href: "/deposits/new", label: "Choose another operator" }}
        />
        <Card title="Record deposit" subtitle="Held for the operator. It does not pay any balance.">
          <DepositForm operatorId={data.operator.id} clientId={randomUUID()} />
        </Card>
      </>
    );
  }

  const results = q?.trim() ? (await listOperators(ctx, { q })).slice(0, 20) : [];
  return (
    <>
      <PageHeader title="Record deposit" back={{ href: "/deposits", label: "Deposits" }} />
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
                <Link href={`/deposits/new?operator=${o.id}`} className="block p-3 hover:bg-gold-wash">
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
