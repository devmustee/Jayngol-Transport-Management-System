"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { waiveFinesAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { Badge, LinkButton } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { formatPhone } from "@/lib/phone";

export type OwingOperator = {
  operatorId: string;
  name: string;
  phone: string;
  statusLabel: string | null;
  tricycle: { id: string; code: string; registration: string } | null;
  fines: number;
  owedKobo: number;
  oldest: string;
  items: {
    chargeId: string;
    offence: string;
    date: string;
    amountKobo: number;
    outstandingKobo: number;
    code: string | null;
    registration: string | null;
  }[];
};

const squash = (text: string | null | undefined) => (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (text: string | null | undefined) => (text ?? "").replace(/\D/g, "");

/** Name, phone, tricycle code or plate, or the offence, ignoring spaces, commas and case. */
function matches(o: OwingOperator, query: string) {
  const text = squash(query);
  if (!text) return true;
  const fields = [
    o.name,
    o.tricycle?.code,
    o.tricycle?.registration,
    ...o.items.flatMap((f) => [f.offence, f.code, f.registration]),
  ];
  if (fields.some((field) => squash(field).includes(text))) return true;
  const number = digits(query);
  if (number.length < 3) return false;
  const phone = digits(o.phone);
  const local = phone.startsWith("234") ? `0${phone.slice(3)}` : phone;
  return local.includes(number) || phone.includes(number);
}

const TICK = "size-5 shrink-0 cursor-pointer accent-ink";

export function FinesOwed({
  owing,
  canCollect,
  canWaive = false,
}: {
  owing: OwingOperator[];
  canCollect: boolean;
  /** The Manager can tick fines and waive them together. */
  canWaive?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const deferred = useDeferredValue(query);
  const shown = owing.filter((o) => matches(o, deferred));
  const total = shown.reduce((sum, o) => sum + o.owedKobo, 0);

  // Fines already waived drop off the list, so only ticks on fines still owed count.
  const all = owing.flatMap((o) => o.items);
  const chosen = all.filter((f) => ticked.has(f.chargeId));
  const chosenKobo = chosen.reduce((sum, f) => sum + f.outstandingKobo, 0);
  const chosenOperators = owing.filter((o) => o.items.some((f) => ticked.has(f.chargeId))).length;
  const shownIds = shown.flatMap((o) => o.items.map((f) => f.chargeId));
  const allShownTicked = shownIds.length > 0 && shownIds.every((id) => ticked.has(id));

  const setMany = (ids: string[], on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  return (
    <>
      {owing.length > 1 ? (
        <div className="mb-3" role="search">
          <div className="relative">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search operator, phone, tricycle, plate or offence"
              aria-label="Search fines owed"
              className="min-h-12 w-full rounded-xl border border-line bg-card px-3.5 py-2.5 pl-10 text-base text-ink placeholder:text-muted/60 transition-colors focus:border-gold"
            />
            <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          </div>
          <p className="mt-2 text-sm text-muted" aria-live="polite">
            {deferred.trim()
              ? shown.length === 0
                ? `Nobody owing fines matches "${deferred.trim()}".`
                : `${shown.length} of ${owing.length} operators match, owing ${formatNaira(total)}.`
              : `${owing.length} operators owe ${formatNaira(total)} in fines.`}
          </p>
        </div>
      ) : null}
      {canWaive && shownIds.length > 1 ? (
        <label className="mb-2 flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            className={TICK}
            checked={allShownTicked}
            onChange={(event) => setMany(shownIds, event.target.checked)}
          />
          <span>
            Tick every fine {deferred.trim() ? "shown" : "on this list"} ({shownIds.length}) to waive
          </span>
        </label>
      ) : null}
      <ul className="divide-y divide-line">
        {shown.map((o) => (
          <li key={o.operatorId} className="py-4 first:pt-1 last:pb-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/operators/${o.operatorId}`} className="font-semibold text-ink hover:underline">
                  {o.name}
                </Link>
                {o.statusLabel ? (
                  <span className="ml-2 align-middle">
                    <Badge tone="bad">{o.statusLabel}</Badge>
                  </span>
                ) : null}
                <div className="text-sm text-muted">
                  <a href={`tel:${o.phone}`} className="hover:text-ink hover:underline">
                    {formatPhone(o.phone)}
                  </a>
                  {" · "}
                  {o.tricycle ? (
                    <>
                      Rides{" "}
                      <Link href={`/tricycles/${o.tricycle.id}`} className="font-medium text-ink hover:underline">
                        {o.tricycle.code}
                      </Link>{" "}
                      ({o.tricycle.registration})
                    </>
                  ) : (
                    "No tricycle now"
                  )}
                </div>
                <div className="mt-1 text-sm">
                  <span className="font-semibold tabular-nums">{formatNaira(o.owedKobo)}</span>
                  <span className="text-muted">
                    {" "}for {o.fines} fine{o.fines === 1 ? "" : "s"}, oldest {formatDate(o.oldest)}
                  </span>
                </div>
              </div>
              {canCollect ? (
                <LinkButton href={`/payments/new?operator=${o.operatorId}&for=fines`} variant="secondary">
                  Pay fines
                </LinkButton>
              ) : null}
            </div>
            {canWaive && o.items.length > 1 ? (
              <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 text-sm text-muted">
                <input
                  type="checkbox"
                  className={TICK}
                  checked={o.items.every((f) => ticked.has(f.chargeId))}
                  onChange={(event) => setMany(o.items.map((f) => f.chargeId), event.target.checked)}
                />
                <span>Tick all {o.fines} of {o.name}&apos;s fines</span>
              </label>
            ) : null}
            <ul className="mt-3 divide-y divide-line rounded-xl bg-card-subtle text-sm">
              {o.items.map((f) => (
                <li key={f.chargeId} className="flex items-start justify-between gap-3 px-3 py-2">
                  {canWaive ? (
                    <input
                      type="checkbox"
                      aria-label={`Waive ${f.offence}, ${formatDate(f.date)}, ${formatNaira(f.outstandingKobo)}`}
                      className={`${TICK} mt-0.5`}
                      checked={ticked.has(f.chargeId)}
                      onChange={(event) => setMany([f.chargeId], event.target.checked)}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{f.offence}</div>
                    <div className="text-muted">
                      {formatDate(f.date)}
                      {f.code ? ` · ${f.code} (${f.registration})` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <div className="font-semibold">{formatNaira(f.outstandingKobo)}</div>
                    {f.outstandingKobo < f.amountKobo ? (
                      <div className="text-xs text-muted">of {formatNaira(f.amountKobo)}</div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {canWaive && chosen.length > 0 ? (
        <section
          aria-label="Waive ticked fines"
          className="sticky bottom-20 z-10 mt-4 rounded-2xl border border-line bg-card px-4 py-2 shadow-lg md:bottom-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <p className="py-1 text-sm font-semibold">
              {chosen.length} fine{chosen.length === 1 ? "" : "s"} ticked, {formatNaira(chosenKobo)}
              <span className="font-normal text-muted">
                {" "}· {chosenOperators} operator{chosenOperators === 1 ? "" : "s"}
              </span>
            </p>
            <button
              type="button"
              onClick={() => setTicked(new Set())}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-gold-deep underline underline-offset-2"
            >
              Untick all
            </button>
          </div>
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-center rounded-xl bg-ink px-4 text-sm font-semibold text-paper group-open:mb-3 [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">Waive {chosen.length} fine{chosen.length === 1 ? "" : "s"}…</span>
              <span className="hidden group-open:inline">Hide</span>
            </summary>
            <ActionForm action={waiveFinesAction} className="space-y-3 pb-2">
              {chosen.map((f) => (
                <input key={f.chargeId} type="hidden" name="chargeId" value={f.chargeId} />
              ))}
              <TextareaField name="waiveReason" label="Why they are waived" />
              <p className="text-sm text-muted">
                The fines stop being owed. Anything already paid towards them goes to the operator&apos;s daily balance.
              </p>
              <SubmitButton tone="plain">
                Waive {chosen.length} fine{chosen.length === 1 ? "" : "s"}
              </SubmitButton>
            </ActionForm>
          </details>
        </section>
      ) : null}
    </>
  );
}
