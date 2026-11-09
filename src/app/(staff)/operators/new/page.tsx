import type { Metadata } from "next";
import { createOperatorAction } from "@/app/actions";
import { OperatorForm } from "@/components/forms/operator-form";
import { Card, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { requirePage } from "@/lib/session";
import { listInStockTricycles } from "@/services/tricycles";

export const metadata: Metadata = { title: "Add operator" };

export default async function NewOperatorPage() {
  const ctx = await requirePage("operator.manage");
  const tricycles = await listInStockTricycles(ctx);
  return (
    <>
      <PageHeader title="Add operator" back={{ href: "/operators", label: "Operators" }} />
      <Card>
        <OperatorForm action={createOperatorAction} assign={{ tricycles, today: businessDate(ctx.clock()) }} />
      </Card>
    </>
  );
}
