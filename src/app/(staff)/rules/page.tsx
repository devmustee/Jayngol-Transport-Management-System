import type { Metadata } from "next";
import { changeRuleAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton } from "@/components/form";
import { Card, Disclosure, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listRules } from "@/services/rules";

export const metadata: Metadata = { title: "Rules and fines" };

export default async function RulesPage() {
  const ctx = await requirePage("violation.view");
  const rules = await listRules(ctx);
  return (
    <>
      <PageHeader title="Rules and fines" />
      <div className="space-y-4">
        <Card>
          <ul className="divide-y divide-line">
            {rules.map((rule) => (
              <li key={rule.code} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <span>{rule.name}</span>
                  <span className="shrink-0 font-bold">{formatNaira(rule.amountKobo)}</span>
                </div>
                {rule.upcoming.map((change) => (
                  <div key={change.effectiveFrom} className="text-sm text-muted">
                    {formatNaira(change.amountKobo)} from {formatDate(change.effectiveFrom)}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </Card>
        {can(ctx.actor.role, "rule.manage") ? (
          <Disclosure label="Change a fine">
            <ActionForm action={changeRuleAction}>
              <SelectField name="code" label="Rule">
                {rules.map((rule) => (
                  <option key={rule.code} value={rule.code}>{rule.name}</option>
                ))}
              </SelectField>
              <Field name="amount" label="New fine (₦)" inputMode="numeric" />
              <Field name="effectiveFrom" label="Starts on" type="date" hint="Offences before this date keep the old amount." />
              <SubmitButton>Save new fine</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
