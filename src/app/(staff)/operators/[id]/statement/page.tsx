import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatementView } from "@/components/statement";
import { PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
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
  return (
    <>
      <PageHeader title={detail.operator.name} subtitle="Statement" back={{ href: `/operators/${id}`, label: "Operator" }} />
      <StatementView data={data} />
    </>
  );
}
