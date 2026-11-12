"use client";

import { useState } from "react";
import { completeWorkOrderAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";

/**
 * Completes a job. A service with nothing taken from the store asks once
 * before it can be completed, since a service nearly always uses oil.
 */
export function CompleteForm({
  id,
  type,
  partsCount,
}: {
  id: string;
  type: "service" | "maintenance";
  partsCount: number;
}) {
  const ask = type === "service" && partsCount === 0;
  const [sure, setSure] = useState(false);
  const blocked = ask && !sure;

  return (
    <ActionForm action={completeWorkOrderAction.bind(null, id)}>
      <TextareaField name="findings" label="What was found and done" />
      <Field
        name="labourCost"
        label="Labour cost (₦)"
        inputMode="decimal"
        hint="Paid by the company. Never charged to the operator."
      />
      {ask ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-warning-border bg-warning-wash px-4 py-3 text-sm">
          <input
            type="checkbox"
            checked={sure}
            onChange={(event) => setSure(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-ink"
          />
          <span>
            <span className="block font-semibold text-ink">No items were taken from the store for this service.</span>
            <span className="block text-muted">Tick to complete it anyway, or take out the oil used first.</span>
          </span>
        </label>
      ) : null}
      <SubmitButton disabled={blocked}>
        {type === "maintenance" ? "Complete and return to road" : "Complete service"}
      </SubmitButton>
    </ActionForm>
  );
}
