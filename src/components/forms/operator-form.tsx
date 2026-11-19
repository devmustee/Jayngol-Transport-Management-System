import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import type { FormAction } from "@/lib/form-state";
import { AssignTricycle, type TricycleOption } from "./assign-tricycle";

export type OperatorDefaults = {
  name: string;
  phone: string;
  address: string | null;
  licenceNumber: string | null;
  guarantorName: string | null;
  guarantorPhone: string | null;
  guarantorAddress: string | null;
};

export function OperatorForm({
  action,
  values,
  assign,
  login,
}: {
  action: FormAction;
  values?: OperatorDefaults;
  /** On Edit, for a working operator: whether a portal login already exists. */
  login?: { exists: boolean };
  /** Offered only when adding someone new. */
  assign?: { tricycles: TricycleOption[]; today: string; lastJobDate?: string | null };
}) {
  return (
    <ActionForm action={action}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Full name" autoComplete="off" defaultValue={values?.name} />
        <Field name="phone" label="Phone number" type="tel" autoComplete="off" defaultValue={values?.phone} />
        <Field name="licenceNumber" label="Licence number (optional)" defaultValue={values?.licenceNumber ?? undefined} />
        <TextareaField name="address" label="Home address (optional)" defaultValue={values?.address ?? undefined} />
      </div>
      <h2 className="pt-2 font-bold">Guarantor (optional)</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="guarantorName" label="Guarantor name" autoComplete="off" defaultValue={values?.guarantorName ?? undefined} />
        <Field name="guarantorPhone" label="Guarantor phone" type="tel" autoComplete="off" defaultValue={values?.guarantorPhone ?? undefined} />
        <TextareaField name="guarantorAddress" label="Guarantor address" defaultValue={values?.guarantorAddress ?? undefined} />
      </div>
      {assign ? <AssignTricycle {...assign} /> : null}
      {values && !login ? null : (
        <>
          <h2 id="portal-login" className="scroll-mt-20 pt-2 font-bold">
            Portal login{login?.exists ? "" : " (optional)"}
          </h2>
          <Field
            name="pin"
            label={login?.exists ? "New PIN (optional)" : "6-digit PIN"}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            hint={
              login?.exists
                ? "Leave empty to keep the current PIN. A new PIN signs the operator out everywhere."
                : "The operator logs in with their phone number and this PIN. Leave empty to set it up later."
            }
          />
        </>
      )}
      <SubmitButton>{values ? "Save changes" : "Add operator"}</SubmitButton>
    </ActionForm>
  );
}
