import type { Metadata } from "next";
import Link from "next/link";
import { checkCashCloseAction, closeCashAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { cashDay, uncheckedCloses } from "@/services/finance";

export const metadata: Metadata = { title: "Cash close" };

export default async function CashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("finance.view");
  const requested = queryValue((await searchParams).date);
  const today = businessDate(ctx.clock());
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : today;
  const [people, unchecked] = await Promise.all([cashDay(ctx, date), uncheckedCloses(ctx)]);

  return (
    <>
      <PageHeader title="Daily cash close" subtitle={formatDate(date)} back={{ href: "/money", label: "Money" }} />
      <form className="mb-4 flex gap-2">
        <input type="date" name="date" max={today} defaultValue={date} aria-label="Date" className="min-h-11 rounded-lg border border-line bg-card px-3" />
        <button className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">Show</button>
      </form>
      <div className="space-y-4">
        {unchecked.length > 0 ? (
          <Card title="Counts waiting for a second check">
            <ul className="divide-y divide-line">
              {unchecked.map((item) => (
                <li key={item.id}>
                  <Link href={`/cash?date=${item.date}`} className="flex min-h-11 items-center justify-between gap-3 font-medium">
                    <span>{item.name}</span>
                    <span className="text-muted">{formatDate(item.date)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {people.map((person) => {
          const canClose =
            !person.close &&
            can(ctx.actor.role, "cash.close") &&
            (person.id === ctx.actor.userId || ctx.actor.role === "manager");
          const difference = person.close ? person.close.countedKobo - person.close.expectedKobo : 0;
          const canCheck =
            !!person.close && !person.check && can(ctx.actor.role, "cash.close") && person.close.closedBy !== ctx.actor.userId;
          return (
            <Card key={person.id} title={person.name}>
              {person.close ? (
                <Details
                  rows={[
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
                <Details
                  rows={[
                    ["Brought forward", formatNaira(person.openingKobo)],
                    ["Moved this day", `${person.movedKobo < 0 ? "-" : ""}${formatNaira(Math.abs(person.movedKobo))}`],
                    ["Cash expected", formatNaira(person.expectedKobo)],
                  ]}
                />
              )}
              {canCheck ? (
                <ActionForm action={checkCashCloseAction.bind(null, person.close!.id)} className="mt-3 space-y-4">
                  <Field name="recounted" label="Your recount (₦)" inputMode="decimal" autoComplete="off" />
                  <TextareaField name="note" label="Note" hint="Required if your recount is different." />
                  <SubmitButton>Confirm count</SubmitButton>
                </ActionForm>
              ) : null}
              {canClose ? (
                <ActionForm action={closeCashAction} className="mt-3 space-y-4">
                  <input type="hidden" name="custodianId" value={person.id} />
                  <input type="hidden" name="businessDate" value={date} />
                  <Field name="counted" label="Cash counted (₦)" inputMode="decimal" autoComplete="off" />
                  <TextareaField name="explanation" label="Explanation" hint="Required if the count does not match." />
                  <SubmitButton>Close cash</SubmitButton>
                </ActionForm>
              ) : null}
            </Card>
          );
        })}
      </div>
    </>
  );
}
