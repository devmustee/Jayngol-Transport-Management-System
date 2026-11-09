import type { Metadata } from "next";
import { addNoBalanceDayAction, removeNoBalanceDayAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/form";
import { Card, Empty, PageHeader } from "@/components/ui";
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
