import type { Metadata } from "next";
import { createOperatorAction } from "@/app/actions";
import { OperatorForm } from "@/components/forms/operator-form";
import { Card, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { requirePage } from "@/lib/session";
import { listInStockTricycles } from "@/services/tricycles";
import { lastJobDate } from "@/services/daily-job";
import { helpForPage } from "@/guide";

export const metadata: Metadata = { title: "Add operator" };

export default async function NewOperatorPage() {
  const ctx = await requirePage("operator.manage");
  const [tricycles, jobDate] = await Promise.all([listInStockTricycles(ctx), lastJobDate()]);
  return (
    <>
      <PageHeader
        help={helpForPage(ctx.actor.role, "/operators/new")?.id} title="Add operator" back={{ href: "/operators", label: "Operators" }} />
      <Card>
        <OperatorForm action={createOperatorAction} assign={{ tricycles, today: businessDate(ctx.clock()), lastJobDate: jobDate }} />
      </Card>
    </>
  );
}
