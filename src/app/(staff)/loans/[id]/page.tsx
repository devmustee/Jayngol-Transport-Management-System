import type { Metadata } from "next";
import Link from "next/link";
import { HandCoins } from "lucide-react";
import { notFound } from "next/navigation";
import { cancelLoanAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Disclosure, Empty, LinkButton, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { formatDate, LOAN_STATUS_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { getLoan } from "@/services/loans";

export const metadata: Metadata = { title: "Loan" };

const TONE = { active: "gold", cleared: "good", cancelled: "plain" } as const;

export default async function LoanPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("finance.view");
  const { id } = await params;
  const data = isUuid(id) ? await getLoan(ctx, id) : null;
  if (!data) notFound();
  const { loan, repayments, owedKobo } = data;
  return (
    <>
      <PageHeader
        title={loan.operatorName}
        subtitle={`Loan of ${formatNaira(loan.principalKobo)}`}
        back={{ href: "/loans", label: "Loans" }}
        action={<Badge tone={TONE[loan.status]}>{LOAN_STATUS_LABELS[loan.status]}</Badge>}
      />
      <div className="space-y-4">
        <Card title="Details">
          <Details
            rows={[
              ["Given on", formatDate(loan.disbursedOn)],
              ["Approved by", loan.approvedByName],
              ["Repaid", formatNaira(loan.repaidKobo)],
              ["Still owed", formatNaira(owedKobo)],
              ...(loan.note ? ([["Note", loan.note]] as [string, string][]) : []),
              ...(loan.cancelReason ? ([["Why cancelled", loan.cancelReason]] as [string, string][]) : []),
            ]}
          />
        </Card>
        {data.canCollect && loan.status === "active" ? (
          <LinkButton href={`/payments/new?operator=${loan.operatorId}&for=loan`} variant="gold">
            <HandCoins size={16} aria-hidden />
            Take loan repayment
          </LinkButton>
        ) : null}
        <Card title="Repayments">
          {repayments.length === 0 ? (
            <Empty>Nothing repaid yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {repayments.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <Link href={`/payments/${r.id}`} className="font-semibold text-gold-deep underline">{r.receipt_number}</Link>
                    <div className="text-sm text-muted">{formatDate(r.date)}</div>
                  </div>
                  <div className="text-right">
                    <div className={`font-semibold tabular-nums ${r.reversed ? "line-through" : ""}`}>{formatNaira(r.amount)}</div>
                    {r.reversed ? <Badge tone="bad">Reversed</Badge> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {data.canApprove && loan.status === "active" && loan.repaidKobo === 0 ? (
          <Disclosure label="Cancel this loan">
            <ActionForm action={cancelLoanAction.bind(null, loan.id)}>
              <TextareaField name="reason" label="Reason" hint="Use this only if the loan was entered by mistake." />
              <SubmitButton tone="plain">Cancel loan</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
