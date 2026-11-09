import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { reversePaymentAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Disclosure, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { CHARGE_LABELS, formatDate, formatDateTime, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { getPayment, paymentReferenceOf } from "@/services/payments";

export const metadata: Metadata = { title: "Receipt" };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("finance.view");
  const { id } = await params;
  const data = isUuid(id) ? await getPayment(ctx, id) : null;
  if (!data) notFound();
  const { payment, operatorName, receivedByName, lines, creditKobo, reversalReason } = data;

  const reference = await paymentReferenceOf(payment.id);
  return (
    <>
      <PageHeader
        title={`Receipt ${payment.receiptNumber}`}
        back={{ href: "/payments", label: "Payments" }}
        action={reversalReason ? <Badge tone="bad">Reversed</Badge> : <Badge tone="good">Paid</Badge>}
      />
      <div className="space-y-4">
        <Card>
          <div className="mb-3 text-3xl font-bold tabular-nums">{formatNaira(payment.amountKobo)}</div>
          <Details
            rows={[
              ["Operator", <Link key="o" href={`/operators/${payment.operatorId}/statement`} className="text-gold-deep underline">{operatorName}</Link>],
              ["Received", formatDateTime(payment.receivedAt)],
              ["Method", METHOD_LABELS[payment.method]],
              ...(reference ? ([["Reference", reference.reference]] as [string, string][]) : []),
              ["Received by", receivedByName],
              ...(payment.tricyclePresent === null
                ? []
                : ([["Tricycle brought", payment.tricyclePresent ? "Yes" : "No"]] as [string, string][])),
              ...(payment.backdateReason ? ([["Backdated because", payment.backdateReason]] as [string, string][]) : []),
              ...(reversalReason ? ([["Reversed because", reversalReason]] as [string, string][]) : []),
            ]}
          />
        </Card>
        <Card title="Paid towards">
          <ul className="divide-y divide-line">
            {lines.map((line, index) => (
              <li key={index} className="flex justify-between gap-3 py-2">
                <span>{CHARGE_LABELS[line.type]} · {formatDate(line.businessDate)}</span>
                <span className="font-medium tabular-nums">{formatNaira(line.amountKobo)}</span>
              </li>
            ))}
            {creditKobo > 0 ? (
              <li className="flex justify-between gap-3 py-2">
                <span>Kept as advance for later days</span>
                <span className="font-medium tabular-nums">{formatNaira(creditKobo)}</span>
              </li>
            ) : null}
          </ul>
        </Card>
        {!reversalReason && can(ctx.actor.role, "payment.reverse") ? (
          <Disclosure label="Reverse this payment">
            <ActionForm action={reversePaymentAction.bind(null, payment.id)}>
              <TextareaField name="reason" label="Reason" hint="The receipt stays on record, marked as reversed." />
              <SubmitButton>Reverse payment</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
