import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, HandCoins } from "lucide-react";
import { setContributionRateAction, waiveContributionAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Disclosure, Empty, PageHeader, SearchBar } from "@/components/ui";
import { addDays } from "@/lib/clock";
import { formatDate, OPERATOR_STATUS_LABELS, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listContributions, weekEnding } from "@/services/contributions";

export const metadata: Metadata = { title: "Contributions" };

type Data = Awaited<ReturnType<typeof listContributions>>;
type Row = Data["operators"][number];

const squash = (text: string | null | undefined) => (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (text: string | null | undefined) => (text ?? "").replace(/\D/g, "");

/** Name, phone, tricycle code or plate, ignoring spaces, dashes and case. */
function matches(row: Row, query: string) {
  const text = squash(query);
  if (!text) return true;
  if ([row.name, row.tricycle?.code, row.tricycle?.registration].some((f) => squash(f).includes(text))) return true;
  const number = digits(query);
  if (number.length < 3) return false;
  const phone = digits(row.phone);
  return (phone.startsWith("234") ? `0${phone.slice(3)}` : phone).includes(number) || phone.includes(number);
}

const WEEK_STATUS = {
  paid: { tone: "good", label: "Paid" },
  part: { tone: "warning", label: "Part paid" },
  unpaid: { tone: "bad", label: "Not paid" },
  waiting: { tone: "plain", label: "Not charged" },
  due: { tone: "gold", label: "Due Sunday" },
  ahead: { tone: "good", label: "Paid ahead" },
} as const;

const SHOW = { unpaid: "Not paid this week", owing: "Owing", paid: "Paid this week" } as const;

/** The first Sunday after today, for starting contributions. */
const nextSundayAfter = (today: string) => {
  const end = weekEnding(today);
  return end === today ? addDays(today, 7) : end;
};

export default async function ContributionsPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const ctx = await requirePage("finance.view");
  const params = await searchParams;
  const q = queryValue(params.q)?.trim().slice(0, 60) ?? "";
  const showParam = queryValue(params.show);
  const show = showParam && showParam in SHOW ? (showParam as keyof typeof SHOW) : undefined;
  const data = await listContributions(ctx, queryValue(params.week));
  const canCollect = can(ctx.actor.role, "payment.record");
  const canManage = can(ctx.actor.role, "contribution.manage");

  const rows = data.operators
    .filter((row) => matches(row, q))
    .filter((row) =>
      show === "unpaid"
        ? row.weekStatus === "unpaid" || row.weekStatus === "part"
        : show === "owing"
          ? row.owedKobo > 0
          : show === "paid"
            ? row.weekStatus === "paid"
            : true,
    )
    .sort((a, b) => b.owedKobo - a.owedKobo || a.name.localeCompare(b.name));

  const href = (next: { week?: string; q?: string; show?: string }) => {
    const p = new URLSearchParams();
    if (next.q) p.set("q", next.q);
    if (next.show) p.set("show", next.show);
    if (next.week) p.set("week", next.week);
    const text = p.toString();
    return text ? `/contributions?${text}` : "/contributions";
  };
  const previousWeek = addDays(data.week, -7);
  const nextWeek = addDays(data.week, 7);
  const canGoBack = !!data.startsOn && previousWeek >= data.startsOn;
  const canGoForward = nextWeek <= data.lastAllowed;

  return (
    <>
      <PageHeader
        title="Contributions"
        subtitle={
          data.started && data.rateKobo !== null
            ? `${formatNaira(data.rateKobo)} every Sunday, company income`
            : "Weekly contributions, paid every Sunday"
        }
        back={{ href: "/money", label: "Money" }}
      />
      <div className="space-y-4">
        {!data.started ? (
          canManage ? (
            <Card title="Start weekly contributions" subtitle="Weeks before the start Sunday are never charged.">
              <ActionForm action={setContributionRateAction}>
                <Field name="effectiveFrom" label="First Sunday" type="date" defaultValue={nextSundayAfter(data.today)} />
                <Field name="amount" label="Weekly amount (₦)" inputMode="decimal" autoComplete="off" defaultValue="500" />
                <SubmitButton>Start contributions</SubmitButton>
              </ActionForm>
            </Card>
          ) : (
            <Empty>Weekly contributions have not started yet. The Manager sets the start Sunday.</Empty>
          )
        ) : (
          <>
            {data.startsOn! > data.today ? (
              <p className="rounded-xl border border-line bg-card p-4 text-sm">
                Contributions start on <span className="font-semibold">Sunday {formatDate(data.startsOn!)}</span>. Operators can pay
                ahead from now, up to 4 weeks.
              </p>
            ) : null}

            <nav className="flex items-center justify-between gap-2" aria-label="Week">
              {canGoBack ? (
                <Link
                  href={href({ week: previousWeek, q, show })}
                  className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-line bg-card px-3 text-sm font-medium hover:bg-card-subtle"
                >
                  <ChevronLeft size={16} aria-hidden /> Earlier
                </Link>
              ) : (
                <span />
              )}
              <div className="text-center">
                <div className="text-xs text-muted">Week ending</div>
                <div className="font-semibold">Sunday {formatDate(data.week)}</div>
              </div>
              {canGoForward ? (
                <Link
                  href={href({ week: nextWeek, q, show })}
                  className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-line bg-card px-3 text-sm font-medium hover:bg-card-subtle"
                >
                  Later <ChevronRight size={16} aria-hidden />
                </Link>
              ) : (
                <span />
              )}
            </nav>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {data.week > data.today ? (
                <>
                  <Tile label="Due this Sunday" value={String(data.operators.filter((o) => o.weekStatus === "due").length)} sub="operators still to pay" />
                  <Tile label="Paid ahead" value={String(data.operators.filter((o) => o.weekStatus === "ahead").length)} sub="covered already" />
                </>
              ) : (
                <>
                  <Tile label="Collected this week" value={formatNaira(data.collectedKobo)} sub={`of ${formatNaira(data.expectedKobo)}`} />
                  <Tile label="Paid" value={String(data.paidCount)} sub={`${data.unpaidCount} not paid`} />
                </>
              )}
              <Tile label="Owed, all weeks" value={formatNaira(data.owedKobo)} sub={`${data.owingCount} operator${data.owingCount === 1 ? "" : "s"}`} />
              <Tile label="Amount" value={data.rateKobo === null ? "—" : formatNaira(data.rateKobo)} sub="per week" />
            </div>

            <div>
              <SearchBar q={q} placeholder="Search operator, phone, tricycle or plate" keep={{ week: queryValue(params.week), show }} />
              <nav className="-mt-2 mb-1 flex flex-wrap gap-2" aria-label="Filter">
                {[["", "All"], ...Object.entries(SHOW)].map(([value, label]) => (
                  <Link
                    key={value}
                    href={href({ week: queryValue(params.week), q, show: value || undefined })}
                    aria-current={(show ?? "") === value ? "page" : undefined}
                    className="inline-flex min-h-11 items-center rounded-full border border-line bg-card px-4 text-sm font-medium aria-[current=page]:bg-ink aria-[current=page]:text-gold-light"
                  >
                    {label}
                  </Link>
                ))}
              </nav>
              {q ? (
                <p className="mt-2 text-sm text-muted" aria-live="polite">
                  {rows.length === 0 ? `No operator matches "${q}".` : `${rows.length} operator${rows.length === 1 ? "" : "s"} match "${q}".`}{" "}
                  <Link
                    href={href({ week: queryValue(params.week), show })}
                    className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline underline-offset-2"
                  >
                    Clear search
                  </Link>
                </p>
              ) : null}
            </div>

            <Card title={`Operators (${rows.length})`} subtitle="Most owed first">
              {rows.length === 0 ? (
                <Empty>{q || show ? "No operator matches." : "No operator pays contributions yet."}</Empty>
              ) : (
                <ul className="divide-y divide-line">
                  {rows.map((row) => (
                    <OperatorRow key={row.operatorId} row={row} canCollect={canCollect} canManage={canManage} />
                  ))}
                </ul>
              )}
            </Card>

            {canManage ? (
              <Disclosure label="Change the weekly amount">
                <p className="mb-3 text-sm text-muted">
                  A new amount applies from a later Sunday. Weeks already charged keep their amount.
                </p>
                <ActionForm action={setContributionRateAction}>
                  <Field name="effectiveFrom" label="From Sunday" type="date" defaultValue={nextSundayAfter(data.today)} />
                  <Field name="amount" label="Weekly amount (₦)" inputMode="decimal" autoComplete="off" />
                  <SubmitButton>Save new amount</SubmitButton>
                </ActionForm>
                <ul className="mt-4 divide-y divide-line border-t border-line text-sm">
                  {data.rates.map((rate) => (
                    <li key={rate.effective_from} className="flex justify-between gap-3 py-2">
                      <span>From Sunday {formatDate(rate.effective_from)}</span>
                      <span className="tabular-nums">{formatNaira(rate.amount)}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}

function OperatorRow({ row, canCollect, canManage }: { row: Row; canCollect: boolean; canManage: boolean }) {
  const status = WEEK_STATUS[row.weekStatus];
  const waivable = row.unpaid.filter((w) => w.paid === 0);
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/operators/${row.operatorId}`} className="font-bold leading-snug hover:text-gold-deep hover:underline">
              {row.name}
            </Link>
            <Badge tone={status.tone}>{status.label}</Badge>
            {row.status !== "active" ? (
              <Badge tone="plain">
                {OPERATOR_STATUS_LABELS[row.status as keyof typeof OPERATOR_STATUS_LABELS] ?? row.status}
              </Badge>
            ) : null}
          </div>
          <div className="text-sm text-muted">
            <a href={`tel:${row.phone}`} className="hover:text-ink hover:underline">{formatPhone(row.phone)}</a>
            {" · "}
            {row.tricycle ? `${row.tricycle.code} (${row.tricycle.registration})` : "No tricycle now"}
          </div>
          <div className="text-sm text-muted">
            {row.owedKobo > 0
              ? `Owes ${formatNaira(row.owedKobo)} for ${row.weeksOwed} week${row.weeksOwed === 1 ? "" : "s"}, since Sunday ${formatDate(row.oldestWeek!)}`
              : row.creditKobo > 0
                ? `Paid ahead: ${formatNaira(row.creditKobo)}`
                : "Up to date"}
            {" · "}
            {formatNaira(row.totalPaidKobo)} contributed
          </div>
        </div>
        {canCollect ? (
          <Link
            href={`/payments/new?operator=${row.operatorId}&for=contribution`}
            aria-label={`Take contribution from ${row.name}`}
            className="inline-flex min-h-11 items-center justify-center gap-2 self-end rounded-xl bg-gold px-4 text-sm font-bold text-ink shadow-gold-sm transition-all hover:brightness-105 active:scale-[0.98] sm:self-center"
          >
            <HandCoins size={16} aria-hidden />
            Take contribution
          </Link>
        ) : null}
      </div>
      {canManage && waivable.length > 0 ? (
        <div className="mt-2">
          <Disclosure label="Waive a week">
            <ActionForm action={waiveContributionAction}>
              <SelectField name="chargeId" label="Week" defaultValue={waivable[0]!.chargeId}>
                {waivable.map((w) => (
                  <option key={w.chargeId} value={w.chargeId}>
                    Sunday {formatDate(w.weekEnding)} · {formatNaira(w.outstanding)}
                  </option>
                ))}
              </SelectField>
              <TextareaField name="reason" label="Reason" />
              <SubmitButton tone="plain">Waive week</SubmitButton>
            </ActionForm>
          </Disclosure>
        </div>
      ) : null}
    </li>
  );
}
