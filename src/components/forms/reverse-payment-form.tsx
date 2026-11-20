"use client";

import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextareaField } from "@/components/form";
import type { FormAction } from "@/lib/form-state";
import { formatNaira } from "@/lib/money";

type Source = { id: string; name: string; availableKobo: number };

/**
 * Reverses a payment or a saving. Cash comes back out of the cash of whoever took it,
 * unless that cash has moved on: then another source is chosen. The result
 * is shown before anything is saved.
 */
export function ReversePaymentForm({
  action,
  label = "Reverse payment",
  amountKobo,
  cash,
  collector,
  sources,
}: {
  /** The reversal, already bound to what is reversed. */
  action: FormAction;
  label?: string;
  amountKobo: number;
  cash: boolean;
  /** The person who took the payment, with the cash they hold free now; null when they can no longer hold cash. */
  collector: Source | null;
  sources: Source[];
}) {
  const others = sources.filter((person) => person.id !== collector?.id);
  const collectorCovers = collector !== null && collector.availableKobo >= amountKobo;
  const [source, setSource] = useState(collectorCovers ? "" : "choose");
  const picked =
    source === "" ? collector : (sources.find((person) => person.id === source) ?? null);

  return (
    <ActionForm action={action}>
      {cash ? (
        <>
          <SelectField
            name="source"
            label="Cash taken back from"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            {collector ? (
              <option value="">
                Cash held by {collector.name}, who took it ({formatNaira(Math.max(collector.availableKobo, 0))})
              </option>
            ) : null}
            {!collectorCovers ? (
              <option value="choose" disabled>
                Choose…
              </option>
            ) : null}
            {others.map((person) => (
              <option key={person.id} value={person.id}>
                Cash held by {person.name} ({formatNaira(Math.max(person.availableKobo, 0))})
              </option>
            ))}
            <option value="owner">Owner</option>
            <option value="bank">Bank</option>
          </SelectField>
          {!collectorCovers ? (
            <p className="rounded-xl border border-gold/40 bg-gold-wash p-3 text-sm text-ink">
              {collector
                ? `${collector.name} no longer holds ${formatNaira(amountKobo)} in cash, so it was handed on. Choose where it is now.`
                : "The person who took this cash can no longer hold cash. Choose where it is now."}
            </p>
          ) : null}
          {picked ? (
            <p
              className={`text-sm ${picked.availableKobo - amountKobo < 0 ? "font-semibold text-danger" : "text-muted"}`}
              aria-live="polite"
            >
              {picked.name}&apos;s cash will drop to {formatNaira(picked.availableKobo - amountKobo)}.
            </p>
          ) : null}
        </>
      ) : null}
      <TextareaField name="reason" label="Reason" hint="The receipt stays on record, marked as reversed." />
      <SubmitButton disabled={cash && source === "choose"}>{label}</SubmitButton>
    </ActionForm>
  );
}
