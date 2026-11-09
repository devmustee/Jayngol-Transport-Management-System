import type { Metadata } from "next";
import { createTricycleAction } from "@/app/actions";
import { TricycleForm } from "@/components/forms/tricycle-form";
import { Card, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { requirePage } from "@/lib/session";

export const metadata: Metadata = { title: "Add tricycle" };

export default async function NewTricyclePage() {
  const ctx = await requirePage("tricycle.manage");
  return (
    <>
      <PageHeader title="Add tricycle" back={{ href: "/tricycles", label: "Tricycles" }} />
      <Card>
        <TricycleForm action={createTricycleAction} today={businessDate(ctx.clock())} />
      </Card>
    </>
  );
}
