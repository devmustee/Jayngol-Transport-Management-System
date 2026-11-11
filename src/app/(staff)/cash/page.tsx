import type { Metadata } from "next";
import Link from "next/link";
import { checkCashCloseAction, closeCashAction } from "@/app/actions";
import { CashierTakingsCard, MyCollectionsCard } from "@/components/balance-periods";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, PageHeader } from "@/components/ui";
import { coverageDates, coverageLabel, weekOf } from "@/lib/cash-rhythm";
import { addDays, businessDate } from "@/lib/clock";
import { formatDate, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { collectionsByCashier, myCollections } from "@/services/balance-periods";
import { cashDay, uncheckedCloses } from "@/services/finance";

export const metadata: Metadata = { title: "Cash close" };

type Person = Awaited<ReturnType<typeof cashDay>>[number];

/** Each day since the last count with money in or out, then what should be in hand. */
function CoveredDays({ person }: { person: Person }) {
  const { covers } = person;
  return (
    <div className="rounded-xl border border-line/60 bg-card-subtle/50 px-4">
      <div className="flex justify-between gap-4 border-b border-line/70 py-3 text-sm">
        <span className="font-medium text-muted">
          {covers.lastClose ? `Counted on ${formatDate(covers.lastClose.date)}` : "Brought forward"}
        </span>
        <span className="font-semibold tabular-nums">{formatNaira(covers.lastClose?.heldKobo ?? 0)}</span>
      </div>
      {covers.days.length === 0 ? (
        <p className="border-b border-line/70 py-3 text-sm text-muted">No cash in or out since then.</p>
      ) : (
        <ul className="divide-y divide-line/70 border-b border-line/70">
          {covers.days.map((day) => (
            <li key={day.date} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 text-sm">
              <span className="font-semibold text-ink">{formatDate(day.date)}</span>
              <span className="flex gap-3 tabular-nums">
                {day.inKobo > 0 ? <span className="text-ok">In {formatNaira(day.inKobo)}</span> : null}
                {day.outKobo > 0 ? <span className="text-danger">Out {formatNaira(day.outKobo)}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-between gap-4 py-3">
        <span className="font-bold text-ink">Cash expected</span>
        <span className="font-extrabold tabular-nums">{formatNaira(person.expectedKobo)}</span>
      </div>
    </div>
  );
}

export default async function CashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("finance.view");
  const requested = queryValue((await searchParams).date);
  const today = businessDate(ctx.clock());
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : today;
  const [people, unchecked, mine, byCashier] = await Promise.all([
    cashDay(ctx, date),
    uncheckedCloses(ctx),
    can(ctx.actor.role, "payment.record") ? myCollections(ctx) : null,
    collectionsByCashier(ctx),
  ]);

  return (
    <>
      <PageHeader
        title="Cash close"
        subtitle={
          <>
            {formatDate(date)}. The Assistant Manager closes every day and the Manager once a week, Monday to Sunday.
          </>
        }
        back={{ href: "/money", label: "Money" }}
      />
      <form className="mb-4 flex gap-2">
        <input type="date" name="date" max={today} defaultValue={date} aria-label="Date" className="min-h-11 rounded-lg border border-line bg-card px-3" />
        <button className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">Show</button>
      </form>
      <div className="space-y-4">
        {mine ? <MyCollectionsCard data={mine} /> : null}
        <CashierTakingsCard rows={byCashier} />
        {unchecked.length > 0 ? (
          <Card title="Counts waiting for a second check">
            <ul className="divide-y divide-line">
              {unchecked.map((item) => (
                <li key={item.id}>
                  <Link href={`/cash?date=${item.date}`} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 py-1.5 font-medium">
                    <span>{item.name}</span>
                    <span className="text-sm text-muted">{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {people.map((person) => {
          const weekly = person.rhythm === "week";
          const canClose =
            !person.close &&
            can(ctx.actor.role, "cash.close") &&
            (person.id === ctx.actor.userId || ctx.actor.role === "manager");
          const difference = person.close ? person.close.countedKobo - person.close.expectedKobo : 0;
          const canCheck =
            !!person.close && !person.check && can(ctx.actor.role, "cash.check") && person.close.closedBy !== ctx.actor.userId;
          const week = weekOf(date);
          const title = weekly ? `${person.name}: this week's cash` : `${person.name}: ${date === today ? "today's" : "the day's"} cash`;
          const closeLabel = weekly
            ? date === week.to
              ? "Close this week"
              : `Close the week early, up to ${formatDate(date)}`
            : date === today
              ? "Close today's cash"
              : `Close cash for ${formatDate(date)}`;
          // Monday is a day of grace for last week: offer to close it up to Sunday.
          const closeLastWeek = weekly && canClose && date === today && today === week.from;
          return (
            <Card
              key={person.id}
              title={title}
              subtitle={
                person.close
                  ? undefined
                  : weekly
                    ? `Week of ${formatDate(week.from)} to ${formatDate(week.to)}. Closes on Sunday, or earlier before travelling.`
                    : "Closes every day."
              }
            >
              {person.close ? (
                <Details
                  rows={[
                    ["Covers", coverageLabel(person.covers.from, date, person.rhythm)],
                    ["Expected", formatNaira(person.close.expectedKobo)],
                    ["Counted", formatNaira(person.close.countedKobo)],
                    [
                      "Result",
                      difference === 0 ? (
                        <Badge key="b" tone="good">Matches</Badge>
                      ) : (
                        <Badge key="b" tone="bad">
                          {difference < 0 ? "Short" : "Over"} {formatNaira(Math.abs(difference))}
                        </Badge>
                      ),
                    ],
                    ...(person.close.explanation ? ([["Explanation", person.close.explanation]] as [string, string][]) : []),
                    [
                      "Second check",
                      person.check ? (
                        person.check.recountedKobo === null || person.check.recountedKobo === person.close.countedKobo ? (
                          <Badge key="c" tone="good">{person.check.checkedBy ? "Agreed" : "Not needed"}</Badge>
                        ) : (
                          <Badge key="c" tone="bad">Recounted {formatNaira(person.check.recountedKobo)}</Badge>
                        )
                      ) : (
                        <Badge key="c" tone="gold">Waiting</Badge>
                      ),
                    ],
                    ...(person.check?.note ? ([["Check note", person.check.note]] as [string, string][]) : []),
                  ]}
                />
              ) : (
                <CoveredDays person={person} />
              )}
              {canCheck ? (
                <ActionForm action={checkCashCloseAction.bind(null, person.close!.id)} className="mt-3 space-y-4">
                  <Field name="recounted" label="Your recount (₦)" inputMode="decimal" autoComplete="off" />
                  <TextareaField name="note" label="Note" hint="Required if your recount is different." />
                  <SubmitButton>Confirm count</SubmitButton>
                </ActionForm>
              ) : null}
              {closeLastWeek ? (
                <Link
                  href={`/cash?date=${addDays(today, -1)}`}
                  className="mt-3 flex min-h-11 items-center justify-center rounded-xl border border-gold-light/60 bg-gold-wash/50 px-4 text-sm font-bold text-gold-deep"
                >
                  Close last week instead, up to Sunday {formatDate(addDays(today, -1))}
                </Link>
              ) : null}
              {canClose ? (
                <ActionForm action={closeCashAction} className="mt-3 space-y-4">
                  <input type="hidden" name="custodianId" value={person.id} />
                  <input type="hidden" name="businessDate" value={date} />
                  <Field
                    name="counted"
                    label="Cash counted (₦)"
                    inputMode="decimal"
                    autoComplete="off"
                    hint={`This count covers ${coverageDates(person.covers.from, date)}.`}
                  />
                  <TextareaField name="explanation" label="Explanation" hint="Required if the count does not match." />
                  <SubmitButton>{closeLabel}</SubmitButton>
                </ActionForm>
              ) : null}
            </Card>
          );
        })}
      </div>
    </>
  );
}
