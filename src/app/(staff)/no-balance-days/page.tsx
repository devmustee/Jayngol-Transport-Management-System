import type { Metadata } from "next";
import { addNoBalanceDayAction, removeNoBalanceDayAction, waiveFleetDayAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/form";
import { Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listNonCollectionDays } from "@/services/finance";

export const metadata: Metadata = { title: "No-balance days" };

export default async function NoBalanceDaysPage() {
  const ctx = await requirePage("finance.view");
  const days = await listNonCollectionDays(ctx);
  const canManage = can(ctx.actor.role, "calendar.manage");
  const canWaive = can(ctx.actor.role, "balance.waive");
  const today = businessDate(ctx.clock());

  return (
    <>
      <PageHeader title="No-balance days" subtitle="No daily balance is charged on these dates." back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        {canManage ? (
          <Card title="Add a date">
            <ActionForm action={addNoBalanceDayAction}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field name="businessDate" label="Date" type="date" />
                <Field name="reason" label="Reason" autoComplete="off" />
              </div>
              <SubmitButton>Add date</SubmitButton>
            </ActionForm>
          </Card>
        ) : null}
        {canWaive ? (
          <Disclosure label="Waive a past day for the whole fleet">
            <p className="mb-3 text-sm text-muted">
              For a day already begun or past, such as a flood or a strike. The date becomes a no-balance day, and every
              unpaid balance raised for it is waived with its late fine. The Owner is told once.
            </p>
            <ActionForm action={waiveFleetDayAction}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field name="businessDate" label="Date" type="date" max={today} defaultValue={today} />
                <Field name="note" label="Reason" autoComplete="off" />
              </div>
              <SubmitButton>Waive this day for everyone</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
        {days.length === 0 ? (
          <Empty>No dates marked.</Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {days.map((day) => (
              <li key={day.businessDate} className="flex items-center justify-between gap-3 p-3">
                <div>
                  <div className="font-bold">{formatDate(day.businessDate)}</div>
                  <div className="text-sm text-muted">{day.reason}</div>
                </div>
                {canManage && day.businessDate > today ? (
                  <ActionForm action={removeNoBalanceDayAction.bind(null, day.businessDate)}>
                    <SubmitButton tone="plain">Remove</SubmitButton>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
