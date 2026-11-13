import type { Metadata } from "next";
import Link from "next/link";
import { recordExpenseAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { PhotoInput } from "@/components/photo-input";
import { Badge, Card, Disclosure, Empty, LinkButton, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { ADVANCE_STATUS_LABELS, EXPENSE_CATEGORY_LABELS, formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listAdvances } from "@/services/expenses";

export const metadata: Metadata = { title: "Expenses" };

type Row = Awaited<ReturnType<typeof listAdvances>>["submitted"][number];

function Advances({ rows }: { rows: Row[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id}>
          <Link href={`/expenses/${row.id}`} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="font-semibold">{row.purpose}</div>
              <div className="text-sm text-muted">
                {formatDate(row.collectedOn)} · {row.recordedBy}
              </div>
              {row.returnNote ? <div className="text-sm font-medium text-danger">Sent back: {row.returnNote}</div> : null}
            </div>
            <div className="shrink-0 text-right">
              <div className="font-semibold tabular-nums">{formatNaira(row.amountKobo)}</div>
              {row.status === "open" && !row.oneStep ? (
                <div className="text-sm text-muted">{formatNaira(row.amountKobo - row.accountedKobo)} left</div>
              ) : row.status === "countersigned" && row.countersignedBy === null ? (
                <Badge tone="good">No approval needed</Badge>
              ) : (
                <Badge tone={row.status === "countersigned" ? "good" : row.status === "open" ? "bad" : "gold"}>
                  {ADVANCE_STATUS_LABELS[row.status]}
                </Badge>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ record?: string; collect?: string }> }) {
  const ctx = await requirePage("finance.view");
  const query = await searchParams;
  const record = query.record === "1" || query.collect === "1";
  const today = businessDate(ctx.clock());
  const data = await listAdvances(ctx);
  const managerRecords = can(ctx.actor.role, "expense.countersign");
  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle={`Spent this month: ${formatNaira(data.spentThisMonthKobo)}`}
        back={{ href: "/money", label: "Money" }}
        action={
          <LinkButton href="/reports/expenses" variant="secondary">
            Expense report
          </LinkButton>
        }
      />
      <div className="space-y-4">
        {data.canRecord ? (
          <Disclosure label="Record an expense" open={record}>
            <ActionForm action={recordExpenseAction}>
              <TextareaField name="description" label="What it was for" />
              <SelectField name="category" label="Category" defaultValue="">
                <option value="" disabled>Choose…</option>
                {Object.entries(EXPENSE_CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </SelectField>
              <Field name="amount" label="Amount (₦)" inputMode="decimal" autoComplete="off" />
              <Field name="spentOn" label="Date spent" type="date" max={today} defaultValue={today} />
              <PhotoInput name="photo" label="Receipt photo (optional)" />
              <p className="text-sm text-muted">
                {managerRecords
                  ? "It comes off the company balance now. Yours needs no approval, and you can correct it until the end of today."
                  : "It comes off the company balance now and waits for the Manager's approval."}
              </p>
              <SubmitButton>Record expense</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
        {data.sentBack.length > 0 ? (
          <Card title={`Sent back to correct (${data.sentBack.length})`}>
            <Advances rows={data.sentBack} />
          </Card>
        ) : null}
        <Card title={`Waiting for approval (${data.submitted.length})`}>
          {data.submitted.length === 0 ? <Empty>Nothing is waiting for approval.</Empty> : <Advances rows={data.submitted} />}
        </Card>
        <Card title="Approved">
          {data.done.length === 0 ? <Empty>No expenses approved yet.</Empty> : <Advances rows={data.done} />}
        </Card>
        {data.older.length > 0 ? (
          <Card title={`Older records to finish (${data.older.length})`}>
            <p className="mb-2 text-sm text-muted">Funds collected before expenses were recorded in one step.</p>
            <Advances rows={data.older} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
