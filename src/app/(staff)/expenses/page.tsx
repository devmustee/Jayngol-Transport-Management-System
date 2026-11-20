import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { recordExpenseAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { PhotoInput } from "@/components/photo-input";
import { SpentOnFields } from "@/components/forms/spent-on-fields";
import { Badge, Card, Disclosure, Empty, LinkButton, PageHeader } from "@/components/ui";
import { addDays, businessDate } from "@/lib/clock";
import { ADVANCE_STATUS_LABELS, EXPENSE_CATEGORY_LABELS, formatDate, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { helpForPage } from "@/guide";
import { EXPENSE_FREE_DAYS, listAdvances } from "@/services/expenses";

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
                {row.category ? ` · ${EXPENSE_CATEGORY_LABELS[row.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? row.category}` : ""}
              </div>
              {row.returnNote && row.status !== "cancelled" ? (
                <div className="text-sm font-medium text-danger">Sent back: {row.returnNote}</div>
              ) : null}
              {row.status === "cancelled" && row.cancelReason ? (
                <div className="text-sm text-muted [overflow-wrap:anywhere]">Why: {row.cancelReason}</div>
              ) : null}
              {row.backdateReason ? (
                <div className="text-sm text-muted [overflow-wrap:anywhere]">Recorded late: {row.backdateReason}</div>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <div className={`font-semibold tabular-nums ${row.status === "cancelled" ? "text-muted line-through" : ""}`}>
                {formatNaira(row.amountKobo)}
              </div>
              {row.status === "cancelled" ? (
                <Badge tone={row.rejectedBy ? "bad" : "plain"}>{row.rejectedBy ? "Rejected" : "Removed"}</Badge>
              ) : row.status === "open" && !row.oneStep ? (
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

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; collect?: string; month?: string }>;
}) {
  const ctx = await requirePage("finance.view");
  const query = await searchParams;
  const record = query.record === "1" || query.collect === "1";
  const today = businessDate(ctx.clock());
  const data = await listAdvances(ctx, queryValue(query.month));
  const managerRecords = can(ctx.actor.role, "expense.countersign");
  const name = data.month === data.thisMonth ? "this month" : monthLabel(data.month);
  return (
    <>
      <PageHeader
        title="Expenses"
        help={helpForPage(ctx.actor.role, "/expenses")?.id}
        subtitle="Money spent, taken off the company balance. Never paid back."
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
              <input type="hidden" name="clientId" value={randomUUID()} />
              <SpentOnFields today={today} freeFrom={addDays(today, -EXPENSE_FREE_DAYS)} defaultValue={today} />
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
        <section aria-labelledby="month-heading" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id="month-heading" className="text-lg font-bold">
              Spent {name}
            </h2>
            <form className="flex gap-2">
              <input
                type="month"
                name="month"
                max={data.thisMonth}
                defaultValue={data.month}
                aria-label="Month"
                className="min-h-11 rounded-lg border border-line bg-card px-3"
              />
              <button className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">Show</button>
            </form>
          </div>
          <Card subtitle="By the day the money was spent. Waiting and approved expenses count; removed and rejected ones do not.">
            <dl className="divide-y divide-line">
              {data.byCategory.length === 0 ? (
                <div className="py-2 text-sm text-muted">Nothing spent {name}.</div>
              ) : (
                data.byCategory.map((row) => (
                  <div key={row.category ?? "none"} className="flex justify-between gap-3 py-2 text-sm">
                    <dt>
                      {row.category
                        ? (EXPENSE_CATEGORY_LABELS[row.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? row.category)
                        : "Not itemised"}
                    </dt>
                    <dd className="tabular-nums">{formatNaira(row.total)}</dd>
                  </div>
                ))
              )}
              <div className="flex justify-between gap-3 py-2 font-bold">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatNaira(data.spentKobo)}</dd>
              </div>
            </dl>
          </Card>
          <Card title={`Approved ${name} (${data.done.length})`}>
            {data.done.length === 0 ? <Empty>No expense approved {name}.</Empty> : <Advances rows={data.done} />}
          </Card>
          {data.removed.length > 0 ? (
            <Card title={`Removed or rejected ${name} (${data.removed.length})`} subtitle="The money went back on the balance.">
              <Advances rows={data.removed} />
            </Card>
          ) : null}
        </section>
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
