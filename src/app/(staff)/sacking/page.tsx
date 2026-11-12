import type { Metadata } from "next";
import Link from "next/link";
import { clearSackingAction, confirmSackingAction, reinstateAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Disclosure, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { tricycleOptionLabel } from "@/lib/tricycle-option";
import { requirePage } from "@/lib/session";
import { listDismissals } from "@/services/dismissals";
import { listInStockTricycles } from "@/services/tricycles";

export const metadata: Metadata = { title: "Sacking alerts" };

export default async function SackingPage() {
  const ctx = await requirePage("finance.view");
  const rows = await listDismissals(ctx);
  const canDecide = can(ctx.actor.role, "dismissal.decide");
  const inStock = canDecide ? await listInStockTricycles(ctx) : [];
  const today = businessDate(ctx.clock());

  return (
    <>
      <PageHeader title="Sacking alerts and appeals" back={{ href: "/money", label: "Money" }} />
      {rows.length === 0 ? (
        <Empty>No operator is at 5 unpaid days.</Empty>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => {
            const settled = row.due.balancesKobo === 0 && row.due.finesKobo === 0;
            return (
              <Card key={row.id}>
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/operators/${row.operatorId}/statement`} className="inline-flex min-h-11 items-center font-bold text-gold-deep underline">
                    {row.operatorName}
                  </Link>
                  <Badge tone="bad">{row.status === "flagged" ? "Needs decision" : "Sacked"}</Badge>
                </div>
                <Details
                  rows={[
                    ["Alert raised", formatDate(row.flaggedOn)],
                    ...(row.confirmedOn ? ([["Sacked on", formatDate(row.confirmedOn)]] as [string, string][]) : []),
                    ["Unpaid balances", formatNaira(row.due.balancesKobo)],
                    ["Late-payment fines", formatNaira(row.due.finesKobo)],
                  ]}
                />
                {canDecide && row.status === "flagged" ? (
                  <div className="mt-3 space-y-3">
                    <ActionForm action={confirmSackingAction.bind(null, row.id)}>
                      <Field name="returnedOn" label="Date tricycle taken back" type="date" max={today} defaultValue={today} />
                      <SubmitButton>Confirm sacking</SubmitButton>
                    </ActionForm>
                    <Disclosure label="Give more time">
                      <ActionForm action={clearSackingAction.bind(null, row.id)}>
                        <TextareaField name="reason" label="Reason" />
                        <SubmitButton tone="plain">Close this alert</SubmitButton>
                      </ActionForm>
                    </Disclosure>
                  </div>
                ) : null}
                {canDecide && row.status === "confirmed" ? (
                  <div className="mt-3">
                    {settled ? (
                      <Disclosure label="Accept appeal and reinstate">
                        {inStock.length === 0 ? (
                          <p className="text-muted">No tricycle is in stock to issue.</p>
                        ) : (
                          <ActionForm action={reinstateAction.bind(null, row.id)}>
                            <SelectField name="tricycleId" label="Tricycle" defaultValue="">
                              <option value="" disabled>Choose…</option>
                              {inStock.map((t) => (
                                <option key={t.id} value={t.id} disabled={t.dailyBalanceKobo == null}>{tricycleOptionLabel(t)}</option>
                              ))}
                            </SelectField>
                            <Field name="issuedOn" label="Date issued" type="date" max={today} defaultValue={today} />
                            <SubmitButton>Reinstate operator</SubmitButton>
                          </ActionForm>
                        )}
                      </Disclosure>
                    ) : (
                      <p className="text-sm text-muted">
                        To appeal, the operator must first pay{" "}
                        {formatNaira(row.due.balancesKobo + row.due.finesKobo)}.
                      </p>
                    )}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
