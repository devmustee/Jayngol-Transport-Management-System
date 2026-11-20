"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Field, SelectField } from "@/components/form";
import { formatNaira, parseNairaToKobo } from "@/lib/money";

export type LoanChoice = {
  id: string;
  name: string;
  phone: string;
  tricycleCode: string | null;
  registration: string | null;
};

/** "Name · GRE-4012 · WKR-101VC", or "Name · No tricycle". */
export const choiceLabel = (o: LoanChoice) =>
  o.tricycleCode ? `${o.name} · ${o.tricycleCode} · ${o.registration ?? "No plate"}` : `${o.name} · No tricycle`;

const squash = (text: string | null) => (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (text: string) => text.replace(/\D/g, "");

function matches(o: LoanChoice, query: string) {
  const text = squash(query);
  if (!text) return true;
  if ([o.name, o.tricycleCode, o.registration].some((f) => squash(f).includes(text))) return true;
  const number = digits(query);
  if (number.length < 3) return false;
  const phone = digits(o.phone);
  return phone.includes(number) || (phone.startsWith("234") && `0${phone.slice(3)}`.includes(number));
}

/**
 * Who the loan is for and how much. The search narrows the list by name,
 * tricycle, plate or phone, and the line at the end repeats who it is for, so
 * a wrong pick among alike names is seen before saving.
 */
export function LoanOperatorPicker({
  choices,
  owingCount,
  asking = false,
  sources,
  children,
}: {
  /** Giving a loan: where the money comes from, with what it leaves. */
  sources?: { id: string; name: string; availableKobo: number }[];
  choices: LoanChoice[];
  owingCount: number;
  /** An Assistant Manager's request: the line reads "Ask the Manager for…". */
  asking?: boolean;
  /** The fields between the amount and the line that repeats who it is for. */
  children?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [chosenId, setChosenId] = useState("");
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState("");
  const giver = sources?.find((person) => person.id === source) ?? null;
  const shown = useMemo(() => {
    const found = choices.filter((o) => matches(o, query));
    // The one already chosen stays in the list, so a new search never drops it silently.
    const chosen = choices.find((o) => o.id === chosenId);
    return chosen && !found.includes(chosen) ? [chosen, ...found] : found;
  }, [choices, query, chosenId]);
  const chosen = choices.find((o) => o.id === chosenId);
  const kobo = parseNairaToKobo(amount);
  const left =
    owingCount === 0
      ? undefined
      : `${owingCount} operator${owingCount === 1 ? " is" : "s are"} not listed: they still owe on a loan or a request is waiting.`;

  return (
    <>
      <div className="relative">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, tricycle, plate or phone"
          aria-label="Search operators"
          autoComplete="off"
          className="min-h-12 w-full rounded-xl border border-line bg-card px-3.5 py-2.5 pl-10 text-base text-ink placeholder:text-muted/60 focus:border-gold"
        />
        <Search size={18} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
      </div>
      <SelectField
        name="operatorId"
        label={query ? `Operator (${shown.length} of ${choices.length})` : "Operator"}
        value={chosenId}
        onChange={(event) => setChosenId(event.target.value)}
        hint={left}
      >
        <option value="" disabled>
          {shown.length === 0 ? "No operator matches" : "Choose…"}
        </option>
        {shown.map((o) => (
          <option key={o.id} value={o.id}>
            {choiceLabel(o)}
          </option>
        ))}
      </SelectField>
      <Field
        name="amount"
        label="Amount (₦)"
        inputMode="decimal"
        autoComplete="off"
        hint="No interest or fee is added."
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />
      {sources ? (
        <>
          <SelectField
            name="source"
            label="Where the money came from"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="" disabled>
              Choose…
            </option>
            {sources.map((person) => (
              <option key={person.id} value={person.id}>
                Cash held by {person.name} ({formatNaira(Math.max(person.availableKobo, 0))} free)
              </option>
            ))}
            <option value="bank">Bank</option>
            <option value="owner">Owner&apos;s own money</option>
          </SelectField>
          {giver && kobo ? (
            giver.availableKobo >= kobo ? (
              <p className="text-sm text-muted" aria-live="polite">
                {giver.name}&apos;s cash will drop to {formatNaira(giver.availableKobo - kobo)}.
              </p>
            ) : (
              <p className="text-sm font-semibold text-danger" aria-live="polite">
                {giver.name} has only {formatNaira(Math.max(giver.availableKobo, 0))} free.
              </p>
            )
          ) : null}
        </>
      ) : null}
      {children}
      {chosen ? (
        <p className="rounded-xl border border-gold/40 bg-gold-wash p-3 text-sm text-ink" aria-live="polite">
          {asking ? "Ask the Manager for " : null}
          {kobo ? <span className="font-semibold">{formatNaira(kobo)}</span> : asking ? "a loan" : "A loan"}
          {asking ? " for " : " to "}
          <span className="font-semibold">{chosen.name}</span>
          {chosen.tricycleCode
            ? `, tricycle ${chosen.tricycleCode} (${chosen.registration ?? "no plate"}).`
            : ", who has no tricycle now."}
        </p>
      ) : null}
    </>
  );
}
