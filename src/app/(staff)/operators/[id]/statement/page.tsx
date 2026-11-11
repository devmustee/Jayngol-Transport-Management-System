import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HandCoins, Wallet } from "lucide-react";
import { StatementView } from "@/components/statement";
import { LinkButton, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { getStatement } from "@/services/finance";
import { getOperator } from "@/services/operators";

export const metadata: Metadata = { title: "Statement" };

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("finance.view");
  const { id } = await params;
  const detail = isUuid(id) ? await getOperator(ctx, id) : null;
  if (!detail) notFound();
  const data = await getStatement(ctx, id);
  const canCollect = can(ctx.actor.role, "payment.record");
  const owesBalance = data.balanceOwedKobo > 0 || data.penaltiesOwedKobo > 0;
  return (
    <>
      <PageHeader
        title={detail.operator.name}
        subtitle="Statement"
        back={{ href: `/operators/${id}`, label: "Operator" }}
        action={
          canCollect ? (
            <>
              <LinkButton
                href={`/payments/new?operator=${id}${owesBalance ? "&for=balance" : ""}`}
                variant="gold"
              >
                <Wallet size={16} aria-hidden />
                Take payment
              </LinkButton>
              {data.loanOwedKobo > 0 ? (
                <LinkButton href={`/payments/new?operator=${id}&for=loan`} variant="secondary">
                  <HandCoins size={16} aria-hidden />
                  Take loan repayment
                </LinkButton>
              ) : null}
            </>
          ) : undefined
        }
      />
      <StatementView data={data} />
    </>
  );
}
