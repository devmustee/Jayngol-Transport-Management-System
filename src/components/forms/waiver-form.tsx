"use client";

import { useState } from "react";
import { waiveBalancesAction } from "@/app/actions";
import { ActionForm, FieldError, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { formatDate } from "@/lib/format";
import { formatNaira, parseNairaToKobo } from "@/lib/money";
import { koboToInput } from "@/lib/payment-preview";

export type WaivableDay = {
  chargeId: string;
  date: string;
  outstandingKobo: number;
  tricycleCode: string | null;
  fineKobo: number;
};

const REASONS: [string, string][] = [
  ["breakdown", "Breakdown"],
  ["illness", "Illness"],
  ["bereavement", "Bereavement"],
  ["accident", "Accident"],
  ["police", "Police"],
  ["staff_mistake", "Staff mistake"],
  ["other", "Other"],
];

type Choice = { on: boolean; part: boolean; amount: string };

/**
 * The Manager ticks the days to forgive, whole or in part, then reviews the
 * total before saving. The server checks every amount again under a lock.
 */
export function WaiverForm({ operatorId, days, preselect }: { operatorId: string; days: WaivableDay[]; preselect?: string }) {
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      days.map((d) => [d.chargeId, { on: preselect === "all", part: false, amount: koboToInput(d.outstandingKobo) }]),
    ),
  );
  const [reviewing, setReviewing] = useState(false);
  const set = (id: string, change: Partial<Choice>) => {
    setReviewing(false);
    setChoices((all) => ({ ...all, [id]: { ...all[id]!, ...change } }));
  };

  const picked = days
    .filter((d) => choices[d.chargeId]!.on)
    .map((d) => {
      const c = choices[d.chargeId]!;
      const kobo = c.part ? parseNairaToKobo(c.amount) : d.outstandingKobo;
      return { day: d, kobo, bad: c.part && (kobo === null || kobo <= 0 || kobo > d.outstandingKobo) };
    });
  const total = picked.reduce((s, p) => s + (p.bad ? 0 : (p.kobo ?? 0)), 0);
  const invalid = picked.some((p) => p.bad);
  const fined = picked.filter((p) => p.day.fineKobo > 0);
  const allOn = days.length > 0 && days.every((d) => choices[d.chargeId]!.on);

  return (
    <ActionForm action={waiveBalancesAction.bind(null, operatorId)}>
      <fieldset>
        <div className="flex items-center justify-between gap-3">
          <legend className="text-sm font-medium">Days to waive</legend>
          <button
            type="button"
            className="min-h-11 text-sm font-semibold text-gold-deep underline underline-offset-2"
            onClick={() => {
              setReviewing(false);
              setChoices((all) => Object.fromEntries(Object.entries(all).map(([id, c]) => [id, { ...c, on: !allOn }])));
            }}
          >
            {allOn ? "Clear all" : "Tick all"}
          </button>
        </div>
        <ul className="mt-1 divide-y divide-line rounded-xl border border-line">
          {days.map((d) => {
            const c = choices[d.chargeId]!;
            return (
              <li key={d.chargeId} className="p-3">
                <label className="flex min-h-11 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    name="day"
                    value={d.chargeId}
                    checked={c.on}
                    onChange={(e) => set(d.chargeId, { on: e.target.checked })}
                    className="size-5 shrink-0 accent-[var(--color-gold-deep)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{formatDate(d.date)}</span>
                    <span className="block text-sm text-muted">
                      {d.tricycleCode ?? "No tricycle"}
                      {d.fineKobo > 0 ? ` · fined ${formatNaira(d.fineKobo)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{formatNaira(d.outstandingKobo)}</span>
                </label>
                {c.on ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
                    <input type="hidden" name={`mode_${d.chargeId}`} value={c.part ? "part" : "whole"} />
                    <div className="inline-flex rounded-lg border border-line bg-card p-0.5 text-sm">
                      {[false, true].map((part) => (
                        <button
                          key={String(part)}
                          type="button"
                          aria-pressed={c.part === part}
                          onClick={() => set(d.chargeId, { part })}
                          className="min-h-10 rounded-md px-3 aria-pressed:bg-ink aria-pressed:text-gold-light"
                        >
                          {part ? "Part" : "Whole day"}
                        </button>
                      ))}
                    </div>
                    {c.part ? (
                      <input
                        name={`amount_${d.chargeId}`}
                        aria-label={`Amount to waive for ${formatDate(d.date)} (₦)`}
                        inputMode="decimal"
                        autoComplete="off"
                        value={c.amount}
                        onChange={(e) => set(d.chargeId, { amount: e.target.value })}
                        className="min-h-10 w-32 rounded-lg border border-line bg-card px-3 text-base tabular-nums"
                      />
                    ) : null}
                    <div className="w-full">
                      <FieldError name={`amount_${d.chargeId}`} />
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </fieldset>

      <SelectField name="reason" label="Reason" defaultValue="">
        <option value="" disabled>
          Choose…
        </option>
        {REASONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>
      <TextareaField name="note" label="Note" hint="What happened. The Owner and the operator are told." />

      {fined.length > 0 ? (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line bg-card-subtle p-3 text-sm">
          <input type="checkbox" name="waiveFine" defaultChecked className="mt-0.5 size-5 shrink-0 accent-[var(--color-gold-deep)]" />
          <span>
            Also waive the late fine{fined.length === 1 ? "" : "s"} on {fined.length === 1 ? "this day" : "these days"} (
            {formatNaira(fined.reduce((s, p) => s + p.day.fineKobo, 0))})
          </span>
        </label>
      ) : null}

      {reviewing && total > 0 && !invalid ? (
        <div role="status" className="space-y-3 rounded-xl border border-gold/40 bg-gold-wash p-4 text-sm">
          <p className="font-semibold">
            Waive {formatNaira(total)} from {picked.length} day{picked.length === 1 ? "" : "s"}?
          </p>
          <ul className="space-y-0.5">
            {picked.map((p) => (
              <li key={p.day.chargeId} className="flex justify-between gap-3">
                <span>{formatDate(p.day.date)}</span>
                <span className="tabular-nums">{formatNaira(p.kobo ?? 0)}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted">This cannot be edited later, only reversed. The Owner is told.</p>
          <div className="flex flex-wrap gap-2">
            <SubmitButton>Waive {formatNaira(total)}</SubmitButton>
            <button
              type="button"
              onClick={() => setReviewing(false)}
              className="min-h-12 rounded-xl border border-line bg-card px-6 text-sm font-semibold"
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={total === 0 || invalid}
          onClick={() => setReviewing(true)}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-ink px-6 py-3 text-sm font-semibold text-paper hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {invalid ? "Check the amounts" : total > 0 ? `Review waiver of ${formatNaira(total)}` : "Tick a day to waive"}
        </button>
      )}
    </ActionForm>
  );
}
