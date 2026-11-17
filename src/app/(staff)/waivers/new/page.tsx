import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WaiverForm } from "@/components/forms/waiver-form";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { OPERATOR_STATUS_LABELS, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { waiverForm } from "@/services/waivers";

export const metadata: Metadata = { title: "Waive balance" };

export default async function NewWaiverPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const ctx = await requirePage("balance.waive");
  const params = await searchParams;
  const operatorId = queryValue(params.operator) ?? "";
  const data = isUuid(operatorId) ? await waiverForm(ctx, operatorId) : null;
  if (!data) notFound();
  const { operator, days } = data;
  const owed = days.reduce((s, d) => s + d.outstandingKobo, 0);

  return (
    <>
      <PageHeader
        title={`Waive balance: ${operator.name}`}
        subtitle={`${formatPhone(operator.phone)} · ${days.length} unpaid day${days.length === 1 ? "" : "s"}, ${formatNaira(owed)}`}
        back={{ href: "/arrears", label: "Unpaid balances" }}
        action={
          operator.status !== "active" ? (
            <Badge tone="bad">{OPERATOR_STATUS_LABELS[operator.status as keyof typeof OPERATOR_STATUS_LABELS] ?? operator.status}</Badge>
          ) : undefined
        }
      />
      {days.length === 0 ? (
        <Empty>{operator.name} has no unpaid daily balance to waive.</Empty>
      ) : (
        <Card subtitle="Waived money is forgiven, not paid. Money already paid on a day stays where it is.">
          <WaiverForm
            operatorId={operator.id}
            days={days.map((d) => ({
              chargeId: d.chargeId,
              date: d.date,
              outstandingKobo: d.outstandingKobo,
              tricycleCode: d.tricycleCode,
              fineKobo: d.fineKobo,
            }))}
            preselect={days.length === 1 ? "all" : undefined}
          />
        </Card>
      )}
    </>
  );
}
