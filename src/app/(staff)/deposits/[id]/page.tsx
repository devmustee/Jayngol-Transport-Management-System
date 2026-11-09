import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { reverseDepositAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Disclosure, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { formatDateTime, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { getDeposit } from "@/services/deposits";

export const metadata: Metadata = { title: "Deposit receipt" };

export default async function DepositReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("finance.view");
  const { id } = await params;
  const data = isUuid(id) ? await getDeposit(ctx, id) : null;
  if (!data) notFound();
  const { deposit, operatorName, receivedByName, reversalReason, reference, confirmedAt } = data;

  return (
    <>
      <PageHeader
        title={`Deposit ${deposit.receiptNumber}`}
        back={{ href: "/deposits", label: "Deposits" }}
        action={reversalReason ? <Badge tone="bad">Reversed</Badge> : <Badge tone="good">Held</Badge>}
      />
      <div className="space-y-4">
        <Card>
          <div className="mb-3 text-3xl font-bold tabular-nums">{formatNaira(deposit.amountKobo)}</div>
          <Details
            rows={[
              ["Operator", <Link key="o" href={`/operators/${deposit.operatorId}`} className="text-gold-deep underline">{operatorName}</Link>],
              ["Received", formatDateTime(deposit.receivedAt)],
              ["Method", METHOD_LABELS[deposit.method]],
              ...(reference ? ([["Reference", reference]] as [string, string][]) : []),
              ...(reference && !reversalReason ? ([["Seen on the statement", confirmedAt ? "Yes" : "Not yet"]] as [string, string][]) : []),
              ["Received by", receivedByName],
              ...(reversalReason ? ([["Reversed because", reversalReason]] as [string, string][]) : []),
            ]}
          />
        </Card>
        {!reversalReason && can(ctx.actor.role, "payment.reverse") ? (
          <Disclosure label="Reverse this deposit">
            <ActionForm action={reverseDepositAction.bind(null, deposit.id)}>
              <TextareaField name="reason" label="Reason" hint="The receipt stays on record, marked as reversed." />
              <SubmitButton>Reverse deposit</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
