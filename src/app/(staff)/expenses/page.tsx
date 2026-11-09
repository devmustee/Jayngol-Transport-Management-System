import type { Metadata } from "next";
import Link from "next/link";
import { createAdvanceAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { MoneySourceField } from "@/components/money-source";
import { Badge, Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import { ADVANCE_STATUS_LABELS, formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { moneySources } from "@/services/cash-book";
import { listAdvances } from "@/services/expenses";

export const metadata: Metadata = { title: "Expenses" };

type Row = Awaited<ReturnType<typeof listAdvances>>["open"][number];

function Advances({ rows }: { rows: Row[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id}>
          <Link href={`/expenses/${row.id}`} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="font-semibold">{row.purpose}</div>
              <div className="text-sm text-muted">{formatDate(row.collectedOn)}</div>
              {row.returnNote ? <div className="text-sm font-medium text-danger">Sent back: {row.returnNote}</div> : null}
            </div>
            <div className="shrink-0 text-right">
              <div className="font-semibold tabular-nums">{formatNaira(row.amountKobo)}</div>
              {row.status === "open" ? (
                <div className="text-sm text-muted">{formatNaira(row.amountKobo - row.accountedKobo)} left</div>
              ) : (
                <Badge tone={row.status === "countersigned" ? "good" : "gold"}>{ADVANCE_STATUS_LABELS[row.status]}</Badge>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function ExpensesPage() {
  const ctx = await requirePage("finance.view");
  const [data, sources] = await Promise.all([listAdvances(ctx), moneySources(ctx)]);
  return (
    <>
      <PageHeader title="Expenses" subtitle={`Still to account for: ${formatNaira(data.outstandingKobo)}`} back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        {data.canRecord ? (
          <Disclosure label="Collect funds for expenses">
            <ActionForm action={createAdvanceAction}>
              <TextareaField name="purpose" label="What the money is for" />
              <Field name="amount" label="Amount (₦)" inputMode="decimal" autoComplete="off" />
              <MoneySourceField sources={sources} />
              <SubmitButton>Record funds collected</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
        <Card title={`To account for (${data.open.length})`}>
          {data.open.length === 0 ? <Empty>Nothing is waiting to be accounted for.</Empty> : <Advances rows={data.open} />}
        </Card>
        <Card title={`Waiting for countersign (${data.submitted.length})`}>
          {data.submitted.length === 0 ? <Empty>Nothing is waiting for a countersign.</Empty> : <Advances rows={data.submitted} />}
        </Card>
        {data.done.length > 0 ? (
          <Card title="Countersigned">
            <Advances rows={data.done} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
