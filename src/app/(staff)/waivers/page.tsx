import type { Metadata } from "next";
import Link from "next/link";
import { reverseWaiverAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Disclosure, Empty, PageHeader, SearchBar } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, formatDateTime, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { monthStart, weekStart } from "@/lib/periods";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listWaivers, WAIVER_REASON_LABELS, type WaiverReason } from "@/services/waivers";

export const metadata: Metadata = { title: "Waivers" };

type Waiver = Awaited<ReturnType<typeof listWaivers>>[number];

const squash = (text: string | null | undefined) => (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (text: string | null | undefined) => (text ?? "").replace(/\D/g, "");

/** Operator, phone, tricycle, plate, reason or note, ignoring spaces, commas and case. */
function matches(w: Waiver, query: string) {
  const text = squash(query);
  if (!text) return true;
  const fields = [w.operatorName, w.tricycle?.code, w.tricycle?.registration, w.note, WAIVER_REASON_LABELS[w.reason], w.waivedBy];
  if ([...fields, ...w.lines.map((l) => l.code)].some((f) => squash(f).includes(text))) return true;
  const number = digits(query);
  if (number.length < 3) return false;
  const phone = digits(w.phone);
  return (phone.startsWith("234") ? `0${phone.slice(3)}` : phone).includes(number) || phone.includes(number);
}

const REASON_OPTIONS = Object.fromEntries(Object.entries(WAIVER_REASON_LABELS)) as Record<string, string>;

export default async function WaiversPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const ctx = await requirePage("finance.view");
  const params = await searchParams;
  const q = queryValue(params.q)?.trim().slice(0, 60) ?? "";
  const reasonParam = queryValue(params.status);
  const reason = reasonParam && reasonParam in WAIVER_REASON_LABELS ? (reasonParam as WaiverReason) : undefined;
  const show = queryValue(params.show);
  const day = queryValue(params.day);
  const canWaive = can(ctx.actor.role, "balance.waive");
  const today = businessDate(ctx.clock());

  const all = await listWaivers(ctx);
  const rows = all.filter(
    (w) =>
      matches(w, q) &&
      (!reason || w.reason === reason) &&
      (!show || w.id === show) &&
      (!day || w.fleetDay === day),
  );
  const live = all.filter((w) => !w.reversal);
  const sumFrom = (from: string) =>
    live.filter((w) => businessDate(w.waivedAt) >= from).reduce((s, w) => s + w.totalKobo, 0);

  return (
    <>
      <PageHeader
        title="Waivers"
        subtitle="Daily balances forgiven by the Manager"
        back={{ href: "/money", label: "Money" }}
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Tile label="This week" value={formatNaira(sumFrom(weekStart(today)))} />
          <Tile label="This month" value={formatNaira(sumFrom(monthStart(today)))} />
          <Tile label="Waivers in force" value={String(live.length)} />
        </div>

        {canWaive ? (
          <p className="text-sm text-muted">
            To waive an operator&apos;s days, use <span className="font-semibold text-ink">Waive</span> on{" "}
            <Link href="/arrears" className="font-semibold text-gold-deep underline underline-offset-2">
              Unpaid balances
            </Link>
            . To waive a past day for the whole fleet, use{" "}
            <Link href="/no-balance-days" className="font-semibold text-gold-deep underline underline-offset-2">
              No-balance days
            </Link>
            .
          </p>
        ) : null}

        <div>
          <SearchBar
            q={q}
            status={reason}
            placeholder="Search operator, phone, tricycle, plate or note"
            options={REASON_OPTIONS}
            allLabel="All reasons"
          />
          {q || reason || show || day ? (
            <p className="-mt-2 text-sm text-muted" aria-live="polite">
              {rows.length === 0 ? "No waiver matches." : `${rows.length} waiver${rows.length === 1 ? "" : "s"} shown.`}{" "}
              <Link href="/waivers" className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline underline-offset-2">
                Show all
              </Link>
            </p>
          ) : null}
        </div>

        {rows.length === 0 ? (
          <Empty>{all.length === 0 ? "No balance has been waived yet." : "No waiver matches."}</Empty>
        ) : (
          <div className="space-y-3">
            {rows.map((w) => (
              <WaiverCard key={w.id} w={w} canReverse={canWaive} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function WaiverCard({ w, canReverse }: { w: Waiver; canReverse: boolean }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/operators/${w.operatorId}`} className="font-bold leading-snug hover:text-gold-deep hover:underline">
            {w.operatorName}
          </Link>
          <div className="text-sm text-muted">
            <a href={`tel:${w.phone}`} className="hover:text-ink hover:underline">{formatPhone(w.phone)}</a>
            {" · "}
            {w.tricycle ? `${w.tricycle.code} (${w.tricycle.registration})` : "No tricycle now"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`font-bold tabular-nums ${w.reversal ? "text-muted line-through" : ""}`}>{formatNaira(w.totalKobo)}</div>
          {w.reversal ? <Badge tone="plain">Reversed</Badge> : <Badge tone="gold">{WAIVER_REASON_LABELS[w.reason]}</Badge>}
        </div>
      </div>
      <ul className="mt-3 divide-y divide-line border-t border-line text-sm">
        {w.lines.map((line) => (
          <li key={line.date + (line.code ?? "")} className="flex justify-between gap-3 py-1.5">
            <span>
              {formatDate(line.date)}
              {line.code ? <span className="text-muted"> · {line.code}</span> : null}
            </span>
            <span className="tabular-nums">{formatNaira(line.amountKobo)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-2 space-y-1 text-sm">
        <div>
          <dt className="inline text-muted">Note: </dt>
          <dd className="inline">{w.note}</dd>
        </div>
        <div className="text-muted">
          By {w.waivedBy}, {formatDateTime(w.waivedAt)}
          {w.fineWaived ? " · late fine waived too" : ""}
          {w.fleetDay ? ` · whole fleet, ${formatDate(w.fleetDay)}` : ""}
        </div>
        {w.reversal ? (
          <div className="text-muted">
            Reversed by {w.reversal.by}, {formatDateTime(w.reversal.at)}: {w.reversal.reason}
          </div>
        ) : null}
      </dl>
      {canReverse && !w.reversal ? (
        <div className="mt-3">
          <Disclosure label="Reverse this waiver">
            <ActionForm action={reverseWaiverAction.bind(null, w.id)}>
              <TextareaField
                name="reason"
                label="Reason"
                hint="The days become owed again. A late fine waived with it stays waived."
              />
              <SubmitButton tone="plain">Reverse waiver</SubmitButton>
            </ActionForm>
          </Disclosure>
        </div>
      ) : null}
    </Card>
  );
}
