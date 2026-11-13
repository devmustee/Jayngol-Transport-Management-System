import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  Award,
  ChevronRight,
  HandCoins,
  Receipt,
  Scale,
  Sparkles,
  ArrowDownRight,
  ArrowUpRight,
  Wallet,
} from "lucide-react";
import { CountUp } from "@/components/count-up";
import { formatDate, formatShortDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { BalanceTotals, FleetDay, FleetPeriod } from "@/services/balance-periods";
import type { financeOverview } from "@/services/finance";

function AlertRow({
  href,
  icon: Icon,
  title,
  count,
  tone = "danger",
}: {
  href: string;
  icon: typeof AlertCircle;
  title: string;
  count?: number;
  tone?: "danger" | "warning";
}) {
  const styles = {
    danger: "bg-danger-wash text-danger border-danger-border/70 hover:bg-danger-wash/80",
    warning: "bg-warning-wash text-warning border-warning-border/70 hover:bg-warning-wash/80",
  };

  return (
    <Link
      href={href}
      className={`group flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition-colors duration-150 ${styles[tone]}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon size={18} className="shrink-0" aria-hidden />
        <span className="min-w-0 leading-snug">{title}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {count !== undefined ? (
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-bold tabular-nums">
            {count}
          </span>
        ) : null}
        <ChevronRight size={16} className="transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

const signedNaira = (kobo: number) => `${kobo < 0 ? "-" : ""}${formatNaira(Math.abs(kobo))}`;

export function MoneySummary({
  money,
  period = null,
  today = null,
  basePath,
}: {
  money: Awaited<ReturnType<typeof financeOverview>>;
  /** This week or this month. Null shows today. */
  period?: FleetPeriod | null;
  /** Today's figures, shown when no week or month is chosen. */
  today?: FleetDay | null;
  /** The page the period switch links back to. */
  basePath: string;
}) {
  const deducted = money.loansKobo !== 0 || money.expensesKobo !== 0;
  const leftKobo = money.collectedKobo - money.loansKobo - money.expensesKobo;
  // Before the nightly job raises today's balances there is no target yet, so
  // "100% collected" would be false comfort.
  const noTarget = money.expectedKobo === 0;
  const targetText = noTarget
    ? money.jobIsCurrent
      ? "No balances due today"
      : "Waiting for today's balances"
    : null;

  const hasAlerts =
    !money.jobIsCurrent ||
    money.sackingAlerts > 0 ||
    money.toConfirm > 0 ||
    money.awardsWaiting > 0 ||
    money.cashNotClosed.length > 0 ||
    money.handoversWaiting > 0 ||
    money.closesToCheck > 0 ||
    money.advances.submitted > 0;

  return (
    <div className="mb-6 space-y-4">
      {/* Alert Center */}
      {hasAlerts ? (
        <div className="space-y-2">
          {!money.jobIsCurrent ? (
            <div
              role="alert"
              className="flex items-center gap-2.5 rounded-xl border border-danger-border bg-danger-wash px-4 py-3 text-sm font-bold text-danger"
            >
              <AlertCircle size={20} className="shrink-0" />
              <span>Today&apos;s balances have not been raised yet. Nightly job has not run.</span>
            </div>
          ) : null}

          {money.sackingAlerts > 0 ? (
            <AlertRow
              href="/sacking"
              icon={AlertTriangle}
              title={`${money.sackingAlerts} operator${money.sackingAlerts === 1 ? "" : "s"} at 5 unpaid days`}
              count={money.sackingAlerts}
              tone="danger"
            />
          ) : null}

          {money.toConfirm > 0 ? (
            <AlertRow
              href="/offences?status=proposed"
              icon={Scale}
              title={`${money.toConfirm} offence${money.toConfirm === 1 ? "" : "s"} to confirm`}
              count={money.toConfirm}
              tone="warning"
            />
          ) : null}

          {money.cashNotClosed.map((person) => (
            <AlertRow
              key={person.name}
              href="/cash"
              icon={Wallet}
              title={
                person.week
                  ? `${person.name} has not closed the week's cash (${formatDate(person.week.from)} to ${formatDate(person.week.to)})`
                  : `${person.name} has not closed cash since ${formatDate(person.since)}`
              }
              tone="danger"
            />
          ))}

          {money.handoversWaiting > 0 ? (
            <AlertRow
              href="/transfers"
              icon={Wallet}
              title={`${money.handoversWaiting} cash handover${money.handoversWaiting === 1 ? "" : "s"} waiting to be accepted`}
              count={money.handoversWaiting}
              tone="warning"
            />
          ) : null}

          {money.closesToCheck > 0 ? (
            <AlertRow
              href="/cash"
              icon={Wallet}
              title={`${money.closesToCheck} cash count${money.closesToCheck === 1 ? "" : "s"} waiting for a second check`}
              count={money.closesToCheck}
              tone="warning"
            />
          ) : null}

          {money.awardsWaiting > 0 ? (
            <AlertRow
              href="/awards"
              icon={Award}
              title={`${money.awardsWaiting} award${money.awardsWaiting === 1 ? "" : "s"} waiting for decision`}
              count={money.awardsWaiting}
              tone="warning"
            />
          ) : null}

          {money.advances.submitted > 0 ? (
            <AlertRow
              href="/expenses"
              icon={Receipt}
              title={`${money.advances.submitted} expense${money.advances.submitted === 1 ? "" : "s"} waiting for countersign`}
              count={money.advances.submitted}
              tone="warning"
            />
          ) : null}
        </div>
      ) : null}

      {/* The money pulse: one plain dark card. */}
      <div className="relative overflow-hidden rounded-2xl bg-ink p-5 text-paper sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Choose a period" className="inline-flex rounded-xl border border-paper/15 p-1">
            {PULSE_OPTIONS.map(([value, label]) => {
              const active = (period?.period.kind ?? "today") === value;
              return (
                <Link
                  key={value}
                  href={value === "today" ? basePath : `${basePath}?pulse=${value}`}
                  scroll={false}
                  aria-current={active ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-lg px-3.5 text-sm font-semibold transition-colors ${
                    active ? "bg-gold-light text-ink" : "text-paper/75 hover:bg-paper/10 hover:text-paper"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
          {money.canCollect ? (
            <Link
              href="/payments/new"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gold px-4 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-gold-light active:scale-[0.98]"
            >
              <Wallet size={18} aria-hidden />
              <span>Take payment</span>
            </Link>
          ) : null}
        </div>

        {period ? (
          <Pulse
            label={`Received ${period.period.kind === "week" ? "this week" : "this month"}`}
            range={`${formatShortDate(period.period.soFar.from)} to ${formatShortDate(period.period.soFar.to)}`}
            which={period.period.kind === "week" ? "this week" : "this month"}
            balances={period.balances}
            owedHref={`/arrears?from=${period.period.soFar.from}&to=${period.period.soFar.to}`}
            trend={trendOf(period)}
            countId={`${basePath}:${period.period.kind}`}
          >
            <span>All money in: {formatNaira(period.received.totalKobo)}{period.received.totalKobo !== period.balances.paidKobo ? ", including old debts, fines and loans" : ""}</span>
            <LoansLink money={money} />
          </Pulse>
        ) : today ? (
          <Pulse
            label="Received today"
            range={formatDate(today.date)}
            which="today"
            balances={today.balances}
            owedHref={`/arrears?from=${today.date}&to=${today.date}`}
            waiting={today.balances.daysCharged === 0 ? targetText ?? "No balances due today" : null}
            countId={`${basePath}:today`}
          >
            <span>
              All money in: {formatNaira(today.received.totalKobo)}
              {deducted
                ? `, ${formatNaira(leftKobo)} left after ${signedNaira(money.loansKobo)} loans and ${signedNaira(money.expensesKobo)} expenses`
                : today.received.totalKobo !== today.balances.paidKobo
                  ? ", including old debts, fines and loans"
                  : ""}
            </span>
            {money.overdueOperators > 0 ? (
              <FooterLink href="/arrears">
                Older debts: {formatNaira(money.overdueOwedKobo)} from {money.overdueOperators} operator{money.overdueOperators === 1 ? "" : "s"}
              </FooterLink>
            ) : null}
            <LoansLink money={money} />
          </Pulse>
        ) : null}
      </div>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group/foot inline-flex min-h-9 items-center gap-1 text-paper/85 underline underline-offset-2 hover:text-gold-light"
    >
      {children}
      <ChevronRight size={13} aria-hidden className="transition-transform group-hover/foot:translate-x-0.5" />
    </Link>
  );
}

function LoansLink({ money }: { money: Awaited<ReturnType<typeof financeOverview>> }) {
  if (money.loansActive === 0) return null;
  return (
    <FooterLink href="/loans">
      <HandCoins size={13} aria-hidden />
      Loans to collect: {formatNaira(money.loansOwedKobo)}
    </FooterLink>
  );
}

const PULSE_OPTIONS = [
  ["today", "Today"],
  ["week", "This week"],
  ["month", "This month"],
] as const;

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-muted/80">
      <div
        className="h-full origin-left animate-fill rounded-full bg-gold transition-all duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * Received is the main figure. Due and Remaining sit smaller beneath the bar,
 * and Received plus Remaining always makes Due.
 */
function Pulse({
  label,
  range,
  which,
  balances,
  owedHref,
  trend = null,
  waiting = null,
  countId,
  children,
}: {
  label: string;
  range: string;
  /** "today", "this week" or "this month", for the sentences. */
  which: string;
  balances: BalanceTotals;
  owedHref: string;
  trend?: Trend | null;
  /** Shown instead of the figures when nothing has been charged yet. */
  waiting?: string | null;
  countId: string;
  /** The quiet footer: all money in, older debts, loans. */
  children?: React.ReactNode;
}) {
  const percent = paidPercent(balances);
  return (
    <div>
      <div className="text-sm text-paper/60">
        {label} <span aria-hidden>·</span> {range}
      </div>

      {waiting ? (
        <p className="mt-2 text-2xl font-semibold text-paper">{waiting}</p>
      ) : (
        <>
          <div className="mt-1 text-4xl font-semibold tracking-tight text-paper tabular-nums sm:text-5xl">
            <CountUp kobo={balances.paidKobo} id={countId} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-paper/75">
            <span>{balances.owedKobo > 0 ? `${percent}% of what was due` : `Everything due ${which} is paid`}</span>
            {trend ? (
              <span className={`inline-flex items-center gap-1 ${trend.kobo > 0 ? "text-ok-border" : "text-paper/60"}`}>
                {trend.kobo > 0 ? <ArrowUpRight size={15} aria-hidden /> : trend.kobo < 0 ? <ArrowDownRight size={15} aria-hidden /> : null}
                {trend.text}
              </span>
            ) : null}
          </div>

          <div className="mt-4">
            <ProgressBar percent={percent} />
          </div>

          <dl className="mt-4 grid grid-cols-2 border-t border-paper/10">
            <div className="min-w-0 pt-3 pr-4">
              <dt className="text-xs text-paper/60">Due</dt>
              <dd className="text-lg font-semibold tracking-tight text-paper tabular-nums sm:text-xl">
                {formatNaira(balances.dueKobo)}
              </dd>
            </div>
            <div className="min-w-0 border-l border-paper/10 pt-3 pl-4">
              <dt className="text-xs text-paper/60">Remaining</dt>
              <dd className="flex flex-wrap items-baseline gap-x-2">
                <span className={`text-lg font-semibold tracking-tight tabular-nums sm:text-xl ${balances.owedKobo > 0 ? "text-gold-light" : "text-paper"}`}>
                  {formatNaira(balances.owedKobo)}
                </span>
                {balances.owedKobo > 0 ? (
                  <Link href={owedHref} className="inline-flex min-h-9 items-center text-xs text-gold-light underline underline-offset-2 hover:text-paper">
                    See who owes
                  </Link>
                ) : null}
              </dd>
            </div>
          </dl>
        </>
      )}

      {children ? (
        <div className="mt-4 flex flex-col gap-x-4 gap-y-1 border-t border-paper/10 pt-3 text-xs text-paper/60 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          {children}
        </div>
      ) : null}
    </div>
  );
}

type Trend = { kobo: number; text: string };

/** The comparison with the same point last week or month, with its direction for the arrow. */
function trendOf(data: FleetPeriod): Trend | null {
  if (data.previous.dueKobo === 0) return null;
  return { kobo: data.balances.paidKobo - data.previous.paidKobo, text: comparison(data) };
}

/** Whole percent of the balances paid, never above 100. Nothing due counts as 100. */
export const paidPercent = (balances: BalanceTotals) =>
  balances.dueKobo > 0 ? Math.min(100, Math.floor((balances.paidKobo / balances.dueKobo) * 100)) : 100;

/** Compared with the same point in the period before, for example Monday to Wednesday of last week. */
export function comparison({ balances, previous, period }: FleetPeriod): string {
  const last = period.kind === "week" ? "last week" : "last month";
  if (previous.dueKobo === 0) return `Nothing to compare with ${last} yet`;
  const difference = balances.paidKobo - previous.paidKobo;
  if (difference === 0) return `The same as this time ${last}`;
  return `${formatNaira(Math.abs(difference))} ${difference > 0 ? "more" : "less"} than this time ${last}`;
}
