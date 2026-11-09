import { ActionForm, Field, SelectField, SubmitButton } from "@/components/form";
import type { FormAction } from "@/lib/form-state";

export type TricycleDefaults = {
  registrationNumber: string;
  codeNumber: string;
  chassisNumber: string | null;
  engineNumber: string | null;
  purchasedOn: string;
  purchaseCostKobo: number | null;
  serviceInterval: "fortnightly" | "monthly";
  serviceCycleStart: string;
};

export function TricycleForm({
  action,
  today,
  values,
}: {
  action: FormAction;
  today: string;
  values?: TricycleDefaults;
}) {
  return (
    <ActionForm action={action}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="registrationNumber" label="Registration number" defaultValue={values?.registrationNumber} autoCapitalize="characters" />
        <Field name="codeNumber" label="Code number" defaultValue={values?.codeNumber} autoCapitalize="characters" />
        <Field name="purchasedOn" label="Date purchased" type="date" max={today} defaultValue={values?.purchasedOn} />
        <Field
          name="purchaseCost"
          label="Purchase cost in naira (optional)"
          inputMode="decimal"
          defaultValue={values?.purchaseCostKobo != null ? values.purchaseCostKobo / 100 : undefined}
        />
        <Field name="chassisNumber" label="Chassis number (optional)" defaultValue={values?.chassisNumber ?? undefined} autoCapitalize="characters" />
        <Field name="engineNumber" label="Engine number (optional)" defaultValue={values?.engineNumber ?? undefined} autoCapitalize="characters" />
        <SelectField name="serviceInterval" label="Service cycle" defaultValue={values?.serviceInterval ?? ""}>
          <option value="" disabled>Choose…</option>
          <option value="fortnightly">Every 2 weeks</option>
          <option value="monthly">Every month</option>
        </SelectField>
        <Field
          name="serviceCycleStart"
          label="Service cycle start"
          type="date"
          hint="Service days are counted from this date."
          defaultValue={values?.serviceCycleStart ?? today}
        />
      </div>
      <SubmitButton>{values ? "Save changes" : "Add tricycle"}</SubmitButton>
    </ActionForm>
  );
}
