import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { reverseDepositAction } from "@/app/actions";
import { ReversePaymentForm } from "@/components/forms/reverse-payment-form";
import { ReceiptActions } from "@/components/receipt-actions";
import { Badge, Card, Details, Disclosure, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { formatDate, formatDateTime, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { moneySources } from "@/services/cash-book";
import { getDeposit } from "@/services/deposits";

export const metadata: Metadata = { title: "Savings receipt" };

export default async function DepositReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const ctx = await requirePage("finance.view");
  const { id } = await params;
  const data = isUuid(id) ? await getDeposit(ctx, id) : null;
  if (!data) notFound();
  const { deposit, operatorName, receivedByName, reversalReason, reference, confirmedAt, takenBackFrom } = data;
  const givenBack = data.settledOn !== null;

  // A saving already given back is undone from the refund, not reversed here.
  const canReverse = !reversalReason && !givenBack && can(ctx.actor.role, "payment.reverse");
  const sources = canReverse && deposit.method === "cash" ? await moneySources(ctx) : [];

  const shareLines = [
    `Jayngol savings receipt ${deposit.receiptNumber}`,
    `${formatNaira(deposit.amountKobo)} saved by ${operatorName}, ${formatDateTime(deposit.receivedAt)} (${METHOD_LABELS[deposit.method]})`,
    "Held for the operator and given back at the month end.",
    ...(givenBack ? [`Given back on ${formatDate(data.settledOn!)}.`] : []),
    ...(reversalReason ? ["This saving was reversed."] : []),
  ];

  return (
    <>
      <PageHeader
        title={`Savings ${deposit.receiptNumber}`}
        back={
          (await searchParams).from === "operator"
            ? { href: `/operators/${deposit.operatorId}`, label: operatorName }
            : { href: "/deposits", label: "Savings" }
        }
        action={
          reversalReason ? (
            <Badge tone="bad">Reversed</Badge>
          ) : givenBack ? (
            <Badge tone="plain">Given back</Badge>
          ) : (
            <Badge tone="good">Held</Badge>
          )
        }
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
              ...(data.reversedAt ? ([["Reversed", formatDateTime(data.reversedAt)]] as [string, string][]) : []),
              ...(takenBackFrom ? ([["Taken back from", takenBackFrom]] as [string, string][]) : []),
            ]}
          />
        </Card>
        {givenBack ? (
          <Card title={`Given back on ${formatDate(data.settledOn!)}`}>
            <Details
              rows={[
                ["Savings settled", formatNaira(data.settlementHeldKobo!)],
                ...(data.settlementClearedKobo! > 0
                  ? ([["Cleared debts", formatNaira(data.settlementClearedKobo!)]] as [string, string][])
                  : []),
                ...(data.settlementKeptKobo! > 0
                  ? ([["Kept for damage", formatNaira(data.settlementKeptKobo!)]] as [string, string][])
                  : []),
                ["Given back", formatNaira(data.settlementGivenBackKobo!)],
              ]}
            />
            <Link
              href={`/operators/${deposit.operatorId}#deposit`}
              className="mt-3 inline-block text-sm font-semibold text-gold-deep underline"
            >
              See the refund on {operatorName}&apos;s page
            </Link>
          </Card>
        ) : null}
        <ReceiptActions title={`Savings ${deposit.receiptNumber}`} text={shareLines.join("\n")} />
        {canReverse ? (
          <Disclosure label="Reverse this saving">
            <ReversePaymentForm
              action={reverseDepositAction.bind(null, deposit.id)}
              label="Reverse saving"
              amountKobo={deposit.amountKobo}
              cash={deposit.method === "cash"}
              collector={sources.find((person) => person.id === deposit.receivedBy) ?? null}
              sources={sources}
            />
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
