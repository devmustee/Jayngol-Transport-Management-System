"use client";

import { useState } from "react";
import { recordPaymentAction } from "@/app/actions";
import { ActionForm, Field, FieldError, SubmitButton, TextareaField } from "@/components/form";
import { CHOICE, METHODS } from "./money-choices";

export function PaymentForm({
  operatorId,
  clientId,
  today,
  hasTricycle,
  penaltiesOwed,
  loanOwed,
  canBackdate,
}: {
  operatorId: string;
  clientId: string;
  today: string;
  hasTricycle: boolean;
  penaltiesOwed: boolean;
  loanOwed: boolean;
  canBackdate: boolean;
}) {
  const [method, setMethod] = useState("");
  const askTricycle = hasTricycle && (method === "cash" || method === "pos");

  return (
    <ActionForm action={recordPaymentAction}>
      <input type="hidden" name="operatorId" value={operatorId} />
      <input type="hidden" name="clientId" value={clientId} />
      <Field name="amount" label="Amount received (₦)" inputMode="decimal" autoComplete="off" />
      <fieldset>
        <legend className="text-sm font-semibold">How was it paid?</legend>
        <div className="mt-1 flex gap-2">
          {METHODS.map((m) => (
            <label key={m.value} className={CHOICE}>
              <input
                type="radio"
                name="method"
                value={m.value}
                className="sr-only"
                onChange={() => setMethod(m.value)}
              />
              {m.label}
            </label>
          ))}
        </div>
        <FieldError name="method" />
      </fieldset>
      {method === "transfer" || method === "pos" ? (
        <Field
          name="reference"
          label={method === "pos" ? "POS reference" : "Transfer reference"}
          autoComplete="off"
          hint="Copy it exactly from the bank alert or POS slip. The same reference cannot be used twice."
        />
      ) : null}
      {askTricycle ? (
        <fieldset>
          <legend className="text-sm font-semibold">Did the operator bring the tricycle?</legend>
          <div className="mt-1 flex gap-2">
            <label className={CHOICE}>
              <input type="radio" name="tricyclePresent" value="yes" className="sr-only" />
              Yes
            </label>
            <label className={CHOICE}>
              <input type="radio" name="tricyclePresent" value="no" className="sr-only" />
              No
            </label>
          </div>
          <FieldError name="tricyclePresent" />
        </fieldset>
      ) : null}
      {penaltiesOwed ? (
        <Field
          name="penaltyAmount"
          label="Part of this for penalties (₦, optional)"
          inputMode="decimal"
          autoComplete="off"
          hint="Everything else goes to the oldest unpaid balance."
        />
      ) : null}
      {loanOwed ? (
        <Field
          name="loanAmount"
          label="Part of this for the loan (₦, optional)"
          inputMode="decimal"
          autoComplete="off"
          hint="Only what you enter here goes to the loan."
        />
      ) : null}
      {canBackdate ? (
        <details className="rounded-lg border border-line p-3">
          <summary className="font-semibold">Backdate this payment</summary>
          <div className="mt-3 space-y-3">
            <Field name="backdateTo" label="Date money was received" type="date" max={today} />
            <TextareaField name="backdateReason" label="Reason" />
          </div>
        </details>
      ) : null}
      <SubmitButton>Save and issue receipt</SubmitButton>
    </ActionForm>
  );
}
