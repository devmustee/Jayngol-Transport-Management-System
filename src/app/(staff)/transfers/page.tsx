import type { Metadata } from "next";
import { acceptTransferAction, createTransferAction, rejectTransferAction, voidTransferAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { PhotoInput } from "@/components/photo-input";
import { Badge, Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { moneySources } from "@/services/cash-book";
import { listTransfers } from "@/services/transfers";

export const metadata: Metadata = { title: "Move money" };

const STATUS = {
  done: { label: "Done", tone: "good" },
  rejected: { label: "Refused", tone: "plain" },
  voided: { label: "Reversed", tone: "bad" },
  pending: { label: "Waiting", tone: "gold" },
} as const;

export default async function TransfersPage() {
  const ctx = await requirePage("finance.view");
  const [{ pending, recent, userId, canMove, isManager }, people] = await Promise.all([
    listTransfers(ctx),
    moneySources(ctx),
  ]);
  const from = isManager ? people : people.filter((person) => person.id === userId);

  return (
    <>
      <PageHeader title="Move money" subtitle="Banking cash, staff handovers and cash handed to the Owner" back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        {pending.length > 0 ? (
          <Card title="Handovers waiting">
            <ul className="space-y-4">
              {pending.map((item) => (
                <li key={item.id} className="space-y-2">
                  <div className="font-semibold">{formatNaira(item.amountKobo)}</div>
                  <div className="text-sm text-muted">{item.fromLabel} to {item.toLabel}</div>
                  {item.note ? <div className="text-sm">{item.note}</div> : null}
                  {item.toCustodian === userId ? (
                    <ActionForm action={acceptTransferAction.bind(null, item.id)}>
                      <SubmitButton>I received this cash</SubmitButton>
                    </ActionForm>
                  ) : null}
                  {item.toCustodian === userId || item.createdBy === userId ? (
                    <Disclosure label={item.toCustodian === userId ? "Refuse" : "Withdraw"}>
                      <ActionForm action={rejectTransferAction.bind(null, item.id)}>
                        <TextareaField name="reason" label="Reason" />
                        <SubmitButton tone="plain">Confirm</SubmitButton>
                      </ActionForm>
                    </Disclosure>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {canMove ? (
          <Card title="Record a move">
            <ActionForm action={createTransferAction}>
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField name="from" label="From" defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {from.map((person) => (
                    <option key={person.id} value={person.id}>Cash held by {person.name} ({formatNaira(Math.max(person.availableKobo, 0))})</option>
                  ))}
                  {isManager ? <option value="bank">Bank</option> : null}
                  {isManager ? <option value="owner">Owner</option> : null}
                </SelectField>
                <SelectField name="to" label="To" defaultValue="">
                  <option value="" disabled>Choose…</option>
                  <option value="bank">Bank</option>
                  <option value="owner">Owner (cash handed over)</option>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>Cash held by {person.name}</option>
                  ))}
                </SelectField>
              </div>
              <Field name="amount" label="Amount (₦)" inputMode="decimal" autoComplete="off" />
              <Field name="reference" label="Teller, slip or transfer number" autoComplete="off" hint="Only for money paid into the bank. Leave empty for cash handed to the Owner." />
              <PhotoInput name="photo" label="Teller photo (required for bank deposits)" />
              <TextareaField name="note" label="Note (optional)" />
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
          </Card>
        ) : null}

        <Card title="Recent moves">
          {recent.length === 0 ? (
            <Empty>No money has been moved yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {recent.map((item) => (
                <li key={item.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-semibold tabular-nums">{formatNaira(item.amountKobo)}</span>
                    <Badge tone={STATUS[item.status].tone}>{STATUS[item.status].label}</Badge>
                  </div>
                  <div className="text-sm">{item.fromLabel} to {item.toLabel}</div>
                  <div className="text-sm text-muted">
                    {formatDateTime(item.createdAt)} · {item.createdByName}
                    {item.reference ? ` · ${item.reference}` : ""}
                  </div>
                  {item.note ? <div className="text-sm">{item.note}</div> : null}
                  {item.reason ? <div className="text-sm text-muted">Reason: {item.reason}</div> : null}
                  {item.photoId ? (
                    <a href={`/api/photos/${item.photoId}`} className="text-sm text-gold-deep underline">View teller</a>
                  ) : null}
                  {isManager && item.status === "done" ? (
                    <Disclosure label="Reverse this move">
                      <ActionForm action={voidTransferAction.bind(null, item.id)}>
                        <TextareaField name="reason" label="Reason" />
                        <SubmitButton tone="plain">Reverse</SubmitButton>
                      </ActionForm>
                    </Disclosure>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
