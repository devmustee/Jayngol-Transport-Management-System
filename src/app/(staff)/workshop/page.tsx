import type { Metadata } from "next";
import Link from "next/link";
import { checkInServiceAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { formatDate, formatDateTime, WORK_TYPE_LABELS } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listWorkshop } from "@/services/workshop";

export const metadata: Metadata = { title: "Workshop" };

type Row = Awaited<ReturnType<typeof listWorkshop>>["dueToday"][number];

function Order({ row, checkIn, note }: { row: Row; checkIn: boolean; note: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <Link href={`/workshop/${row.id}`} className="inline-flex min-h-11 items-center font-bold text-gold-deep underline">{row.code}</Link>
        <div className="text-sm text-muted">{note}</div>
        {row.fault ? <div className="text-sm">{row.fault}</div> : null}
      </div>
      {checkIn ? (
        <ActionForm action={checkInServiceAction.bind(null, row.id)}>
          <SubmitButton>Check in</SubmitButton>
        </ActionForm>
      ) : null}
    </li>
  );
}

export default async function WorkshopPage() {
  const ctx = await requirePage("workorder.view");
  const { inWorkshop, overdue, dueToday, upcoming } = await listWorkshop(ctx);
  const canCheckIn = can(ctx.actor.role, "workorder.checkin");
  return (
    <>
      <PageHeader
        title="Workshop"
        subtitle="Services run 8:00 to 10:00 am"
        action={
          <>
            {can(ctx.actor.role, "workorder.manage") ? <LinkButton href="/workshop/new" variant="gold">Take in for repair</LinkButton> : null}
            <LinkButton href="/workshop/history" variant="secondary">History</LinkButton>
          </>
        }
      />
      <div className="space-y-4">
        <Card title={`Due today (${dueToday.length})`}>
          {dueToday.length === 0 ? (
            <Empty>No services due today.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {dueToday.map((row) => <Order key={row.id} row={row} checkIn={canCheckIn} note="Service" />)}
            </ul>
          )}
        </Card>
        {overdue.length > 0 ? (
          <Card title={`Overdue (${overdue.length})`}>
            <ul className="divide-y divide-line">
              {overdue.map((row) => <Order key={row.id} row={row} checkIn={canCheckIn} note={`Was due ${formatDate(row.scheduledFor!)}`} />)}
            </ul>
          </Card>
        ) : null}
        <Card title={`In the workshop (${inWorkshop.length})`}>
          {inWorkshop.length === 0 ? (
            <Empty>Nothing in the workshop.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {inWorkshop.map((row) => (
                <Order key={row.id} row={row} checkIn={false} note={`${WORK_TYPE_LABELS[row.type]} · In since ${formatDateTime(row.checkedInAt!)}`} />
              ))}
            </ul>
          )}
        </Card>
        {upcoming.length > 0 ? (
          <Card title="Next 7 days">
            <ul className="divide-y divide-line">
              {upcoming.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/workshop/${row.id}`} className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline">{row.code}</Link>
                  <Badge tone="plain">{formatDate(row.scheduledFor!)}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
