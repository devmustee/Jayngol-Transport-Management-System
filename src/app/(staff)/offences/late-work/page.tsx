import type { Metadata } from "next";
import { raiseLateWorkAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { PhotoInput } from "@/components/photo-input";
import { Card, PageHeader } from "@/components/ui";
import { requirePage } from "@/lib/session";
import { inspectionToday } from "@/services/inspections";

export const metadata: Metadata = { title: "Record late work" };

export default async function LateWorkPage() {
  const ctx = await requirePage("violation.raise");
  const { items } = await inspectionToday(ctx);
  return (
    <>
      <PageHeader
        title="Record late work"
        subtitle="Working after 10:00 pm, from the tracker"
        back={{ href: "/offences", label: "Offences" }}
      />
      <Card>
        <ActionForm action={raiseLateWorkAction}>
          <SelectField name="tricycleId" label="Tricycle">
            <option value="">Choose a tricycle</option>
            {items.map((item) => (
              <option key={item.tricycleId} value={item.tricycleId}>
                {item.code} · {item.operatorName}
              </option>
            ))}
          </SelectField>
          <Field name="trackerAt" label="Time on the tracker" type="datetime-local" />
          <PhotoInput name="photo" label="Tracker screenshot" />
          <TextareaField name="note" label="Note (optional)" />
          <SubmitButton>Record offence</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
