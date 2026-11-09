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
import { formatNaira } from "@/lib/money";
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

export function MoneySummary({ money }: { money: Awaited<ReturnType<typeof financeOverview>> }) {
  const percentCollected =
    money.expectedKobo > 0
      ? Math.min(100, Math.round((money.collectedKobo / money.expectedKobo) * 100))
      : 100;

  const hasAlerts =
    !money.jobIsCurrent ||
    money.sackingAlerts > 0 ||
    money.toConfirm > 0 ||
    money.awardsWaiting > 0 ||
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

        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-gold uppercase">
              <TrendingUp size={15} />
              <span>Financial Pulse • Today</span>
            </div>
            <div className="mt-2 text-3xl font-black tracking-tight text-gold-light md:text-5xl tabular-nums drop-shadow-sm">
              {formatNaira(money.collectedKobo)}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-paper/75">
              <span>Target: {formatNaira(money.expectedKobo)}</span>
              <span>•</span>
              <span className="font-semibold text-paper/90">{percentCollected}% collected</span>
            </div>
          </div>

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
        <div className="relative z-10 mt-5">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-muted/80">
            <div
              className="h-full rounded-full bg-gradient-to-r from-gold-deep via-gold to-gold-light transition-all duration-500"
              style={{ width: `${percentCollected}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-paper/60">
            <span>
              {money.overdueOperators > 0
                ? `${money.overdueOperators} operator${money.overdueOperators === 1 ? "" : "s"} with unpaid balances`
                : "All expected balances settled"}
            </span>
            <span className="font-bold text-gold-light">{percentCollected}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
