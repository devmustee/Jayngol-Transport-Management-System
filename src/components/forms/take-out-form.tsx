"use client";

import { useState } from "react";
import { takeOutItemsAction } from "@/app/actions";
import { ActionForm, FieldError, SubmitButton } from "@/components/form";
import { formatNaira } from "@/lib/money";
import { formatStock, MILLI, parseQuantity } from "@/lib/quantity";

export type TakeOutJob = { id: string; code: string; detail: string };
export type TakeOutItem = {
  id: string;
  name: string;
  unit: string;
  wholeOnly: boolean;
  quantityMilli: number;
  valueKobo: number;
};

const QTY = "qty.";

/**
 * Takes several items out of the store to one tricycle in the workshop, in one
 * save. The summary shows what will go out; the server checks it all again.
 */
export function TakeOutForm({
  jobs,
  items,
  jobId,
  focusItemId,
  showCost,
  fixed = false,
}: {
  jobs: TakeOutJob[];
  items: TakeOutItem[];
  jobId?: string;
  focusItemId?: string;
  showCost: boolean;
  /** On a job's own page: the tricycle is already chosen. */
  fixed?: boolean;
}) {
  const [job, setJob] = useState(
    jobId ?? (jobs.length === 1 ? jobs[0]!.id : ""),
  );
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const lines = items.flatMap((item) => {
    const text = amounts[item.id]?.trim() ?? "";
    if (text === "") return [];
    const milli = parseQuantity(text);
    const problem =
      milli === null
        ? "Enter a number"
        : item.wholeOnly && milli % MILLI !== 0
          ? `Enter whole ${item.unit}s`
          : milli > item.quantityMilli
            ? `Only ${formatStock(item.quantityMilli, item.unit)} left`
            : null;
    if (milli === 0) return [];
    const costKobo =
      milli && !problem
        ? Math.round((item.valueKobo * milli) / item.quantityMilli)
        : 0;
    return [{ item, milli: milli ?? 0, problem, costKobo }];
  });
  const totalKobo = lines.reduce((sum, line) => sum + line.costKobo, 0);
  const ready =
    job !== "" && lines.length > 0 && lines.every((line) => !line.problem);
  const chosen = jobs.find((j) => j.id === job);

  return (
    <ActionForm action={takeOutItemsAction} className="space-y-6">
      {fixed ? (
        <input type="hidden" name="workOrderId" value={job} />
      ) : (
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">
            Tricycle in the workshop
          </legend>
          <div className="space-y-2">
            {jobs.map((j) => (
              <label
                key={j.id}
                className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-line bg-card px-4 py-2.5 has-checked:border-ink has-checked:ring-2 has-checked:ring-ink/10"
              >
                <input
                  type="radio"
                  name="workOrderId"
                  value={j.id}
                  checked={job === j.id}
                  onChange={() => setJob(j.id)}
                  className="size-4 accent-ink"
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">{j.code}</span>
                  <span className="block truncate text-sm text-muted">
                    {j.detail}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <FieldError name="workOrderId" />
        </fieldset>
      )}

      <fieldset>
        <legend
          className={fixed ? "sr-only" : "mb-2 text-sm font-medium text-ink"}
        >
          Items to take out
        </legend>
        <ul className="divide-y divide-line rounded-xl border border-line bg-card">
          {items.map((item) => {
            const line = lines.find((l) => l.item.id === item.id);
            const name = `${QTY}${item.id}`;
            return (
              <li key={item.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor={name} className="min-w-0">
                    <span className="block font-semibold text-ink">
                      {item.name}
                    </span>
                    <span className="block text-sm text-muted">
                      {formatStock(item.quantityMilli, item.unit)} left
                    </span>
                  </label>
                  <div className="flex shrink-0 items-center gap-2">
                    <input
                      id={name}
                      name={name}
                      inputMode="decimal"
                      placeholder="0"
                      autoFocus={item.id === focusItemId}
                      value={amounts[item.id] ?? ""}
                      onChange={(event) =>
                        setAmounts((prev) => ({
                          ...prev,
                          [item.id]: event.target.value,
                        }))
                      }
                      aria-invalid={line?.problem ? true : undefined}
                      className="block min-h-12 w-24 rounded-xl border border-line bg-card px-3 text-right text-base tabular-nums text-ink placeholder:text-muted/50 focus:border-gold focus:ring-2 focus:ring-gold/20 aria-invalid:border-danger"
                    />
                    <span className="w-12 text-sm text-muted">
                      {item.unit}s
                    </span>
                  </div>
                </div>
                {line?.problem ? (
                  <p className="mt-1 text-right text-xs font-semibold text-danger">
                    {line.problem}
                  </p>
                ) : null}
                <div className="text-right">
                  <FieldError name={name} />
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {lines.length > 0 ? (
        <section
          aria-label="What will go out"
          className="rounded-xl border border-line bg-card-subtle px-4 py-3"
        >
          <h2 className="text-sm font-medium text-muted">
            Going out{chosen ? ` to ${chosen.code}` : ""}
          </h2>
          <ul className="mt-1 text-sm">
            {lines.map((line) => (
              <li
                key={line.item.id}
                className="flex justify-between gap-3 py-1"
              >
                <span>
                  {line.item.name} ·{" "}
                  {line.problem
                    ? "check the quantity"
                    : formatStock(line.milli, line.item.unit)}
                </span>
                {showCost && !line.problem ? (
                  <span className="tabular-nums">
                    {formatNaira(line.costKobo)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {showCost ? (
            <div className="mt-1 flex justify-between gap-3 border-t border-line pt-2 text-sm font-semibold">
              <span>Total at store cost</span>
              <span className="tabular-nums">{formatNaira(totalKobo)}</span>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="space-y-2">
        <SubmitButton disabled={!ready}>
          {lines.length > 1
            ? `Take out ${lines.length} items`
            : "Take out item"}
        </SubmitButton>
        {!ready ? (
          <p className="text-sm text-muted">
            {job === ""
              ? "Choose the tricycle, then enter how much of each item."
              : lines.some((line) => line.problem)
                ? "Correct the quantity marked in red."
                : "Enter how much of each item to take out."}
          </p>
        ) : null}
      </div>
    </ActionForm>
  );
}
