import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  addExpenseLineAction,
  cancelAdvanceAction,
  correctExpenseAction,
  countersignAdvanceAction,
  removeExpenseAction,
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

export default async function ExpensePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recorded?: string }>;
}) {
  const ctx = await requirePage("finance.view");
  const { id } = await params;
  const recorded = (await searchParams).recorded === "1";
  const data = isUuid(id) ? await getAdvance(ctx, id) : null;
  if (!data) notFound();
  const { advance, lines, leftKobo, accountedKobo, spentKobo, correctable, oneStep } = data;
  /** A one-step expense shows as itself: its latest entry, with earlier versions below. */
  const latest = lines.find((row) => row.voidReason === null)?.line ?? lines.at(-1)?.line ?? null;
  const earlier = lines.filter((row) => row.line.id !== latest?.id);
  const editable = data.canRecord && advance.status === "open";
  /** An expense recorded in one step: corrected or removed whole, only while sent back. */
  const current = correctable ? lines.find((row) => row.voidReason === null)!.line : null;
  const advanceEditable = editable && !oneStep;
  const today = businessDate(ctx.clock());

  return (
    <>
      <PageHeader
        title={advance.purpose}
        subtitle={formatNaira(advance.amountKobo)}
        back={{ href: "/expenses", label: "Expenses" }}
        action={<Badge tone={TONE[advance.status]}>{oneStep && advance.status === "cancelled"
              ? "Removed"
              : data.noApprovalNeeded
                ? "No approval needed"
                : ADVANCE_STATUS_LABELS[advance.status]}</Badge>}
      />
      <div className="space-y-4">
        {recorded && advance.status !== "cancelled" ? (
          <p role="status" className="rounded-xl border border-ok-border bg-ok-wash px-4 py-3 text-sm font-medium text-ok">
            {data.noApprovalNeeded
              ? "Expense recorded. It needs no approval and is final from tomorrow."
              : "Expense recorded. It is waiting for the Manager's approval."}
          </p>
        ) : null}
        {advance.returnNote ? (
          <p role="alert" className="rounded-lg bg-danger-wash px-3 py-2 font-semibold text-danger">Sent back: {advance.returnNote}</p>
        ) : null}
        {oneStep && latest ? (
          <Card title="Details">
            <Details
              rows={[
                ["Amount", formatNaira(advance.amountKobo)],
                ["Category", latest.category ? EXPENSE_CATEGORY_LABELS[latest.category] : null],
                ["Date spent", formatDate(latest.spentOn)],
                ["Recorded by", data.collectedByName],
                ["Paid from", data.sourceName ? `Cash held by ${data.sourceName}` : data.sourceAccount === "owner" ? "Owner's own money" : "Company balance"],
                ...(data.countersignedByName && advance.countersignedAt
                  ? ([["Approved by", `${data.countersignedByName}, ${formatDateTime(advance.countersignedAt)}`]] as [string, string][])
                  : data.noApprovalNeeded
                    ? ([["Approval", "Not needed, recorded by the Manager"]] as [string, string][])
                    : advance.status === "submitted"
                      ? ([["Approval", "Waiting for the Manager"]] as [string, string][])
                      : []),
                ...(advance.cancelReason ? ([["Why removed", advance.cancelReason]] as [string, string][]) : []),
              ]}
            />
            {latest.photoId ? (
              <a href={`/api/photos/${latest.photoId}`} className="mt-2 inline-block text-sm text-gold-deep underline">View receipt</a>
            ) : null}
          </Card>
        ) : (
          <Card title="Details">
            <Details
              rows={[
                ["Collected", formatDate(advance.collectedOn)],
                ["Collected by", data.collectedByName],
                ["Money came from", data.sourceName ? `Cash held by ${data.sourceName}` : data.sourceAccount === "owner" ? "Owner's own money" : "Bank"],
                ["Spent", formatNaira(spentKobo)],
                ["Still to account for", formatNaira(leftKobo)],
                ...(data.countersignedByName && advance.countersignedAt
                  ? ([["Approved by", `${data.countersignedByName}, ${formatDateTime(advance.countersignedAt)}`]] as [string, string][])
                  : data.noApprovalNeeded
                    ? ([["Approval", "Not needed, recorded by the Manager"]] as [string, string][])
                    : []),
                ...(advance.cancelReason ? ([["Why cancelled", advance.cancelReason]] as [string, string][]) : []),
              ]}
            />
          </Card>
        )}

        {oneStep ? (
          earlier.length > 0 ? (
            <Card title="Earlier versions">
              <ul className="divide-y divide-line">
                {earlier.map(({ line, voidReason }) => (
                  <li key={line.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-semibold line-through">{line.description}</div>
                      <div className="text-muted">
                        {line.category ? `${EXPENSE_CATEGORY_LABELS[line.category]} · ` : ""}
                        {formatDate(line.spentOn)}
                        {voidReason ? ` · ${voidReason}` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 tabular-nums line-through">{formatNaira(line.amountKobo)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null
        ) : (
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
                    {advanceEditable && !voidReason ? (
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
        )}

        {advanceEditable && leftKobo > 0 ? (
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

        {advanceEditable && leftKobo === 0 ? (
          <ActionForm action={submitAdvanceAction.bind(null, advance.id)}>
            <SubmitButton>Send for countersign</SubmitButton>
          </ActionForm>
        ) : null}

        {current ? (
          <>
            <Card title={correctable === "same_day" ? "Correct a mistake today" : "Correct and send again"}>
              {correctable === "same_day" ? (
                <p className="mb-3 text-sm text-muted">You can correct or remove it until the end of today. From tomorrow it is final.</p>
              ) : null}
              <ActionForm action={correctExpenseAction.bind(null, advance.id)}>
                <TextareaField name="description" label="What it was for" defaultValue={current.description} />
                <SelectField name="category" label="Category" defaultValue={current.category ?? ""}>
                  {Object.entries(EXPENSE_CATEGORY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </SelectField>
                <Field
                  name="amount"
                  label="Amount (₦)"
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={String(current.amountKobo / 100)}
                  hint="Only the difference comes off or goes back to the balance."
                />
                <Field name="spentOn" label="Date spent" type="date" max={today} defaultValue={current.spentOn} />
                <SubmitButton>{correctable === "same_day" ? "Save correction" : "Correct and send for approval"}</SubmitButton>
              </ActionForm>
            </Card>
            <Disclosure label="Remove, it was entered by mistake">
              <ActionForm action={removeExpenseAction.bind(null, advance.id)}>
                <TextareaField name="reason" label="Reason" />
                <SubmitButton tone="plain">Remove and put the money back on the balance</SubmitButton>
              </ActionForm>
            </Disclosure>
          </>
        ) : null}

        {data.canCountersign && advance.status === "submitted" && advance.collectedBy !== ctx.actor.userId ? (
          <>
            <ActionForm action={countersignAdvanceAction.bind(null, advance.id)}>
              <SubmitButton>Approve</SubmitButton>
            </ActionForm>
            <p className="text-sm text-muted">Once approved, the expense is final.</p>
            <Disclosure label={`Send back to ${data.collectedByName ?? "the person who recorded it"}`}>
              <ActionForm action={sendBackAdvanceAction.bind(null, advance.id)}>
                <TextareaField name="reason" label="What needs correcting" />
                <SubmitButton tone="plain">Send back</SubmitButton>
              </ActionForm>
            </Disclosure>
          </>
        ) : null}

        {advanceEditable && accountedKobo === 0 ? (
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
