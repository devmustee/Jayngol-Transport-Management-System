import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { correctCashCountAction } from "@/app/actions";
import { CashierTakingsCard, MyCollectionsCard } from "@/components/balance-periods";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { CashCloseForm } from "@/components/forms/cash-close-form";
import { Badge, Card, Details, Disclosure, Empty, PageHeader } from "@/components/ui";
import { coverageDates, coverageLabel, weekOf } from "@/lib/cash-rhythm";
import { addDays, businessDate } from "@/lib/clock";
import { formatDate, formatDateTime, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { helpForPage, tourForPage } from "@/guide";
import { collectionsByCashier, myCollections } from "@/services/balance-periods";
import { cashDay, recentCloses } from "@/services/finance";

export const metadata: Metadata = { title: "Cash close" };

type Person = Awaited<ReturnType<typeof cashDay>>[number];

/** Each day since the last count with money in or out, then what should be in hand. */
function CoveredDays({ person, tour }: { person: Person; tour: boolean }) {
  const { covers } = person;
  return (
    <div className="rounded-xl border border-line/60 bg-card-subtle/50 px-4" data-tour={tour ? "cash-days" : undefined}>
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
            <li key={day.date}>
              <Link
                href={`/cash-book?whose=${person.id}&from=${day.date}&to=${day.date}`}
                className="-mx-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 rounded-lg px-2 py-2.5 text-sm hover:bg-gold-wash"
              >
                <span className="font-semibold text-ink underline decoration-line underline-offset-2">{formatDate(day.date)}</span>
                <span className="flex gap-3 tabular-nums">
                  {day.inKobo > 0 ? <span className="text-ok">In {formatNaira(day.inKobo)}</span> : null}
                  {day.outKobo > 0 ? <span className="text-danger">Out {formatNaira(day.outKobo)}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-between gap-4 py-3">
        <span className="font-bold text-ink">Cash expected</span>
        <span className="font-semibold tabular-nums">{formatNaira(person.expectedKobo)}</span>
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
  const params = await searchParams;
  const requested = queryValue(params.date);
  const differencesOnly = queryValue(params.diff) === "1";
  const today = businessDate(ctx.clock());
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : today;
  const [people, recent, mine, byCashier] = await Promise.all([
    cashDay(ctx, date),
    recentCloses(ctx, { differencesOnly }),
    can(ctx.actor.role, "payment.record") ? myCollections(ctx) : null,
    collectionsByCashier(ctx),
  ]);

  // The tour points at your own card, or the first one.
  const tourCard = (people.find((person) => person.id === ctx.actor.userId) ?? people[0])?.id;

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
        help={helpForPage(ctx.actor.role, "/cash")?.id}
        tour={tourForPage(ctx.actor.role, "/cash")?.id}
      />
      <form className="mb-4 flex gap-2" data-tour="cash-date">
        <input type="date" name="date" max={today} defaultValue={date} aria-label="Date" className="min-h-11 rounded-lg border border-line bg-card px-3" />
        <button className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">Show</button>
      </form>
      <div className="space-y-4">
        {people.map((person) => {
          const weekly = person.rhythm === "week";
          const isManager = ctx.actor.role === "manager";
          const left = !person.active;
          const canClose =
            !person.close &&
            can(ctx.actor.role, "cash.close") &&
            (left ? isManager && date === today : person.id === ctx.actor.userId || isManager);
          const correctable =
            person.close !== null &&
            person.correction === null &&
            person.isLatestClose &&
            can(ctx.actor.role, "cash.close") &&
            (person.id === ctx.actor.userId || isManager);
          const canCorrect = correctable && person.correctionBlock === null;
          const late = date === today && person.lateSince && !person.close ? person.lateSince : null;
          const difference = person.close ? person.countedKobo! - person.close.expectedKobo : 0;
          const week = weekOf(date);
          const title = left
            ? `${person.name} (has left): cash to take over`
            : weekly
              ? `${person.name}: this week's cash`
              : `${person.name}: ${date === today ? "today's" : "the day's"} cash`;
          const closeLabel = left
            ? "Count and take over"
            : weekly
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
              tour={person.id === tourCard ? "cash-card" : undefined}
              title={title}
              subtitle={
                person.close
                  ? undefined
                  : left
                    ? isManager
                      ? "Count the cash they handed over. It moves into your cash."
                      : "The Manager counts this cash and takes it over."
                    : weekly
                    ? `Week of ${formatDate(week.from)} to ${formatDate(week.to)}. Closes on Sunday, or earlier before travelling.`
                    : "Closes every day."
              }
            >
              {late ? (
                <p className="mb-3 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm font-semibold text-danger">
                  Late: cash not counted since {formatDate(late)}.
                </p>
              ) : null}
              {person.close ? (
                <Details
                  rows={[
                    ["Covers", coverageLabel(person.covers.from, date, person.rhythm)],
                    ["Expected", formatNaira(person.close.expectedKobo)],
                    ["Counted", formatNaira(person.countedKobo!)],
                    [
                      "Counted by",
                      `${person.close.closedBy === person.id ? `${person.closedByName}, their own cash` : person.closedByName}, ${formatDateTime(person.close.closedAt)}`,
                    ],
                    ...(person.correction
                      ? ([
                          [
                            "Corrected",
                            `From ${formatNaira(person.close.countedKobo)} by ${person.correction.byName}: ${person.correction.reason}`,
                          ],
                        ] as [string, string][])
                      : []),
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
                    // Second checks were dropped; counts checked before then still show it.
                    ...(person.check?.checkedBy
                      ? ([
                          [
                            "Second check",
                            person.check.recountedKobo === null || person.check.recountedKobo === person.close.countedKobo ? (
                              <Badge key="c" tone="good">Agreed</Badge>
                            ) : (
                              <Badge key="c" tone="bad">Recounted {formatNaira(person.check.recountedKobo)}</Badge>
                            ),
                          ],
                        ] as [string, ReactNode][])
                      : []),
                    ...(person.check?.checkedBy && person.check.note ? ([["Check note", person.check.note]] as [string, string][]) : []),
                  ]}
                />
              ) : (
                <CoveredDays person={person} tour={person.id === tourCard} />
              )}
              {closeLastWeek ? (
                <Link
                  href={`/cash?date=${addDays(today, -1)}`}
                  className="mt-3 flex min-h-11 items-center justify-center rounded-xl border border-gold-light/60 bg-gold-wash/50 px-4 text-sm font-bold text-gold-deep"
                >
                  Close last week instead, up to Sunday {formatDate(addDays(today, -1))}
                </Link>
              ) : null}
              {canCorrect && person.close ? (
                <div className="mt-3">
                  <Disclosure label="Correct this count">
                    <ActionForm action={correctCashCountAction.bind(null, person.close.id)}>
                      <Field
                        name="counted"
                        label={`Correct count for ${formatDate(date)} (₦)`}
                        inputMode="decimal"
                        autoComplete="off"
                        hint="The figure that should have been saved. A count can be corrected once, until the next count."
                      />
                      <TextareaField name="reason" label="Reason" />
                      <SubmitButton tone="plain">Save correction</SubmitButton>
                    </ActionForm>
                  </Disclosure>
                </div>
              ) : null}
              {correctable && !canCorrect ? <p className="mt-3 text-sm text-muted">{person.correctionBlock}</p> : null}
              {canClose ? (
                <CashCloseForm
                  custodianId={person.id}
                  date={date}
                  dateLabel={formatDate(date)}
                  coverage={coverageDates(person.covers.from, date)}
                  expectedKobo={person.expectedKobo}
                  laterKobo={person.laterKobo}
                  label={closeLabel}
                  takeOver={left ? `What you count moves from ${person.name}'s cash into yours.` : null}
                  tour={person.id === tourCard}
                />
              ) : null}
            </Card>
          );
        })}
        <Card
          tour="cash-recent"
          title="Recent counts"
          subtitle={differencesOnly ? "Counts that did not match" : "The latest counts of everyone's cash"}
          action={
            <Link
              href={differencesOnly ? `/cash?date=${date}` : `/cash?date=${date}&diff=1`}
              className="text-sm font-semibold text-gold-deep underline"
            >
              {differencesOnly ? "Show all" : "Only differences"}
            </Link>
          }
        >
          {recent.length === 0 ? (
            <Empty help={differencesOnly ? null : helpForPage(ctx.actor.role, "/cash")?.id}>
              {differencesOnly ? "Every count has matched." : "No cash has been counted yet."}
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {recent.map((row) => {
                const difference = row.counted - row.expected;
                return (
                  <li key={row.id}>
                    <Link
                      href={`/cash?date=${row.date}`}
                      className="-mx-2 flex items-start justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-gold-wash"
                    >
                      <span className="min-w-0">
                        <span className="block font-semibold">
                          {row.custodian} · {formatDate(row.date)}
                        </span>
                        <span className="block text-sm text-muted">
                          {formatNaira(row.counted)} counted{row.own ? "" : ` by ${row.closed_by}`}
                          {row.corrected ? ", corrected" : ""}
                        </span>
                      </span>
                      {difference === 0 ? (
                        <Badge tone="good">Matches</Badge>
                      ) : (
                        <Badge tone="bad">
                          {difference < 0 ? "Short" : "Over"} {formatNaira(Math.abs(difference))}
                        </Badge>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {mine ? <MyCollectionsCard data={mine} /> : null}
        <CashierTakingsCard rows={byCashier} />
      </div>
    </>
  );
}
