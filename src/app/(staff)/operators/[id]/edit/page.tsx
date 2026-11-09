import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { updateOperatorAction } from "@/app/actions";
import { OperatorForm } from "@/components/forms/operator-form";
import { Card, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { requirePage } from "@/lib/session";
import { getOperator } from "@/services/operators";

export const metadata: Metadata = { title: "Edit operator" };

export default async function EditOperatorPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("operator.manage");
  const { id } = await params;
  const detail = isUuid(id) ? await getOperator(ctx, id) : null;
  if (!detail) notFound();
  return (
    <>
      <PageHeader title={`Edit ${detail.operator.name}`} back={{ href: `/operators/${id}`, label: "Back" }} />
      <Card>
        <OperatorForm
          action={updateOperatorAction.bind(null, id)}
          values={{
            ...detail.operator,
            phone: detail.operator.phone.replace(/^\+234/, "0"),
            guarantorPhone: detail.operator.guarantorPhone?.replace(/^\+234/, "0") ?? null,
          }}
        />
      </Card>
    </>
  );
}
