"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { refundAllAction } from "@/app/actions";
import { ActionForm, FieldError, SelectField, SubmitButton } from "@/components/form";
import { formatNaira } from "@/lib/money";

export type RefundRow = {
  operatorId: string;
  name: string;
  heldKobo: number;
  owedKobo: number;
  /** A workshop job this month: worth checking for damage before refunding all. */
  workshop: boolean;
  /** Left or sacked but still holding the tricycle: refund on their own once it is back. */
  blocked: string | null;
};

/**
 * Month-end refunds in one step. Every ticked operator's debts are cleared
 * from their savings and the rest is given back from one source. Untick
 * anyone with damage, and refund them on their own page.
 */
export function RefundAllForm({
  rows,
  sources,
  label,
}: {
  rows: RefundRow[];
  sources: { id: string; name: string; availableKobo: number }[];
  label: string;
}) {
  const ready = rows.filter((row) => !row.blocked);
  const [on, setOn] = useState<Set<string>>(() => new Set(ready.filter((row) => !row.workshop).map((r) => r.operatorId)));
  const chosen = ready.filter((row) => on.has(row.operatorId));
  const held = chosen.reduce((s, row) => s + row.heldKobo, 0);
  const cleared = chosen.reduce((s, row) => s + Math.min(row.heldKobo, row.owedKobo), 0);
  const given = held - cleared;
  const [source, setSource] = useState("");
  const giver = sources.find((person) => person.id === source) ?? null;
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    const clear = () => setSource("");
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);
  const toggle = (id: string) => {
    const next = new Set(on);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOn(next);
  };

  return (
    <ActionForm action={refundAllAction}>
      <div ref={anchor} hidden />
      <ul className="divide-y divide-line rounded-xl border border-line">
        {rows.map((row) => {
          const clears = Math.min(row.heldKobo, row.owedKobo);
          return (
            <li key={row.operatorId} className="flex items-center justify-between gap-3 px-3.5 py-2">
              <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  name="operatorIds"
                  value={row.operatorId}
                  checked={on.has(row.operatorId)}
                  disabled={Boolean(row.blocked)}
                  onChange={() => toggle(row.operatorId)}
                  className="size-5 shrink-0 accent-ink"
                />
                <span className="min-w-0">
                  <Link href={`/operators/${row.operatorId}#deposit`} className="block font-semibold hover:text-gold-deep [overflow-wrap:anywhere]">
                    {row.name}
                  </Link>
                  <span className="block text-xs text-muted">
                    {row.blocked
                      ? row.blocked
                      : clears > 0
                        ? `${formatNaira(clears)} clears debts · ${formatNaira(row.heldKobo - clears)} back`
                        : `${formatNaira(row.heldKobo)} back`}
                  </span>
                  {row.workshop ? (
                    <span className="block text-xs font-semibold text-warning">Workshop job this month: check for damage</span>
                  ) : null}
                </span>
              </label>
              <span className="shrink-0 font-semibold tabular-nums">{formatNaira(row.heldKobo)}</span>
            </li>
          );
        })}
      </ul>
      <FieldError name="operatorIds" />
      <SelectField name="source" label="Given back from" value={source} onChange={(event) => setSource(event.target.value)}>
        <option value="" disabled>Choose…</option>
        {sources.map((person) => (
          <option key={person.id} value={person.id}>
            Cash held by {person.name} ({formatNaira(person.availableKobo)} today)
          </option>
        ))}
        <option value="bank">Bank transfer</option>
      </SelectField>
      <p className="rounded-xl border border-gold/40 bg-gold-wash p-3 text-sm text-ink" aria-live="polite">
        {chosen.length} operator{chosen.length === 1 ? "" : "s"} · {formatNaira(held)} saved · {formatNaira(cleared)} clears debts ·{" "}
        <span className="font-semibold">{formatNaira(given)} to give back</span>
      </p>
      {giver && given > 0 ? (
        giver.availableKobo >= given ? (
          <p className="text-sm text-muted" aria-live="polite">
            {giver.name}&apos;s cash will drop to {formatNaira(giver.availableKobo - given)}.
          </p>
        ) : (
          <p className="text-sm font-semibold text-danger" aria-live="polite">
            {giver.name} has only {formatNaira(Math.max(giver.availableKobo, 0))} free, {formatNaira(given - giver.availableKobo)} short.
            Untick some operators or choose another source.
          </p>
        )
      ) : null}
      <SubmitButton disabled={chosen.length === 0 || (giver !== null && given > 0 && giver.availableKobo < given)}>{label}</SubmitButton>
    </ActionForm>
  );
}
