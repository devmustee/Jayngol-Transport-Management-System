import type { Metadata } from "next";
import Link from "next/link";
import { checkInServiceAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/form";
import { Badge, Card, Empty, LinkButton, PageHeader, SearchBar } from "@/components/ui";
import { formatDate, formatDateTime, queryValue, WORK_TYPE_LABELS } from "@/lib/format";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listWorkshop } from "@/services/workshop";
import { helpForPage } from "@/guide";

export const metadata: Metadata = { title: "Workshop" };

type Row = Awaited<ReturnType<typeof listWorkshop>>["dueToday"][number];

const squash = (text: string | null | undefined) => (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (text: string | null | undefined) => (text ?? "").replace(/\D/g, "");

/** Tricycle code or plate, operator name or phone, the fault, or service or repair. */
function matches(row: Row, query: string) {
  const text = squash(query);
  if (!text) return true;
  const fields = [row.code, row.registration, row.operatorName, row.fault, WORK_TYPE_LABELS[row.type]];
  if (fields.some((field) => squash(field).includes(text))) return true;
  const number = digits(query);
  if (number.length < 3 || !row.operatorPhone) return false;
  const phone = digits(row.operatorPhone);
  return (phone.startsWith("234") ? `0${phone.slice(3)}` : phone).includes(number) || phone.includes(number);
}

function Who({ row }: { row: Row }) {
  return (
    <div className="text-sm text-muted">
      Registration {row.registration}
      {" · "}
      {row.operatorName ? (
        <>
          {row.operatorName},{" "}
          <a href={`tel:${row.operatorPhone}`} className="hover:text-ink hover:underline">
            {formatPhone(row.operatorPhone!)}
          </a>
        </>
      ) : (
        "No operator"
      )}
    </div>
  );
}

function Order({ row, checkIn, note }: { row: Row; checkIn: boolean; note: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <Link href={`/workshop/${row.id}`} className="inline-flex min-h-11 items-center font-bold text-gold-deep underline">{row.code}</Link>
        <Who row={row} />
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

export default async function WorkshopPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("workorder.view");
  const q = queryValue((await searchParams).q)?.trim().slice(0, 60) ?? "";
  const all = await listWorkshop(ctx);
  const pick = (rows: Row[]) => rows.filter((row) => matches(row, q));
  const [inWorkshop, overdue, dueToday, upcoming] = [all.inWorkshop, all.overdue, all.dueToday, all.upcoming].map(pick) as [
    Row[], Row[], Row[], Row[],
  ];
  const found = inWorkshop.length + overdue.length + dueToday.length + upcoming.length;
  const canCheckIn = can(ctx.actor.role, "workorder.checkin");
  return (
    <>
      <PageHeader
        help={helpForPage(ctx.actor.role, "/workshop")?.id}
        title="Workshop"
        subtitle="Services run 8:00 to 10:00 am"
        action={
          <>
            {can(ctx.actor.role, "workorder.manage") ? <LinkButton href="/workshop/new" variant="gold">Take in for repair</LinkButton> : null}
            <LinkButton href="/workshop/report" variant="secondary">Report</LinkButton>
            <LinkButton href="/workshop/history" variant="secondary">History</LinkButton>
          </>
        }
      />
      <SearchBar q={q} placeholder="Search tricycle, plate, operator or fault" />
      {q ? (
        <p className="mb-4 text-sm text-muted" aria-live="polite">
          {found === 0 ? `Nothing in the workshop list matches "${q}".` : `${found} match "${q}".`}{" "}
          <Link href="/workshop" className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline underline-offset-2">
            Clear search
          </Link>
          {" "}Past work is in{" "}
          <Link href="/workshop/history" className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline underline-offset-2">
            History
          </Link>
          .
        </p>
      ) : null}
      <div className="space-y-4">
        <Card title={`Due today (${dueToday.length})`}>
          {dueToday.length === 0 ? (
            <Empty>{q ? "No match due today." : "No services due today."}</Empty>
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
            <Empty>{q ? "No match in the workshop." : "Nothing in the workshop."}</Empty>
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
                  <div className="min-w-0">
                    <Link href={`/workshop/${row.id}`} className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline">{row.code}</Link>
                    <Who row={row} />
                  </div>
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
