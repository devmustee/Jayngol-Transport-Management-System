"use client";

import { useState } from "react";
import { Field } from "@/components/form";
import { addDays } from "@/lib/clock";
import { formatShortDate } from "@/lib/format";

/**
 * The date a tricycle was issued. A past date owes the days the nightly job has
 * already done, so the field says which days will be added before saving.
 */
export function IssueDateField({
  today,
  lastJobDate,
  defaultValue = today,
  min,
  currentIssuedOn,
  hint = "Balances are owed from the day after this date.",
}: {
  today: string;
  lastJobDate: string | null;
  defaultValue?: string;
  min?: string;
  /** When changing an issue, days after this are already owed. */
  currentIssuedOn?: string;
  hint?: string;
}) {
  const [date, setDate] = useState(defaultValue);
  const first = /^\d{4}-\d{2}-\d{2}$/.test(date) ? addDays(date, 1) : null;
  const last = lastJobDate && currentIssuedOn && currentIssuedOn < lastJobDate ? currentIssuedOn : lastJobDate;
  const adds = first && last && first <= last && date <= today;
  return (
    <div>
      <Field
        name="issuedOn"
        label="Date issued"
        type="date"
        max={today}
        min={min}
        value={date}
        onChange={(event) => setDate(event.target.value)}
        hint={hint}
      />
      {adds ? (
        <p role="status" className="mt-1.5 text-sm font-medium text-warning">
          This also adds the daily balances already due for{" "}
          {first === last ? formatShortDate(first) : `${formatShortDate(first)} to ${formatShortDate(last)}`}.
        </p>
      ) : null}
    </div>
  );
}
