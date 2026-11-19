"use client";

import { useState } from "react";
import { settleDepositAction } from "@/app/actions";
import { ActionForm, Field, FieldError, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { formatNaira, parseNairaToKobo } from "@/lib/money";

type Kind = "daily_balance" | "penalty" | "loan" | "contribution";

const LINES: { kind: Kind; label: string; unit: [string, string] }[] = [
  { kind: "daily_balance", label: "Unpaid balances", unit: ["day", "days"] },
  { kind: "penalty", label: "Unpaid fines", unit: ["fine", "fines"] },
  { kind: "loan", label: "Loan left", unit: ["loan", "loans"] },
  { kind: "contribution", label: "Weekly contributions unpaid", unit: ["week", "weeks"] },
];

/**
 * Settles what is held: each debt has a tick box, ticked by default, and the
 * figures follow the ticks. Whatever is not used or given back is kept, and
 * keeping needs a reason. The service clears oldest debts first.
 */
export function DepositSettleForm({
  operatorId,
  heldKobo,
  owed,
  sources,
}: {
  operatorId: string;
  heldKobo: number;
  owed: Record<Kind, { kobo: number; count: number }>;
  sources: { id: string; name: string; availableKobo: number }[];
}) {
  const [ticked, setTicked] = useState<Record<Kind, boolean>>({
    daily_balance: true,
    penalty: true,
    loan: true,
    contribution: true,
  });
  const [giveBack, setGiveBack] = useState("");
  const owedTicked = LINES.reduce((sum, line) => sum + (ticked[line.kind] ? owed[line.kind].kobo : 0), 0);
  const cleared = Math.min(heldKobo, owedTicked);
  const left = heldKobo - cleared;
  const typed = giveBack.trim() === "" ? left : parseNairaToKobo(giveBack);
  const given = typed === null ? null : Math.min(typed, left);
  const kept = given === null ? 0 : left - given;
  const stillOwed = owedTicked - cleared;

  return (
    <ActionForm action={settleDepositAction}>
      <input type="hidden" name="operatorId" value={operatorId} />
      <dl className="divide-y divide-line rounded-xl border border-line">
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
          <dt className="font-semibold">Deposit held</dt>
          <dd className="font-bold tabular-nums">{formatNaira(heldKobo)}</dd>
        </div>
        {LINES.map(({ kind, label, unit }) => {
          const line = owed[kind];
          if (line.kobo === 0) return null;
          return (
            <div key={kind} className="flex items-center justify-between gap-3 px-3.5 py-2">
              <dt className="min-w-0">
                <label className="flex min-h-11 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    name="clear"
                    value={kind}
                    checked={ticked[kind]}
                    onChange={(event) => setTicked({ ...ticked, [kind]: event.target.checked })}
                    className="size-5 shrink-0 accent-ink"
                  />
                  <span>
                    {label}{" "}
                    <span className="text-sm text-muted">
                      ({line.count} {line.count === 1 ? unit[0] : unit[1]})
                    </span>
                  </span>
                </label>
              </dt>
              <dd className={`shrink-0 tabular-nums ${ticked[kind] ? "" : "text-muted line-through"}`}>
                {formatNaira(line.kobo)}
              </dd>
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3 bg-card-subtle px-3.5 py-3">
          <dt className="font-semibold">Used to clear what is owed</dt>
          <dd className="font-bold tabular-nums">{formatNaira(cleared)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 bg-gold-wash px-3.5 py-3">
          <dt className="font-semibold">To give back</dt>
          <dd className="font-bold tabular-nums">{formatNaira(left)}</dd>
        </div>
      </dl>
      {stillOwed > 0 ? (
        <p className="text-sm text-muted">
          The deposit is smaller than what is ticked. The oldest debts are cleared first and {formatNaira(stillOwed)} stays owed.
        </p>
      ) : null}
      <FieldError name="clear" />

      {left > 0 ? (
        <>
          <Field
            name="giveBack"
            label="Amount given back (₦)"
            inputMode="decimal"
            autoComplete="off"
            placeholder={(left / 100).toLocaleString("en-NG")}
            hint={`Leave empty to give back all ${formatNaira(left)}.`}
            value={giveBack}
            onChange={(event) => setGiveBack(event.target.value)}
          />
          {given !== null && given > 0 ? (
            <>
              <SelectField name="source" label="Given back from" defaultValue="">
                <option value="" disabled>Choose…</option>
                {sources.map((person) => (
                  <option key={person.id} value={person.id}>
                    Cash held by {person.name} ({formatNaira(person.availableKobo)} today)
                  </option>
                ))}
                <option value="bank">Bank transfer</option>
              </SelectField>
              <Field name="reference" label="Transfer reference (optional)" autoComplete="off" />
            </>
          ) : null}
          {kept > 0 ? (
            <TextareaField
              name="keptReason"
              label={`Why ${formatNaira(kept)} is kept`}
              hint="For example: broken windscreen. It is recorded as Deposit kept."
              rows={2}
            />
          ) : null}
        </>
      ) : null}

      <p className="rounded-xl border border-gold/40 bg-gold-wash p-3 text-sm text-ink" aria-live="polite">
        {cleared > 0 ? `${formatNaira(cleared)} clears what is owed` : "Nothing is cleared"}
        {given ? `, ${formatNaira(given)} is given back` : ""}
        {kept > 0 ? `, ${formatNaira(kept)} is kept` : ""}. This can be undone today only.
      </p>
      <SubmitButton>Save settlement</SubmitButton>
    </ActionForm>
  );
}
