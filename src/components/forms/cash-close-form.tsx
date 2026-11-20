"use client";

import { useEffect, useRef, useState } from "react";
import { closeCashAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { formatNaira, parseNairaToKobo } from "@/lib/money";

/**
 * The count is always of the cash in hand now. For an earlier day, cash that
 * came in after it is taken off, and the sum is shown so nobody counts it
 * twice. Whether the count matches follows what is typed.
 */
export function CashCloseForm({
  custodianId,
  date,
  dateLabel,
  coverage,
  expectedKobo,
  laterKobo,
  label,
  takeOver,
  tour = false,
}: {
  custodianId: string;
  date: string;
  dateLabel: string;
  coverage: string;
  expectedKobo: number;
  laterKobo: number;
  label: string;
  /** Someone who has left: the counted cash moves into the Manager's cash. */
  takeOver: string | null;
  /** Carries the Cash close tour's markers: only the card the tour is about. */
  tour?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    const clear = () => setTyped("");
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  const inHand = typed.trim() === "" ? null : parseNairaToKobo(typed);
  const counted = inHand === null ? null : inHand - laterKobo;
  const difference = counted === null ? 0 : counted - expectedKobo;

  return (
    <ActionForm action={closeCashAction} className="mt-3 space-y-4">
      <div ref={anchor} hidden />
      <input type="hidden" name="custodianId" value={custodianId} />
      <input type="hidden" name="businessDate" value={date} />
      <div data-tour={tour ? "cash-count" : undefined}>
        <Field
          name="counted"
          label="Cash in hand now (₦)"
          inputMode="decimal"
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          hint={`Count all the cash you hold now. This count covers ${coverage}.`}
        />
      </div>
      {laterKobo !== 0 ? (
        <p className="rounded-xl border border-gold/40 bg-gold-wash p-3 text-sm text-ink" aria-live="polite">
          {formatNaira(Math.abs(laterKobo))} {laterKobo > 0 ? "came in" : "went out"} after {dateLabel}, so it is{" "}
          {laterKobo > 0 ? "taken off" : "added back"}.
          {inHand !== null && counted !== null ? (
            <>
              {" "}
              In hand {formatNaira(inHand)} {laterKobo > 0 ? "less" : "plus"} {formatNaira(Math.abs(laterKobo))} ={" "}
              <span className="font-semibold">{formatNaira(counted)} for {dateLabel}</span>.
            </>
          ) : null}
        </p>
      ) : null}
      {counted !== null ? (
        <p className={`text-sm font-semibold ${difference === 0 ? "text-ok" : "text-danger"}`} aria-live="polite">
          Expected {formatNaira(expectedKobo)}:{" "}
          {counted < 0
            ? "the cash in hand cannot be less than what came in after this day"
            : difference === 0
              ? "it matches"
              : `${difference < 0 ? "short" : "over"} by ${formatNaira(Math.abs(difference))}`}
        </p>
      ) : null}
      <TextareaField name="explanation" label="Explanation" hint="Required if the count does not match." />
      {takeOver ? <p className="text-sm text-muted">{takeOver}</p> : null}
      <div data-tour={tour ? "cash-close-button" : undefined}>
        <SubmitButton>{label}</SubmitButton>
      </div>
    </ActionForm>
  );
}
