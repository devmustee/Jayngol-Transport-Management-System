"use client";

import { useState } from "react";
import { recordPaymentAction } from "@/app/actions";
import { ActionForm, Field, FieldError, SubmitButton, TextareaField } from "@/components/form";
import { formatNaira, parseNairaToKobo } from "@/lib/money";
import { koboToInput } from "@/lib/payment-preview";
import { CHOICE, METHODS } from "./money-choices";

export type PaymentPurpose = "day" | "old" | "fine" | "loan";

const TOO_MUCH: Record<PaymentPurpose, string> = {
  day: "is left to pay for this day",
  old: "is owed for days before today",
  fine: "is owed in fines",
  loan: "is owed on the loan",
};

const UP_TO: Record<PaymentPurpose, string> = {
  day: "what is left for the day",
  old: "everything owed for earlier days, oldest day paid first",
  fine: "all fines owed, oldest first",
  loan: "what is left on the loan",
};

/**
 * Takes one kind of payment: one day's balance, older days, fines or the loan.
 * The amount starts at the most that can be taken and cannot go above it; the
 * server checks the same again.
 */
export function PaymentForm({
  purpose,
  operatorId,
  clientId,
  date,
  today,
  leftKobo,
  hasTricycle,
}: {
  purpose: PaymentPurpose;
  operatorId: string;
  clientId: string;
  /** The day paid for; earlier than today means entered late (Manager). */
  date: string;
  today: string;
  /** The most this payment can take. */
  leftKobo: number;
  hasTricycle: boolean;
}) {
  const [method, setMethod] = useState("");
  const [amount, setAmount] = useState(koboToInput(leftKobo));
  const amountKobo = amount.trim() === "" ? null : parseNairaToKobo(amount);
  const tooMuch = amountKobo !== null && amountKobo > leftKobo;
  const backdated = purpose === "day" && date !== today;
  // Only the daily balance is brought with the tricycle.
  const askTricycle = purpose === "day" && hasTricycle && (method === "cash" || method === "pos");

  return (
    <ActionForm action={recordPaymentAction}>
      <input type="hidden" name="operatorId" value={operatorId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="purpose" value={purpose} />
      {backdated ? <input type="hidden" name="backdateTo" value={date} /> : null}

      <Field
        name="amount"
        label="Amount received (₦)"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        hint={tooMuch ? undefined : `Up to ${formatNaira(leftKobo)}, ${UP_TO[purpose]}.`}
      />
      {tooMuch ? (
        <p role="alert" className="-mt-2 text-sm font-medium text-danger">
          Only {formatNaira(leftKobo)} {TOO_MUCH[purpose]}.
        </p>
      ) : null}

      <fieldset>
        <legend className="text-sm font-medium">How was it paid?</legend>
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

      {askTricycle ? (
        <fieldset>
          <legend className="text-sm font-medium">Did the operator bring the tricycle?</legend>
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

      {backdated ? <TextareaField name="backdateReason" label="Why is this entered late?" /> : null}

      <SubmitButton>
        {amountKobo && amountKobo > 0 && !tooMuch ? `Take ${formatNaira(amountKobo)}` : "Save and issue receipt"}
      </SubmitButton>
    </ActionForm>
  );
}
