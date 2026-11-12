"use client";

import { useState } from "react";
import { Field, SelectField } from "@/components/form";
import { tricycleOptionLabel, type TricycleOption } from "@/lib/tricycle-option";

export type { TricycleOption };

/** The issue date appears only once a tricycle is chosen. The tricycle sets the daily balance. */
export function AssignTricycle({ tricycles, today }: { tricycles: TricycleOption[]; today: string }) {
  const [chosen, setChosen] = useState("");
  return (
    <>
      <h2 className="pt-2 font-bold">Tricycle (optional)</h2>
      {tricycles.length === 0 ? (
        <p className="text-muted">No tricycle is in stock right now. You can issue one later from this operator&apos;s page.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField name="tricycleId" label="Assign a tricycle" value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="">No tricycle yet</option>
            {tricycles.map((t) => (
              <option key={t.id} value={t.id} disabled={t.dailyBalanceKobo == null}>{tricycleOptionLabel(t)}</option>
            ))}
          </SelectField>
          {chosen ? (
            <>
              <Field name="issuedOn" label="Date issued" type="date" max={today} defaultValue={today} hint="The daily balance is the tricycle's own amount." />
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
