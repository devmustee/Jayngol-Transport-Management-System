"use client";

import { useMemo, useState } from "react";
import { recordPaymentAction } from "@/app/actions";
import { ActionForm, Field, FieldError, SubmitButton, TextareaField } from "@/components/form";
import { formatDate } from "@/lib/format";
import { formatNaira, parseNairaToKobo } from "@/lib/money";
import { koboToInput, previewPayment, type OpenBalance } from "@/lib/payment-preview";
import { CHOICE, METHODS } from "./money-choices";

export type PaymentMode = "balance" | "loan" | null;

type Owed = {
  balanceKobo: number;
  todayKobo: number;
  finesKobo: number;
  loanKobo: number;
};

/** Blank counts as nothing; anything that is not a valid amount counts as unknown. */
const kobo = (value: string) => (value.trim() === "" ? 0 : parseNairaToKobo(value));

function startingAmounts(mode: PaymentMode, owed: Owed) {
  if (mode === "loan" && owed.loanKobo > 0) {
    return { amount: koboToInput(owed.loanKobo), fines: "", loan: koboToInput(owed.loanKobo) };
  }
  if (mode === "balance" && owed.balanceKobo > 0) {
    return { amount: koboToInput(owed.balanceKobo), fines: "", loan: "" };
  }
  return { amount: "", fines: "", loan: "" };
}

export function PaymentForm({
  operatorId,
  clientId,
  today,
  hasTricycle,
  owed,
  balances,
  mode,
  canBackdate,
}: {
  operatorId: string;
  clientId: string;
  today: string;
  hasTricycle: boolean;
  owed: Owed;
  balances: OpenBalance[];
  mode: PaymentMode;
  canBackdate: boolean;
}) {
  const [method, setMethod] = useState("");
  const start = startingAmounts(mode, owed);
  const [amount, setAmount] = useState(start.amount);
  const [fines, setFines] = useState(start.fines);
  const [loan, setLoan] = useState(start.loan);
  const askTricycle = hasTricycle && (method === "cash" || method === "pos");

  const fill = (next: { amount: number; fines?: number; loan?: number }) => {
    setAmount(koboToInput(next.amount));
    setFines(next.fines ? koboToInput(next.fines) : "");
    setLoan(next.loan ? koboToInput(next.loan) : "");
  };

  // One tap fills the whole form, so what is shown is exactly what will be saved.
  const quick: { label: string; total: number; apply: () => void }[] = [];
  if (owed.balanceKobo > 0) {
    quick.push({ label: "All unpaid balances", total: owed.balanceKobo, apply: () => fill({ amount: owed.balanceKobo }) });
  }
  if (owed.todayKobo > 0 && owed.todayKobo !== owed.balanceKobo) {
    quick.push({ label: "Today's balance", total: owed.todayKobo, apply: () => fill({ amount: owed.todayKobo }) });
  }
  if (owed.finesKobo > 0) {
    quick.push({ label: "Fines", total: owed.finesKobo, apply: () => fill({ amount: owed.finesKobo, fines: owed.finesKobo }) });
  }
  if (owed.loanKobo > 0) {
    quick.push({ label: "Clear the loan", total: owed.loanKobo, apply: () => fill({ amount: owed.loanKobo, loan: owed.loanKobo }) });
  }
  const kinds = [owed.balanceKobo, owed.finesKobo, owed.loanKobo].filter((k) => k > 0).length;
  if (kinds > 1) {
    const all = owed.balanceKobo + owed.finesKobo + owed.loanKobo;
    quick.push({
      label: "Everything owed",
      total: all,
      apply: () => fill({ amount: all, fines: owed.finesKobo, loan: owed.loanKobo }),
    });
  }

  const amountKobo = kobo(amount);
  const finesKobo = kobo(fines);
  const loanKobo = kobo(loan);
  const preview = useMemo(
    () =>
      amountKobo && amountKobo > 0 && finesKobo !== null && loanKobo !== null
        ? previewPayment({
            amountKobo,
            finesPartKobo: finesKobo,
            loanPartKobo: loanKobo,
            balances,
            finesOwedKobo: owed.finesKobo,
            loanOwedKobo: owed.loanKobo,
          })
        : null,
    [amountKobo, finesKobo, loanKobo, balances, owed.finesKobo, owed.loanKobo],
  );

  return (
    <ActionForm action={recordPaymentAction}>
      <input type="hidden" name="operatorId" value={operatorId} />
      <input type="hidden" name="clientId" value={clientId} />

      {quick.length > 0 ? (
        <div>
          <div className="text-sm font-bold text-ink">Quick amount</div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={q.apply}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line-strong bg-card px-3 text-sm font-semibold text-ink transition-colors hover:border-gold-deep/50 hover:bg-gold-wash active:scale-[0.98]"
              >
                {q.label}
                <span className="font-bold tabular-nums text-gold-deep">{formatNaira(q.total)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <Field
        name="amount"
        label="Amount received (₦)"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />
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
      {owed.finesKobo > 0 ? (
        <Field
          name="penaltyAmount"
          label="Part of this for fines (₦, optional)"
          inputMode="decimal"
          autoComplete="off"
          hint={`Fines owed: ${formatNaira(owed.finesKobo)}.`}
          value={fines}
          onChange={(event) => setFines(event.target.value)}
        />
      ) : null}
      {owed.loanKobo > 0 ? (
        <Field
          name="loanAmount"
          label="Part of this for the loan (₦, optional)"
          inputMode="decimal"
          autoComplete="off"
          hint={`Loan owed: ${formatNaira(owed.loanKobo)}. Only what you enter here goes to the loan.`}
          value={loan}
          onChange={(event) => setLoan(event.target.value)}
        />
      ) : null}

      {preview ? <PreviewCard preview={preview} /> : null}

      {canBackdate ? (
        <details className="rounded-lg border border-line p-3">
          <summary className="-m-3 flex min-h-11 items-center p-3 font-semibold">Backdate this payment</summary>
          <div className="mt-3 space-y-3">
            <Field name="backdateTo" label="Date money was received" type="date" max={today} />
            <TextareaField name="backdateReason" label="Reason" />
          </div>
        </details>
      ) : null}
      <SubmitButton>{amountKobo && amountKobo > 0 ? `Take ${formatNaira(amountKobo)}` : "Save and issue receipt"}</SubmitButton>
    </ActionForm>
  );
}

const SHOWN_DAYS = 4;

function PreviewCard({ preview }: { preview: ReturnType<typeof previewPayment> }) {
  const shown = preview.days.slice(0, SHOWN_DAYS);
  const hidden = preview.days.slice(SHOWN_DAYS);
  return (
    <div aria-live="polite" className="rounded-xl border border-gold-light/60 bg-gold-wash/40 p-3.5 text-sm">
      <div className="font-bold text-ink">What this payment will clear</div>
      {preview.problems.length > 0 ? (
        <ul className="mt-2 space-y-1 font-semibold text-danger">
          {preview.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : (
        <ul className="mt-2 divide-y divide-line/70">
          {shown.map((day) => (
            <Line
              key={day.businessDate}
              label={day.cleared ? `Balance for ${formatDate(day.businessDate)}` : `Part of ${formatDate(day.businessDate)}`}
              value={day.appliedKobo}
            />
          ))}
          {hidden.length > 0 ? (
            <Line
              label={`${hidden.length} more day${hidden.length === 1 ? "" : "s"} up to ${formatDate(hidden[hidden.length - 1]!.businessDate)}`}
              value={hidden.reduce((sum, d) => sum + d.appliedKobo, 0)}
            />
          ) : null}
          {preview.finesKobo > 0 ? <Line label="Fines" value={preview.finesKobo} /> : null}
          {preview.loanKobo > 0 ? (
            <Line label={`Loan (${formatNaira(preview.loanLeftKobo)} left after this)`} value={preview.loanKobo} />
          ) : null}
          {preview.creditKobo > 0 ? (
            <Line label="Kept as credit for the next balance" value={preview.creditKobo} />
          ) : null}
        </ul>
      )}
      {preview.problems.length === 0 ? (
        <p className="mt-2 text-xs font-medium text-muted">
          {preview.balanceLeftKobo > 0
            ? `Unpaid balance still owed after this: ${formatNaira(preview.balanceLeftKobo)}`
            : "Every unpaid balance is cleared by this payment."}
        </p>
      ) : null}
    </div>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="min-w-0 text-ink-muted">{label}</span>
      <span className="shrink-0 font-bold tabular-nums text-ink">{formatNaira(value)}</span>
    </li>
  );
}
