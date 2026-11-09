import type { Metadata } from "next";
import { reportFaultAction } from "@/app/actions";
import { ActionForm, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { Card, PageHeader } from "@/components/ui";
import { requirePage } from "@/lib/session";
import { listTricycles } from "@/services/tricycles";

export const metadata: Metadata = { title: "Take in for repair" };

export default async function NewRepairPage() {
  const ctx = await requirePage("workorder.manage");
  const all = await listTricycles(ctx);
  const choices = all.filter((t) => t.status === "issued" || t.status === "in_stock");
  return (
    <>
      <PageHeader
        title="Take in for repair"
        subtitle="The tricycle goes off the road until the repair is completed."
        back={{ href: "/workshop", label: "Workshop" }}
      />
      <Card>
        <ActionForm action={reportFaultAction}>
          <SelectField name="tricycleId" label="Tricycle" defaultValue="">
            <option value="" disabled>Choose…</option>
            {choices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.codeNumber}{t.operatorName ? ` · ${t.operatorName}` : " · In stock"}
              </option>
            ))}
          </SelectField>
          <TextareaField name="fault" label="What is wrong?" />
          <SubmitButton>Take off the road</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
