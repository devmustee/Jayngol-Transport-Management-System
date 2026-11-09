import type { Metadata } from "next";
import { InspectionToday } from "@/components/inspection-today";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { requirePage } from "@/lib/session";
import { inspectionToday } from "@/services/inspections";

export const metadata: Metadata = { title: "Inspect" };

export default async function InspectionsPage() {
  const ctx = await requirePage("inspection.record");
  const { date, items } = await inspectionToday(ctx);
  return (
    <>
      <PageHeader title="Inspect today" subtitle={formatDate(date)} />
      <InspectionToday date={date} items={items} userId={ctx.actor.userId} />
    </>
  );
}
