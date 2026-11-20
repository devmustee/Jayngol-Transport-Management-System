"use client";

import { useState } from "react";
import { settleDepositAction } from "@/app/actions";
import { ActionForm, Field, FieldError, SelectField, SubmitButton } from "@/components/form";
import { formatNaira, parseNairaToKobo } from "@/lib/money";

type Kind = "daily_balance" | "penalty" | "loan" | "contribution";

const LINES: { kind: Kind; label: string; unit: [string, string] }[] = [
  { kind: "daily_balance", label: "Unpaid balances", unit: ["day", "days"] },
  { kind: "penalty", label: "Unpaid fines", unit: ["fine", "fines"] },
  { kind: "loan", label: "Loan left", unit: ["loan", "loans"] },
  { kind: "contribution", label: "Weekly contributions unpaid", unit: ["week", "weeks"] },
];

/**
 * Refunds what is saved: each debt has a tick box, ticked by default, then
 * any damage to the tricycle comes off, and the rest is given back. Damage
 * beyond what is left is owed as a fine. The figures follow what is typed.
 */
export function DepositSettleForm({
  operatorId,
  dueKobo,
  owed,
  sources,
}: {
  operatorId: string;
  dueKobo: number;
  owed: Record<Kind, { kobo: number; count: number }>;
  sources: { id: string; name: string; availableKobo: number }[];
}) {
  const [ticked, setTicked] = useState<Record<Kind, boolean>>({
    daily_balance: true,
    penalty: true,
    loan: true,
    contribution: true,
  });
  const [damage, setDamage] = useState("");
  const owedTicked = LINES.reduce((sum, line) => sum + (ticked[line.kind] ? owed[line.kind].kobo : 0), 0);
  const cleared = Math.min(dueKobo, owedTicked);
  const left = dueKobo - cleared;
  const damageKobo = damage.trim() === "" ? 0 : (parseNairaToKobo(damage) ?? 0);
  const kept = Math.min(damageKobo, left);
  const fine = damageKobo - kept;
  const given = left - kept;
  const stillOwed = owedTicked - cleared;

  return (
    <ActionForm action={settleDepositAction}>
      <input type="hidden" name="operatorId" value={operatorId} />
      <dl className="divide-y divide-line rounded-xl border border-line">
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
          <dt className="font-semibold">Saved</dt>
          <dd className="font-bold tabular-nums">{formatNaira(dueKobo)}</dd>
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
        {kept > 0 ? (
          <div className="flex items-center justify-between gap-3 bg-card-subtle px-3.5 py-3">
            <dt className="font-semibold">Deducted for damage</dt>
            <dd className="font-bold tabular-nums">{formatNaira(kept)}</dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 bg-gold-wash px-3.5 py-3">
          <dt className="font-semibold">To give back</dt>
          <dd className="font-bold tabular-nums">{formatNaira(given)}</dd>
        </div>
      </dl>
      {stillOwed > 0 ? (
        <p className="text-sm text-muted">
          The savings are smaller than what is ticked. The oldest debts are cleared first and {formatNaira(stillOwed)} stays owed.
        </p>
      ) : null}
      <FieldError name="clear" />

      <fieldset className="space-y-3 rounded-xl border border-line p-3.5">
        <legend className="px-1 text-sm font-semibold">Damage to the tricycle (optional)</legend>
        <Field
          name="damage"
          label="Amount (₦)"
          inputMode="decimal"
          autoComplete="off"
          value={damage}
          onChange={(event) => setDamage(event.target.value)}
          hint="Only if the operator damaged the tricycle."
        />
        {damageKobo > 0 ? (
          <>
            <Field name="damageWhat" label="What was damaged" autoComplete="off" placeholder="Broken windscreen" />
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" name="damageOnPurpose" className="size-5 shrink-0 accent-ink" />
              Done on purpose
            </label>
            {fine > 0 ? (
              <p className="rounded-xl border border-danger-border bg-danger-wash p-3 text-sm text-danger">
                {formatNaira(damageKobo)} damage: {formatNaira(kept)} from the savings, {formatNaira(fine)} owed as a fine.
              </p>
            ) : null}
          </>
        ) : null}
      </fieldset>

      {given > 0 ? (
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

      <p className="rounded-xl border border-gold/40 bg-gold-wash p-3 text-sm text-ink" aria-live="polite">
        {cleared > 0 ? `${formatNaira(cleared)} clears what is owed` : "Nothing is cleared"}
        {kept > 0 ? `, ${formatNaira(kept)} is deducted for damage` : ""}
        {fine > 0 ? `, ${formatNaira(fine)} is owed as a fine` : ""}
        {given > 0 ? `, ${formatNaira(given)} is given back` : ", nothing is given back"}. This can be undone today only.
      </p>
      <SubmitButton>Give back savings</SubmitButton>
    </ActionForm>
  );
}
