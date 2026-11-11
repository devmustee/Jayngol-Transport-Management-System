import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { comparison, paidPercent } from "@/components/money-summary";
import { Card, Empty } from "@/components/ui";
import { formatDate, METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { PeriodKind } from "@/lib/periods";
import type {
  CashierTakings,
  FleetPeriod,
  MoneyReceived,
  myCollections,
  OperatorPeriod,
} from "@/services/balance-periods";

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`tabular-nums ${strong ? "text-base font-extrabold text-ink" : "text-sm font-semibold text-ink"}`}>{value}</dd>
    </div>
  );
}

function Column({ data }: { data: FleetPeriod }) {
  const { period, balances, received } = data;
  const title = period.kind === "week" ? "This week" : "This month";
  const percent = paidPercent(balances);
  return (
    <div className="min-w-0 rounded-xl border border-line bg-card-subtle p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-extrabold text-ink">{title}</h3>
        <span className="text-xs text-muted">
          {formatDate(period.soFar.from)} to {formatDate(period.soFar.to)}
        </span>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-gradient-to-r from-gold-deep to-gold" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {percent}% paid · {comparison(data)}
      </p>

      <dl className="mt-3 divide-y divide-line/60">
        <Row label="Due" value={formatNaira(balances.dueKobo)} />
        <Row label="Paid" value={formatNaira(balances.paidKobo)} />
        {balances.owedKobo > 0 ? (
          <Link
            href={`/arrears?from=${period.soFar.from}&to=${period.soFar.to}`}
            className="group -mx-1 flex min-h-11 items-center justify-between gap-3 rounded-lg px-1 hover:bg-gold-wash"
          >
            <span className="text-sm font-semibold text-danger">Owed</span>
            <span className="flex items-center gap-1 text-base font-extrabold tabular-nums text-danger">
              {formatNaira(balances.owedKobo)}
              <ChevronRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ) : (
          <Row label="Owed" value={formatNaira(0)} strong />
        )}
      </dl>

      <h4 className="mt-4 text-xs font-bold uppercase tracking-wider text-muted">Money received</h4>
      <dl className="mt-1 divide-y divide-line/60">
        <Row label="Total" value={formatNaira(received.totalKobo)} strong />
        <Row label="Cash" value={formatNaira(received.byMethod.cash)} />
        <Row label="POS" value={formatNaira(received.byMethod.pos)} />
        <Row label="Transfer" value={formatNaira(received.byMethod.transfer)} />
      </dl>
      <h4 className="mt-4 text-xs font-bold uppercase tracking-wider text-muted">What it paid for</h4>
      <dl className="mt-1 divide-y divide-line/60">
        <Row label="Balances" value={formatNaira(received.forBalancesKobo)} />
        <Row label="Fines" value={formatNaira(received.forFinesKobo)} />
        <Row label="Loans" value={formatNaira(received.forLoansKobo)} />
        {received.creditKobo > 0 ? <Row label="Not used yet (credit)" value={formatNaira(received.creditKobo)} /> : null}
      </dl>
    </div>
  );
}

function TakingsTile({ label, money }: { label: string; money: MoneyReceived }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-card-subtle p-3.5">
      <div className="text-xs font-bold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-xl font-black tabular-nums text-ink">{formatNaira(money.totalKobo)}</div>
      <dl className="mt-2 space-y-0.5 text-xs text-muted">
        {(["cash", "pos", "transfer"] as const).map((method) => (
          <div key={method} className="flex justify-between gap-2">
            <dt>{METHOD_LABELS[method]}</dt>
            <dd className="tabular-nums font-semibold text-ink">{formatNaira(money.byMethod[method])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Only what the signed-in staff member recorded themselves. */
export function MyCollectionsCard({ data }: { data: Awaited<ReturnType<typeof myCollections>> }) {
  return (
    <Card title="My collections" subtitle="Money you recorded yourself, leaving out reversed payments">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TakingsTile label="Today" money={data.day} />
        <TakingsTile label="This week" money={data.week} />
        <TakingsTile label="This month" money={data.month} />
      </div>
    </Card>
  );
}

/** One row per staff member who recorded money this month. */
export function CashierTakingsCard({ rows }: { rows: CashierTakings[] }) {
  return (
    <Card title="Collections by cashier" subtitle="Money each person recorded, leaving out reversed payments">
      {rows.length === 0 ? (
        <Empty>Nobody has recorded money this month.</Empty>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-sm">
            <thead>
              <tr className="text-left text-xs font-bold uppercase tracking-wider text-muted">
                <th scope="col" className="px-1 pb-2">Cashier</th>
                <th scope="col" className="px-1 pb-2 text-right">Today</th>
                <th scope="col" className="px-1 pb-2 text-right">This week</th>
                <th scope="col" className="px-1 pb-2 text-right">This month</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.userId}>
                  <th scope="row" className="px-1 py-2.5 text-left font-semibold text-ink">{row.name}</th>
                  <td className="px-1 py-2.5 text-right tabular-nums">{formatNaira(row.dayKobo)}</td>
                  <td className="px-1 py-2.5 text-right tabular-nums">{formatNaira(row.weekKobo)}</td>
                  <td className="px-1 py-2.5 text-right font-bold tabular-nums">{formatNaira(row.monthKobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * One operator's week or month. Used on the operator's own portal and, for
 * staff who see money, on the operator's profile.
 */
export function OperatorBalanceCard({
  periods,
  kind,
  hrefFor,
  title,
}: {
  periods: OperatorPeriod[];
  kind: PeriodKind;
  /** Where each switch option links to. */
  hrefFor: (kind: PeriodKind) => string;
  title: string;
}) {
  const shown = periods.find((item) => item.period.kind === kind) ?? periods[0]!;
  const { balances, period } = shown;
  const percent = paidPercent(balances);
  const which = kind === "week" ? "this week" : "this month";
  return (
    <Card title={title} subtitle={`${formatDate(period.soFar.from)} to ${formatDate(period.soFar.to)}`}>
      <nav aria-label="Choose a period" className="mb-4 inline-flex rounded-xl border border-line bg-card-subtle p-1">
        {(["week", "month"] as const).map((option) => (
          <Link
            key={option}
            href={hrefFor(option)}
            scroll={false}
            aria-current={option === kind ? "true" : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg px-3.5 text-sm font-bold transition-colors ${
              option === kind ? "bg-ink text-gold-light" : "text-muted hover:bg-gold-wash hover:text-ink"
            }`}
          >
            {option === "week" ? "This week" : "This month"}
          </Link>
        ))}
      </nav>

      {balances.daysCharged === 0 ? (
        <Empty>No balance has been charged {which} yet.</Empty>
      ) : (
        <>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-gradient-to-r from-gold-deep to-gold" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-2 text-sm font-semibold text-ink">
            {balances.daysPaidInFull} of {balances.daysCharged} day{balances.daysCharged === 1 ? "" : "s"} paid in full
          </p>
          <dl className="mt-3 divide-y divide-line/60">
            <Row label="Due" value={formatNaira(balances.dueKobo)} />
            <Row label="Paid" value={formatNaira(balances.paidKobo)} />
            <Row label="Still owed" value={formatNaira(balances.owedKobo)} strong />
          </dl>
          {balances.oldestUnpaid ? (
            <p className="mt-3 rounded-lg border border-warning-border bg-warning-wash px-3 py-2 text-sm font-semibold text-warning">
              Not yet paid in full since {formatDate(balances.oldestUnpaid)}
            </p>
          ) : (
            <p className="mt-3 rounded-lg border border-ok-border bg-ok-wash px-3 py-2 text-sm font-semibold text-ok">
              Every balance for {which} is paid
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** This week and this month side by side, for the Money page. */
export function BalancesByPeriod({ week, month }: { week: FleetPeriod; month: FleetPeriod }) {
  return (
    <Card
      title="Balances by period"
      subtitle="Paid counts money for these days whenever it came in. Received counts money that came in on these days, including older debts."
      className="mb-6"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Column data={week} />
        <Column data={month} />
      </div>
    </Card>
  );
}
