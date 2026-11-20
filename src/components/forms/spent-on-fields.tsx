"use client";

import { useState } from "react";
import { Field, TextareaField } from "@/components/form";

/**
 * The day an expense was spent. A day more than a week back asks why it is
 * recorded late, since it then counts in a month already seen. The server
 * checks the same rule.
 */
export function SpentOnFields({
  today,
  freeFrom,
  defaultValue,
  defaultReason,
}: {
  today: string;
  /** The earliest day that needs no reason. */
  freeFrom: string;
  defaultValue: string;
  defaultReason?: string | null;
}) {
  const [spentOn, setSpentOn] = useState(defaultValue);
  const late = spentOn !== "" && spentOn < freeFrom;
  return (
    <>
      <Field
        name="spentOn"
        label="Date spent"
        type="date"
        max={today}
        value={spentOn}
        onChange={(event) => setSpentOn(event.target.value)}
      />
      {late ? (
        <TextareaField
          name="backdateReason"
          label="Why is it recorded late?"
          rows={2}
          defaultValue={defaultReason ?? ""}
          hint="It was spent more than a week ago, so it changes a month already seen. The owner is told."
        />
      ) : null}
    </>
  );
}
