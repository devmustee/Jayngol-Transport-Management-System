import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ReversePaymentForm } from "@/components/forms/reverse-payment-form";
import { ReceiptActions } from "@/components/receipt-actions";
import { Badge, Card, Details, Disclosure, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { CHARGE_LABELS, formatDate, formatDateTime, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { moneySources } from "@/services/cash-book";
import { getPayment, paymentReferenceOf } from "@/services/payments";

export const metadata: Metadata = { title: "Receipt" };

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const ctx = await requirePage("finance.view");
  const { id } = await params;
  const data = isUuid(id) ? await getPayment(ctx, id) : null;
  if (!data) notFound();
  const { payment, operatorName, receivedByName, lines, creditKobo, reversalReason, takenBackFrom } = data;

  const canReverse = !reversalReason && can(ctx.actor.role, "payment.reverse");
  const [reference, sources] = await Promise.all([
    paymentReferenceOf(payment.id),
    canReverse && payment.method === "cash" ? moneySources(ctx) : Promise.resolve([]),
  ]);
  const shareLines = [
    `Jayngol receipt ${payment.receiptNumber}`,
    `${formatNaira(payment.amountKobo)} from ${operatorName}, ${formatDateTime(payment.receivedAt)} (${METHOD_LABELS[payment.method]})`,
    ...lines.map(
      (line) =>
        `${CHARGE_LABELS[line.type]} ${line.type === "contribution" ? "Sunday " : ""}${formatDate(line.businessDate)}: ${formatNaira(line.amountKobo)}`,
    ),
    ...(creditKobo > 0 ? [`Kept for later: ${formatNaira(creditKobo)}`] : []),
    ...(reversalReason ? ["This payment was reversed."] : []),
  ];
  return (
    <>
      <PageHeader
        title={`Receipt ${payment.receiptNumber}`}
        back={
          (await searchParams).from === "operator"
            ? { href: `/operators/${payment.operatorId}`, label: operatorName }
            : { href: "/payments", label: "Payments" }
        }
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
              ...(takenBackFrom ? ([["Taken back from", takenBackFrom]] as [string, string][]) : []),
            ]}
          />
        </Card>
        <Card title="Paid towards">
          <ul className="divide-y divide-line">
            {lines.map((line, index) => (
              <li key={index} className="flex justify-between gap-3 py-2">
                <span>
                  {CHARGE_LABELS[line.type]} · {line.type === "contribution" ? "Sunday " : ""}
                  {formatDate(line.businessDate)}
                </span>
                <span className="font-medium tabular-nums">{formatNaira(line.amountKobo)}</span>
              </li>
            ))}
            {creditKobo > 0 ? (
              <li className="flex justify-between gap-3 py-2">
                <span>{payment.purpose === "contribution" ? "Paid ahead for later Sundays" : "Kept as advance for later days"}</span>
                <span className="font-medium tabular-nums">{formatNaira(creditKobo)}</span>
              </li>
            ) : null}
          </ul>
        </Card>
        <ReceiptActions title={`Receipt ${payment.receiptNumber}`} text={shareLines.join("\n")} />
        {canReverse ? (
          <Disclosure label="Reverse this payment">
            <ReversePaymentForm
              paymentId={payment.id}
              amountKobo={payment.amountKobo}
              cash={payment.method === "cash"}
              collector={sources.find((person) => person.id === payment.receivedBy) ?? null}
              sources={sources}
            />
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
