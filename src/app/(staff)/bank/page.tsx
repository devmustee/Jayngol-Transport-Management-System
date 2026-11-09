import type { Metadata } from "next";
import { confirmBankDepositAction, confirmBankPaymentAction, recordReconciliationAction, setOpeningBalanceAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Empty, PageHeader } from "@/components/ui";
import { formatDate, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { bankPosition } from "@/services/bank";

export const metadata: Metadata = { title: "Bank check" };

const signed = (kobo: number) => `${kobo < 0 ? "-" : ""}${formatNaira(Math.abs(kobo))}`;

export default async function BankPage() {
  const ctx = await requirePage("finance.view");
  const bank = await bankPosition(ctx);

  return (
    <>
      <PageHeader title="Bank check" subtitle="Match the books to the bank statement" back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        <Card title="Bank position">
          <Details
            rows={[
              ["Balance in the books", signed(bank.bookKobo)],
              ["Not yet confirmed against the bank", formatNaira(bank.unconfirmedKobo)],
            ]}
          />
          {bank.canSetOpening && !bank.hasOpening ? (
            <ActionForm action={setOpeningBalanceAction} className="mt-3 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field name="amount" label="Opening bank balance (₦)" inputMode="decimal" autoComplete="off" hint="Can be set once." />
                <Field name="date" label="As of date" type="date" max={bank.today} />
              </div>
              <SubmitButton>Save opening balance</SubmitButton>
            </ActionForm>
          ) : null}
        </Card>

        <Card title="Transfers and POS to confirm">
          {bank.toConfirm.length === 0 ? (
            <Empty>Everything has been confirmed.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {bank.toConfirm.map((item) => (
                <li key={item.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold">{item.operator}</div>
                      <div className="break-words text-sm text-muted">
                        {item.kind === "deposit" ? "Deposit · " : ""}{METHOD_LABELS[item.method as keyof typeof METHOD_LABELS]} · {item.reference} · {formatDate(item.date)}
                      </div>
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums">{formatNaira(item.amount)}</span>
                  </div>
                  {!bank.canReconcile ? null : item.received_by === bank.userId ? (
                    <p className="text-sm text-muted">You recorded this, so someone else must confirm it.</p>
                  ) : (
                    <ActionForm action={(item.kind === "deposit" ? confirmBankDepositAction : confirmBankPaymentAction).bind(null, item.id)}>
                      <SubmitButton tone="plain">Seen on the statement</SubmitButton>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {bank.canReconcile ? (
          <Card title="Reconcile a month">
            <ActionForm action={recordReconciliationAction}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field name="month" label="Month" type="month" defaultValue={bank.lastMonth} />
                <Field name="statement" label="Closing balance on the statement (₦)" inputMode="decimal" autoComplete="off" />
              </div>
              <TextareaField name="explanation" label="Explanation" hint="Required if the statement differs from the books, such as bank charges." />
              <SubmitButton>Save reconciliation</SubmitButton>
            </ActionForm>
          </Card>
        ) : null}

        <Card title="Past reconciliations">
          {bank.history.length === 0 ? (
            <Empty>No month has been reconciled yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {bank.history.map((row) => {
                const difference = row.statementKobo - row.bookKobo;
                return (
                  <li key={row.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{row.month.slice(0, 7)}</span>
                      <Badge tone={difference === 0 ? "good" : "bad"}>{difference === 0 ? "Matches" : `Difference ${signed(difference)}`}</Badge>
                    </div>
                    <div className="text-sm text-muted">Statement {signed(row.statementKobo)} · Books {signed(row.bookKobo)}</div>
                    {row.explanation ? <div className="text-sm">{row.explanation}</div> : null}
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
