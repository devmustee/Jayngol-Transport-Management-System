import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { updateTricycleAction } from "@/app/actions";
import { TricycleForm } from "@/components/forms/tricycle-form";
import { Card, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import { requirePage } from "@/lib/session";
import { getTricycle } from "@/services/tricycles";

export const metadata: Metadata = { title: "Edit tricycle" };

export default async function EditTricyclePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("tricycle.manage");
  const { id } = await params;
  const detail = isUuid(id) ? await getTricycle(ctx, id) : null;
  if (!detail) notFound();
  return (
    <>
      <PageHeader title={`Edit ${detail.tricycle.codeNumber}`} back={{ href: `/tricycles/${id}`, label: "Back" }} />
      <Card>
        <TricycleForm
          action={updateTricycleAction.bind(null, id)}
          today={businessDate(ctx.clock())}
          values={detail.tricycle}
        />
      </Card>
    </>
  );
}
