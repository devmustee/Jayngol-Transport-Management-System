import type { Metadata } from "next";
import { closeCashAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { cashDay } from "@/services/finance";

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
  const people = await cashDay(ctx, date);

  return (
    <>
      <PageHeader title="Daily cash close" subtitle={formatDate(date)} back={{ href: "/money", label: "Money" }} />
      <form className="mb-4 flex gap-2">
        <input type="date" name="date" max={today} defaultValue={date} aria-label="Date" className="min-h-11 rounded-lg border border-line bg-card px-3" />
        <button className="min-h-11 rounded-lg border border-line bg-card px-4 font-semibold">Show</button>
      </form>
      <div className="space-y-4">
        {people.map((person) => {
          const canClose =
            !person.close &&
            can(ctx.actor.role, "cash.close") &&
            (person.id === ctx.actor.userId || ctx.actor.role === "manager");
          const difference = person.close ? person.close.countedKobo - person.close.expectedKobo : 0;
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
                  ]}
                />
              ) : (
                <p className="mb-3 text-muted">
                  Cash expected: <span className="font-bold text-ink tabular-nums">{formatNaira(person.expectedKobo)}</span>
                </p>
              )}
              {canClose ? (
                <ActionForm action={closeCashAction}>
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
