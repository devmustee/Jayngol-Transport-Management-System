"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
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

export function FinesOwed({ owing, canCollect }: { owing: OwingOperator[]; canCollect: boolean }) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const shown = owing.filter((o) => matches(o, deferred));
  const total = shown.reduce((sum, o) => sum + o.owedKobo, 0);

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
            <ul className="mt-3 divide-y divide-line rounded-xl bg-card-subtle text-sm">
              {o.items.map((f) => (
                <li key={f.chargeId} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
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
    </>
  );
}
