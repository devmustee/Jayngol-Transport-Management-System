import type { Metadata } from "next";
import { createStaffAction, resetStaffPasswordAction, setStaffStatusAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton } from "@/components/form";
import { Badge, Card, Disclosure, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listStaff } from "@/services/users";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffPage() {
  const ctx = await requirePage("user.manage");
  const staff = await listStaff(ctx);

  return (
    <>
      <PageHeader title="Staff logins" />
      <div className="space-y-4">
        <Disclosure label="Add staff login">
          <ActionForm action={createStaffAction}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="name" label="Full name" autoComplete="off" />
              <Field name="phone" label="Phone number" type="tel" autoComplete="off" />
              <SelectField name="role" label="Role" defaultValue="">
                <option value="" disabled>Choose…</option>
                <option value="manager">Manager</option>
                <option value="assistant_manager">Assistant Manager</option>
                <option value="supervisor">Supervisor</option>
                <option value="owner">Owner (read-only)</option>
              </SelectField>
              <Field name="password" label="First password" type="password" autoComplete="new-password" hint="At least 8 characters." />
            </div>
            <SubmitButton>Create login</SubmitButton>
          </ActionForm>
        </Disclosure>

        {staff.map((person) => {
          const isMe = person.id === ctx.actor.userId;
          const disabled = person.status === "disabled";
          return (
            <Card key={person.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold">{person.name}{isMe ? " (you)" : ""}</div>
                  <div className="text-sm text-muted">{ROLE_LABELS[person.role]} · {formatPhone(person.phone)}</div>
                  <div className="text-sm text-muted">
                    {person.lastLoginAt ? `Last login ${formatDateTime(person.lastLoginAt)}` : "Has not logged in"}
                  </div>
                </div>
                <Badge tone={disabled ? "bad" : "good"}>{disabled ? "Disabled" : "Active"}</Badge>
              </div>
              {isMe ? null : (
                <div className="mt-3 space-y-3">
                  <ActionForm action={setStaffStatusAction.bind(null, person.id, disabled ? "active" : "disabled")}>
                    <SubmitButton tone="plain">{disabled ? "Enable login" : "Disable login"}</SubmitButton>
                  </ActionForm>
                  <ActionForm action={resetStaffPasswordAction.bind(null, person.id)} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-[1_1_12rem]">
                      <Field name="password" label="Set a new password" type="password" autoComplete="new-password" />
                    </div>
                    <SubmitButton tone="plain">Reset</SubmitButton>
                  </ActionForm>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
