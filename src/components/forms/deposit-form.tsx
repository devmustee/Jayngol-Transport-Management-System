"use client";

import { useState } from "react";
import { recordDepositAction } from "@/app/actions";
import { ActionForm, Field, FieldError, SubmitButton } from "@/components/form";
import { CHOICE, METHODS } from "./money-choices";

export function DepositForm({ operatorId, clientId }: { operatorId: string; clientId: string }) {
  const [method, setMethod] = useState("");
  return (
    <ActionForm action={recordDepositAction}>
      <input type="hidden" name="operatorId" value={operatorId} />
      <input type="hidden" name="clientId" value={clientId} />
      <Field name="amount" label="Deposit received (₦)" inputMode="decimal" autoComplete="off" />
      <fieldset>
        <legend className="text-sm font-semibold">How was it received?</legend>
        <div className="mt-1 flex gap-2">
          {METHODS.map((m) => (
            <label key={m.value} className={CHOICE}>
              <input type="radio" name="method" value={m.value} className="sr-only" onChange={() => setMethod(m.value)} />
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
      <SubmitButton>Save and issue receipt</SubmitButton>
    </ActionForm>
  );
}
