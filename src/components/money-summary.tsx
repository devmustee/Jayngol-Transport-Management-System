import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  Award,
  ChevronRight,
  Receipt,
  Scale,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { BalanceTotals, FleetPeriod } from "@/services/balance-periods";
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
      className={`group flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition-all duration-150 hover:shadow-sm ${styles[tone]}`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon size={18} className="shrink-0" />
        <span className="truncate">{title}</span>
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
  basePath,
}: {
  money: Awaited<ReturnType<typeof financeOverview>>;
  /** This week or this month. Null shows today. */
  period?: FleetPeriod | null;
  /** The page the period switch links back to. */
  basePath: string;
}) {
  const deducted = money.loansKobo !== 0 || money.expensesKobo !== 0;
  const leftKobo = money.collectedKobo - money.loansKobo - money.expensesKobo;
  const percentCollected =
    money.expectedKobo > 0
      ? Math.min(100, Math.round((money.collectedKobo / money.expectedKobo) * 100))
      : 100;

  const hasAlerts =
    !money.jobIsCurrent ||
    money.sackingAlerts > 0 ||
    money.toConfirm > 0 ||
    money.awardsWaiting > 0 ||
    money.cashNotClosed.length > 0 ||
    money.handoversWaiting > 0 ||
    money.closesToCheck > 0 ||
    money.advances.open > 0 ||
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
              title={`${person.name} has not closed cash since ${formatDate(person.since)}`}
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

          {money.advances.open > 0 ? (
            <AlertRow
              href="/expenses"
              icon={Receipt}
              title={`${money.advances.open} expense advance${money.advances.open === 1 ? "" : "s"} to account for`}
              count={money.advances.open}
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

      {/* Sovereign Financial Pulse Hero Card */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-ink via-ink-soft to-[#1b160f] p-6 text-paper shadow-2xl border border-gold-deep/30">
        {/* Subtle background glow */}
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gold/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-gold-deep/20 blur-3xl" />

        <nav aria-label="Choose a period" className="relative z-10 mb-4 inline-flex rounded-xl border border-paper/15 bg-ink/40 p-1">
          {PULSE_OPTIONS.map(([value, label]) => {
            const active = (period?.period.kind ?? "today") === value;
            return (
              <Link
                key={value}
                href={value === "today" ? basePath : `${basePath}?pulse=${value}`}
                scroll={false}
                aria-current={active ? "true" : undefined}
                className={`inline-flex min-h-11 items-center rounded-lg px-3.5 text-sm font-bold transition-colors ${
                  active ? "bg-gold-light text-ink" : "text-paper/75 hover:bg-paper/10 hover:text-paper"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          {period ? (
            <PeriodFigures data={period} />
          ) : (
            <div>
              <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-gold uppercase">
                <TrendingUp size={15} />
                <span>Financial Pulse • Today</span>
              </div>
              <div className="mt-2 text-3xl font-black tracking-tight text-gold-light md:text-5xl tabular-nums drop-shadow-sm">
                {signedNaira(leftKobo)}
              </div>
              {deducted ? (
                <div className="mt-1 text-sm text-paper/75">
                  Left after {signedNaira(money.loansKobo)} loans and {signedNaira(money.expensesKobo)} expenses
                </div>
              ) : null}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-paper/75">
                {deducted ? (
                  <>
                    <span>Collected: {formatNaira(money.collectedKobo)}</span>
                    <span>•</span>
                  </>
                ) : null}
                <span>Target: {formatNaira(money.expectedKobo)}</span>
                <span>•</span>
                <span className="font-semibold text-paper/90">{percentCollected}% collected</span>
              </div>
            </div>
          )}

          {money.canCollect ? (
            <Link
              href="/payments/new"
              className="group inline-flex min-h-12 items-center gap-2 rounded-2xl bg-gradient-to-r from-gold to-gold-light px-5 py-3 text-sm font-extrabold text-ink shadow-gold-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98]"
            >
              <Wallet size={18} className="transition-transform group-hover:scale-110" />
              <span>Take payment</span>
            </Link>
          ) : null}
        </div>

        {/* Progress Bar */}
        {period ? (
          <PeriodProgress data={period} />
        ) : (
          <div className="relative z-10 mt-5">
            <ProgressBar percent={percentCollected} />
            <div className="mt-2 flex items-center justify-between text-xs text-paper/60">
              <span>
                {money.overdueOperators > 0
                  ? `${money.overdueOperators} operator${money.overdueOperators === 1 ? "" : "s"} with unpaid balances`
                  : "All expected balances settled"}
              </span>
              <span className="font-bold text-gold-light">{percentCollected}%</span>
            </div>
          </div>
        )}
      </div>
    </div>
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
        className="h-full rounded-full bg-gradient-to-r from-gold-deep via-gold to-gold-light transition-all duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function PeriodFigures({ data }: { data: FleetPeriod }) {
  const { balances, period } = data;
  const label = period.kind === "week" ? "This week" : "This month";
  return (
    <div>
      <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-gold uppercase">
        <TrendingUp size={15} />
        <span>
          Financial Pulse • {label} since {formatDate(period.soFar.from)}
        </span>
      </div>
      <div className="mt-2 text-3xl font-black tracking-tight text-gold-light md:text-5xl tabular-nums drop-shadow-sm">
        {formatNaira(balances.paidKobo)}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-paper/75">
        <span>Paid of {formatNaira(balances.dueKobo)} due</span>
        <span>•</span>
        <span className="font-semibold text-paper/90">{paidPercent(balances)}% paid</span>
      </div>
      <div className="mt-1 text-sm text-paper/75">{comparison(data)}</div>
    </div>
  );
}

function PeriodProgress({ data }: { data: FleetPeriod }) {
  const { balances, period, received } = data;
  const percent = paidPercent(balances);
  const which = period.kind === "week" ? "this week" : "this month";
  return (
    <div className="relative z-10 mt-5">
      <ProgressBar percent={percent} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-paper/60">
        {balances.owedKobo > 0 ? (
          <Link
            href={`/arrears?from=${period.soFar.from}&to=${period.soFar.to}`}
            className="font-semibold text-paper/85 underline underline-offset-2 hover:text-gold-light"
          >
            {formatNaira(balances.owedKobo)} still owed for {which}
          </Link>
        ) : (
          <span>Every balance for {which} is paid</span>
        )}
        <span>Money received {which}: {formatNaira(received.totalKobo)}</span>
      </div>
    </div>
  );
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
