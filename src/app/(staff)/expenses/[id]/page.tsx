import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  addExpenseLineAction,
  cancelAdvanceAction,
  countersignAdvanceAction,
  sendBackAdvanceAction,
  submitAdvanceAction,
  voidExpenseLineAction,
} from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { PhotoInput } from "@/components/photo-input";
import { Badge, Card, Details, Disclosure, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import { ADVANCE_STATUS_LABELS, EXPENSE_CATEGORY_LABELS, formatDate, formatDateTime } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { getAdvance } from "@/services/expenses";

export const metadata: Metadata = { title: "Expense record" };

const TONE = { open: "gold", submitted: "gold", countersigned: "good", cancelled: "plain" } as const;

export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("finance.view");
  const { id } = await params;
  const data = isUuid(id) ? await getAdvance(ctx, id) : null;
  if (!data) notFound();
  const { advance, lines, leftKobo, accountedKobo, spentKobo } = data;
  const editable = data.canRecord && advance.status === "open";
  const today = businessDate(ctx.clock());

  return (
    <>
      <PageHeader
        title={advance.purpose}
        subtitle={formatNaira(advance.amountKobo)}
        back={{ href: "/expenses", label: "Expenses" }}
        action={<Badge tone={TONE[advance.status]}>{ADVANCE_STATUS_LABELS[advance.status]}</Badge>}
      />
      <div className="space-y-4">
        {advance.returnNote ? (
          <p role="alert" className="rounded-lg bg-danger-wash px-3 py-2 font-semibold text-danger">Sent back: {advance.returnNote}</p>
        ) : null}
        <Card title="Details">
          <Details
            rows={[
              ["Collected", formatDate(advance.collectedOn)],
              ["Collected by", data.collectedByName],
              ["Money came from", data.sourceName ? `Cash held by ${data.sourceName}` : data.sourceAccount === "owner" ? "Owner's own money" : "Bank"],
              ["Spent", formatNaira(spentKobo)],
              ["Still to account for", formatNaira(leftKobo)],
              ...(data.countersignedByName && advance.countersignedAt
                ? ([["Countersigned", `${data.countersignedByName}, ${formatDateTime(advance.countersignedAt)}`]] as [string, string][])
                : []),
              ...(advance.cancelReason ? ([["Why cancelled", advance.cancelReason]] as [string, string][]) : []),
            ]}
          />
        </Card>

        <Card title="How it was used">
          {lines.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {lines.map(({ line, voidReason }) => (
                <li key={line.id} className="py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className={`font-semibold ${voidReason ? "line-through" : ""}`}>{line.description}</div>
                      <div className="text-sm text-muted">
                        {line.category ? `${EXPENSE_CATEGORY_LABELS[line.category]} · ` : ""}
                        {formatDate(line.spentOn)}
                      </div>
                      {line.photoId ? (
                        <a href={`/api/photos/${line.photoId}`} className="text-sm text-gold-deep underline">View receipt</a>
                      ) : null}
                      {voidReason ? <div className="text-sm text-danger">Removed: {voidReason}</div> : null}
                    </div>
                    <span className={`shrink-0 font-semibold tabular-nums ${voidReason ? "line-through" : ""}`}>{formatNaira(line.amountKobo)}</span>
                  </div>
                  {editable && !voidReason ? (
                    <div className="mt-2">
                      <Disclosure label="Remove this entry">
                        <ActionForm action={voidExpenseLineAction.bind(null, line.id)}>
                          <TextareaField name="reason" label="Reason" />
                          <SubmitButton tone="plain">Remove entry</SubmitButton>
                        </ActionForm>
                      </Disclosure>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {editable && leftKobo > 0 ? (
          <>
            <Disclosure label="Add what was spent">
              <ActionForm action={addExpenseLineAction.bind(null, advance.id)}>
                <input type="hidden" name="kind" value="spent" />
                <SelectField name="category" label="Category" defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {Object.entries(EXPENSE_CATEGORY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </SelectField>
                <TextareaField name="description" label="What it was for" />
                <Field name="amount" label="Amount (₦)" inputMode="decimal" autoComplete="off" />
                <Field name="spentOn" label="Date" type="date" max={today} defaultValue={today} />
                <PhotoInput name="photo" label="Receipt photo (optional)" />
                <SubmitButton>Save</SubmitButton>
              </ActionForm>
            </Disclosure>
            <Disclosure label="Record change returned">
              <ActionForm action={addExpenseLineAction.bind(null, advance.id)}>
                <input type="hidden" name="kind" value="change" />
                <Field name="amount" label="Change returned (₦)" inputMode="decimal" autoComplete="off" hint={`It goes back to ${data.sourceName ?? "the bank"}.`} />
                <SubmitButton>Save</SubmitButton>
              </ActionForm>
            </Disclosure>
          </>
        ) : null}

        {editable && leftKobo === 0 ? (
          <ActionForm action={submitAdvanceAction.bind(null, advance.id)}>
            <SubmitButton>Send for countersign</SubmitButton>
          </ActionForm>
        ) : null}

        {data.canCountersign && advance.status === "submitted" ? (
          <>
            <ActionForm action={countersignAdvanceAction.bind(null, advance.id)}>
              <SubmitButton>Countersign</SubmitButton>
            </ActionForm>
            <Disclosure label="Send back to the Manager">
              <ActionForm action={sendBackAdvanceAction.bind(null, advance.id)}>
                <TextareaField name="reason" label="What needs correcting" />
                <SubmitButton tone="plain">Send back</SubmitButton>
              </ActionForm>
            </Disclosure>
          </>
        ) : null}

        {editable && accountedKobo === 0 ? (
          <Disclosure label="Cancel and put the money back">
            <ActionForm action={cancelAdvanceAction.bind(null, advance.id)}>
              <TextareaField name="reason" label="Reason" />
              <SubmitButton tone="plain">Cancel this record</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
