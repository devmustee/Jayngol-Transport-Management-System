import type { Metadata } from "next";
import { approveAwardAction, rejectAwardAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { Card, Details, Disclosure, Empty, PageHeader } from "@/components/ui";
import { AWARD_LABELS, AWARD_PRIZES, formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { listAwards } from "@/services/awards";

export const metadata: Metadata = { title: "Awards" };

export default async function AwardsPage() {
  const ctx = await requirePage("finance.view");
  const { waiting, given, canApprove } = await listAwards(ctx);
  return (
    <>
      <PageHeader title="Awards" subtitle="Proposed on the 1st of each month" back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        {waiting.length === 0 ? <Empty>No awards are waiting for a decision.</Empty> : null}
        {waiting.map(({ candidate, operatorName, facts }) => (
          <Card key={candidate.id} title={`${operatorName}: ${AWARD_LABELS[candidate.type]}`}>
            <Details
              rows={[
                ["Prize", AWARD_PRIZES[candidate.type]],
                ["Period", `${formatDate(candidate.periodFrom)} to ${formatDate(candidate.periodTo)}`],
                ["First issued a tricycle", facts.firstIssuedOn ? formatDate(facts.firstIssuedOn) : null],
                ["Inspection coverage", `${facts.coveragePercent}% (${facts.inspectedDays} of ${facts.workingDays} days)`],
                ["Late balances in period", String(facts.lateBalances)],
                ["Offences in period", String(facts.offencesInPeriod)],
                ["Offences on record", String(facts.offencesEver)],
              ]}
            />
            {canApprove ? (
              <div className="mt-3 space-y-3">
                <ActionForm action={approveAwardAction.bind(null, candidate.id)}>
                  <Field name="given" label="What was given" defaultValue={AWARD_PRIZES[candidate.type]} autoComplete="off" />
                  <Field name="cost" label={candidate.type === "law_abiding" ? "Cash amount (₦)" : "Cost (₦)"} inputMode="decimal" autoComplete="off" />
                  <SubmitButton>Approve award</SubmitButton>
                </ActionForm>
                <Disclosure label="Reject this award">
                  <ActionForm action={rejectAwardAction.bind(null, candidate.id)}>
                    <TextareaField name="reason" label="Reason" />
                    <SubmitButton tone="plain">Reject</SubmitButton>
                  </ActionForm>
                </Disclosure>
              </div>
            ) : null}
          </Card>
        ))}
        <Card title="Awards given">
          {given.length === 0 ? (
            <Empty>No awards have been given yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {given.map((award) => (
                <li key={award.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="font-semibold">{award.operatorName}</div>
                    <div className="text-sm text-muted">{AWARD_LABELS[award.type]}: {award.given} · {formatDate(award.givenOn)}</div>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums">{formatNaira(award.costKobo)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
