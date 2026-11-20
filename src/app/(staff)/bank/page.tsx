import type { Metadata } from "next";
import {
  confirmBankItemsAction,
  correctOpeningBalanceAction,
  correctReconciliationAction,
  recordReconciliationAction,
  setOpeningBalanceAction,
  undoBankConfirmAction,
} from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Disclosure, Empty, PageHeader } from "@/components/ui";
import { formatDate, formatDateTime, METHOD_LABELS, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { helpForPage } from "@/guide";
import { bankPosition, type ToConfirm } from "@/services/bank";

export const metadata: Metadata = { title: "Bank check" };

const INPUT = "min-h-11 w-full min-w-0 rounded-lg border border-line bg-card px-3 text-base";

const signed = (kobo: number) => `${kobo < 0 ? "-" : ""}${formatNaira(Math.abs(kobo))}`;
const naira = (kobo: number) => `${kobo < 0 ? "-" : ""}${(Math.abs(kobo) / 100).toFixed(2)}`;
const monthName = (month: string) =>
  new Date(`${month.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString("en-NG", { month: "long", year: "numeric", timeZone: "UTC" });

function ItemText({ item }: { item: ToConfirm }) {
  return (
    <div className="min-w-0">
      <div className="font-semibold">{item.operator}</div>
      <div className="break-words text-sm text-muted">
        {item.kind === "deposit" ? "Saving · " : ""}
        {METHOD_LABELS[item.method as keyof typeof METHOD_LABELS]} · {item.reference} · {item.receipt} · {formatDate(item.date)}
      </div>
    </div>
  );
}

export default async function BankPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const ctx = await requirePage("finance.view");
  const q = queryValue((await searchParams).q);
  const bank = await bankPosition(ctx, { q });
  const shown = bank.toConfirm.length;

  return (
    <>
      <PageHeader title="Bank check" help={helpForPage(ctx.actor.role, "/bank")?.id} subtitle="Match the books to the bank statement" back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        <Card title="Bank position">
          <Details
            rows={[
              ["Balance in the books", signed(bank.bookKobo)],
              ["Not yet confirmed", formatNaira(bank.unconfirmedKobo)],
              ...(bank.opening
                ? ([["Books start", `${formatDate(bank.opening.asOf)}, with ${signed(bank.opening.amountKobo)}`]] as [string, string][])
                : []),
            ]}
          />
          {bank.opening ? (
            <p className="mt-2 text-xs text-muted">
              Bank money before {formatDate(bank.opening.asOf)} is in the opening balance, so it is not counted again.
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">
              No opening balance yet, so the books count every bank movement and months cannot be reconciled.
            </p>
          )}
          {bank.canSetOpening && !bank.hasOpening ? (
            <ActionForm action={setOpeningBalanceAction} className="mt-3 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  name="amount"
                  label="Opening bank balance (₦)"
                  inputMode="text"
                  autoComplete="off"
                  hint="The statement balance at the start of the date. Put a minus if overdrawn."
                />
                <Field name="date" label="As of date" type="date" max={bank.today} />
              </div>
              <SubmitButton>Save opening balance</SubmitButton>
            </ActionForm>
          ) : null}
          {bank.opening && bank.opening.corrections.length > 0 ? (
            <div className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
              <div className="font-semibold">Corrections</div>
              <ul className="space-y-1 text-muted">
                {bank.opening.corrections.map((c) => (
                  <li key={c.id}>
                    {signed(c.amount)} from {formatDate(c.as_of)}, by {c.by}, {formatDateTime(new Date(c.corrected_at))}: {c.reason}
                  </li>
                ))}
                <li>
                  First set at {signed(bank.opening.first.amountKobo)} from {formatDate(bank.opening.first.date)}
                </li>
              </ul>
            </div>
          ) : null}
        </Card>
        {bank.canCorrectOpening && bank.opening ? (
          <Disclosure label="Correct the opening balance">
            <ActionForm action={correctOpeningBalanceAction}>
              <p className="text-sm text-muted">
                Possible until the first month is reconciled. The first figure stays on record.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="fix-amount"
                  name="amount"
                  label="Opening bank balance (₦)"
                  inputMode="text"
                  autoComplete="off"
                  defaultValue={naira(bank.opening.amountKobo)}
                  hint="Put a minus if overdrawn."
                />
                <Field id="fix-date" name="date" label="As of date" type="date" max={bank.today} defaultValue={bank.opening.asOf} />
              </div>
              <TextareaField id="fix-reason" name="reason" label="Why is it corrected?" rows={2} />
              <SubmitButton>Correct opening balance</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}

        <Card
          title="Transfers and POS to confirm"
          subtitle={bank.waitingCount > 0 ? `${bank.waitingCount} waiting, ${formatNaira(bank.waitingKobo)}` : undefined}
        >
          {bank.waitingCount > 0 ? (
            <form className="mb-3 flex gap-2" role="search">
              <input
                type="search"
                name="q"
                defaultValue={bank.q ?? ""}
                placeholder="Reference, receipt, name or amount"
                aria-label="Search what is waiting"
                className={INPUT}
              />
              <button className="min-h-11 shrink-0 rounded-lg bg-ink px-4 font-semibold text-gold-light">Find</button>
            </form>
          ) : null}
          {bank.waitingCount === 0 ? (
            <Empty>Everything has been confirmed.</Empty>
          ) : shown === 0 ? (
            <Empty>Nothing waiting matches “{bank.q}”.</Empty>
          ) : (
            <ActionForm action={confirmBankItemsAction} className="space-y-3">
              <ul className="divide-y divide-line">
                {bank.toConfirm.map((item) => {
                  const mine = item.received_by === bank.userId;
                  const tickable = bank.canReconcile && !mine;
                  const body = (
                    <>
                      <ItemText item={item} />
                      <span className="shrink-0 font-semibold tabular-nums">{formatNaira(item.amount)}</span>
                    </>
                  );
                  return (
                    <li key={item.id} className="py-3 first:pt-0 last:pb-0">
                      {tickable ? (
                        <label className="flex cursor-pointer items-start gap-3">
                          <input type="checkbox" name="item" value={`${item.kind}:${item.id}`} className="mt-1 size-5 shrink-0" />
                          <span className="flex min-w-0 flex-1 items-start justify-between gap-3">{body}</span>
                        </label>
                      ) : (
                        <div className="flex items-start justify-between gap-3">{body}</div>
                      )}
                      {bank.canReconcile && mine ? (
                        <p className="mt-1 text-sm text-muted">You recorded this, so someone else must confirm it.</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {bank.matchedCount > shown ? (
                <p className="text-sm text-muted">
                  Showing the oldest {shown} of {bank.matchedCount}. Confirm these, or search, to see the rest.
                </p>
              ) : null}
              {bank.canReconcile ? <SubmitButton>Confirm ticked: seen on the statement</SubmitButton> : null}
            </ActionForm>
          )}
        </Card>

        {bank.confirmedToday.length > 0 ? (
          <Card title="Confirmed today" subtitle="A confirmation made by mistake can be undone today by whoever made it.">
            <ul className="divide-y divide-line">
              {bank.confirmedToday.map((item) => (
                <li key={item.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <ItemText item={item} />
                    <span className="shrink-0 font-semibold tabular-nums">{formatNaira(item.amount)}</span>
                  </div>
                  <div className="text-sm text-muted">Confirmed by {item.confirmed_by_name}</div>
                  {bank.canReconcile && item.confirmed_by === bank.userId ? (
                    <ActionForm action={undoBankConfirmAction.bind(null, item.kind, item.id)}>
                      <SubmitButton tone="plain">Undo, not on the statement</SubmitButton>
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {bank.canReconcile ? (
          <Card title="Reconcile a month">
            {!bank.hasOpening ? (
              <p className="text-sm text-muted">The opening bank balance must be set first, so the books have somewhere to start.</p>
            ) : !bank.nextMonth ? (
              <p className="text-sm text-muted">Every month that has ended is reconciled.</p>
            ) : (
              <ActionForm action={recordReconciliationAction}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    name="month"
                    label="Month"
                    type="month"
                    defaultValue={bank.nextMonth}
                    min={bank.opening?.asOf.slice(0, 7)}
                    max={bank.lastMonth}
                  />
                  <Field
                    name="statement"
                    label="Closing balance on the statement (₦)"
                    inputMode="text"
                    autoComplete="off"
                    hint="Put a minus if overdrawn."
                  />
                </div>
                <TextareaField name="explanation" label="Explanation" hint="Required if the statement differs from the books, such as bank charges." />
                <SubmitButton>Save reconciliation</SubmitButton>
              </ActionForm>
            )}
          </Card>
        ) : null}

        <Card title="Past reconciliations">
          {bank.history.length === 0 ? (
            <Empty>No month has been reconciled yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {bank.history.map((row) => {
                const statement = row.corrected_statement ?? row.statement;
                const explanation = row.corrected_statement !== null ? row.corrected_explanation : row.explanation;
                const difference = statement - row.book;
                return (
                  <li key={row.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{monthName(row.month)}</span>
                      <Badge tone={difference === 0 ? "good" : "bad"}>{difference === 0 ? "Matches" : `Difference ${signed(difference)}`}</Badge>
                    </div>
                    <Details
                      rows={[
                        ["Statement", signed(statement)],
                        ["Books", signed(row.book)],
                        ["Not yet confirmed then", formatNaira(row.unconfirmed)],
                        ["Recorded by", `${row.recorded_by}, ${formatDateTime(new Date(row.created_at))}`],
                        ...(explanation ? ([["Explanation", explanation]] as [string, string][]) : []),
                        ...(row.corrected_statement !== null
                          ? ([
                              [
                                "Corrected",
                                `From ${signed(row.statement)} by ${row.corrected_by}, ${formatDateTime(new Date(row.corrected_at!))}: ${row.correction_reason}`,
                              ],
                            ] as [string, string][])
                          : []),
                      ]}
                    />
                    {bank.canReconcile && row.corrected_statement === null ? (
                      <Disclosure label="Correct the statement figure">
                        <ActionForm action={correctReconciliationAction.bind(null, row.id)}>
                          <p className="text-sm text-muted">Once only. The books stay frozen and the first figure stays on record.</p>
                          <Field
                            id={`statement-${row.id}`}
                            name="statement"
                            label="Closing balance on the statement (₦)"
                            inputMode="text"
                            autoComplete="off"
                            defaultValue={naira(row.statement)}
                          />
                          <TextareaField id={`explanation-${row.id}`} name="explanation" label="Explanation" defaultValue={row.explanation ?? ""} hint="Required if the statement differs from the books." />
                          <TextareaField id={`reason-${row.id}`} name="reason" label="Why is it corrected?" rows={2} />
                          <SubmitButton>Correct statement figure</SubmitButton>
                        </ActionForm>
                      </Disclosure>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
