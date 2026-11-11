import { sql, type SQL } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { businessDate } from "@/lib/clock";
import { DomainError } from "@/lib/errors";
import { periodOf, type DateRange, type Period, type PeriodKind } from "@/lib/periods";
import { requirePermission, type Ctx } from "./context";

/**
 * Daily balances added up over a week or a month. Every screen and report that
 * shows these figures uses this file, so they always agree.
 *
 * Due and Paid look at the days the balances were for. Received looks at the
 * days money came in. Clearing last week's debt this Monday is Received this
 * week but Paid last week, so Received can be more than Due.
 */

export type BalanceTotals = {
  dueKobo: number;
  /** Paid towards these days' balances, whenever the money came in. */
  paidKobo: number;
  owedKobo: number;
  /** One per operator, tricycle and day charged. */
  daysCharged: number;
  daysPaidInFull: number;
  /** Null when everything in the range is paid. */
  oldestUnpaid: string | null;
};

export type MoneyReceived = {
  totalKobo: number;
  byMethod: { cash: number; pos: number; transfer: number };
  /** What the money was spent on. Credit is money not yet used for anything. */
  forBalancesKobo: number;
  forFinesKobo: number;
  forLoansKobo: number;
  creditKobo: number;
};

const num = (value: unknown) => Number(value ?? 0);

/** Balances charged for days in the range. Voided charges and reversed payments never count. */
export async function balanceTotals(
  exec: Executor,
  range: DateRange,
  operatorId?: string,
): Promise<BalanceTotals> {
  const forOperator = operatorId ? sql`AND c.operator_id = ${operatorId}` : sql``;
  const [row] = (await exec.execute(sql`
    WITH days AS (
      SELECT c.business_date, c.amount_kobo,
             LEAST(c.amount_kobo, COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                            WHERE e.charge_id = c.id), 0)) AS paid
      FROM valid_charges c
      WHERE c.type = 'daily_balance'
        AND c.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        ${forOperator}
    )
    SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS due,
           COALESCE(SUM(paid), 0)::float8 AS paid,
           COUNT(*)::int AS days,
           (COUNT(*) FILTER (WHERE paid >= amount_kobo))::int AS full_days,
           (MIN(business_date) FILTER (WHERE paid < amount_kobo))::text AS oldest
    FROM days
  `)) as unknown as { due: number; paid: number; days: number; full_days: number; oldest: string | null }[];
  const due = num(row?.due);
  const paid = num(row?.paid);
  return {
    dueKobo: due,
    paidKobo: paid,
    owedKobo: due - paid,
    daysCharged: num(row?.days),
    daysPaidInFull: num(row?.full_days),
    oldestUnpaid: row?.oldest ?? null,
  };
}

/** Money taken in on days in the range, leaving out reversed payments. */
export async function moneyReceived(
  exec: Executor,
  range: DateRange,
  who: { operatorId?: string; receivedBy?: string } = {},
): Promise<MoneyReceived> {
  const filters: SQL[] = [];
  if (who.operatorId) filters.push(sql`AND p.operator_id = ${who.operatorId}`);
  if (who.receivedBy) filters.push(sql`AND p.received_by = ${who.receivedBy}`);
  const [row] = (await exec.execute(sql`
    WITH paid_in AS (
      SELECT p.id, p.method, p.amount_kobo FROM payments p
      WHERE p.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
        ${sql.join(filters, sql` `)}
    ), spent AS (
      SELECT c.type, SUM(a.amount_kobo) AS amount FROM payment_allocations a
      JOIN paid_in ON paid_in.id = a.payment_id
      JOIN valid_charges c ON c.id = a.charge_id
      GROUP BY c.type
    )
    SELECT
      (SELECT COALESCE(SUM(amount_kobo), 0) FROM paid_in)::float8 AS total,
      (SELECT COALESCE(SUM(amount_kobo), 0) FROM paid_in WHERE method = 'cash')::float8 AS cash,
      (SELECT COALESCE(SUM(amount_kobo), 0) FROM paid_in WHERE method = 'pos')::float8 AS pos,
      (SELECT COALESCE(SUM(amount_kobo), 0) FROM paid_in WHERE method = 'transfer')::float8 AS transfer,
      (SELECT COALESCE(SUM(amount), 0) FROM spent WHERE type = 'daily_balance')::float8 AS balances,
      (SELECT COALESCE(SUM(amount), 0) FROM spent WHERE type = 'penalty')::float8 AS fines,
      (SELECT COALESCE(SUM(amount), 0) FROM spent WHERE type = 'loan')::float8 AS loans
  `)) as unknown as Record<"total" | "cash" | "pos" | "transfer" | "balances" | "fines" | "loans", number>[];
  const total = num(row?.total);
  const balances = num(row?.balances);
  const fines = num(row?.fines);
  const loans = num(row?.loans);
  return {
    totalKobo: total,
    byMethod: { cash: num(row?.cash), pos: num(row?.pos), transfer: num(row?.transfer) },
    forBalancesKobo: balances,
    forFinesKobo: fines,
    forLoansKobo: loans,
    creditKobo: total - balances - fines - loans,
  };
}

export type FleetPeriod = {
  period: Period;
  balances: BalanceTotals;
  /** The same point in the period before, for comparison. */
  previous: BalanceTotals;
  received: MoneyReceived;
};

/** Whole-fleet figures for this week or month so far. */
export async function fleetPeriod(ctx: Ctx, kind: PeriodKind): Promise<FleetPeriod> {
  requirePermission(ctx, "finance.view");
  const period = periodOf(kind, businessDate(ctx.clock()));
  const [balances, previous, received] = await Promise.all([
    balanceTotals(db, period.soFar),
    balanceTotals(db, period.previous),
    moneyReceived(db, period.soFar),
  ]);
  return { period, balances, previous, received };
}

export type OperatorPeriod = { period: Period; balances: BalanceTotals };

async function operatorPeriods(operatorId: string, today: string): Promise<OperatorPeriod[]> {
  return Promise.all(
    (["week", "month"] as const).map(async (kind) => {
      const period = periodOf(kind, today);
      return { period, balances: await balanceTotals(db, period.soFar, operatorId) };
    }),
  );
}

/** One operator's week and month, for staff who can see money. */
export async function operatorBalancePeriods(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "finance.view");
  return operatorPeriods(operatorId, businessDate(ctx.clock()));
}

/** The operator comes only from the login session. */
export async function myBalancePeriods(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  const operatorId = ctx.actor.operatorId;
  if (!operatorId) throw new DomainError("This login is not linked to an operator.");
  return operatorPeriods(operatorId, businessDate(ctx.clock()));
}

export type CashierTakings = { userId: string; name: string; dayKobo: number; weekKobo: number; monthKobo: number };

/** What each staff member recorded today, this week and this month, for staff who see money. */
export async function collectionsByCashier(ctx: Ctx): Promise<CashierTakings[]> {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const week = periodOf("week", today).soFar.from;
  const month = periodOf("month", today).soFar.from;
  const earliest = week < month ? week : month;
  const rows = (await db.execute(sql`
    SELECT u.id AS user_id, u.name,
           COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.business_date = ${today}::date), 0)::float8 AS day,
           COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.business_date >= ${week}::date), 0)::float8 AS week,
           COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.business_date >= ${month}::date), 0)::float8 AS month
    FROM payments p JOIN users u ON u.id = p.received_by
    WHERE p.business_date BETWEEN ${earliest}::date AND ${today}::date
      AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
    GROUP BY u.id, u.name
    ORDER BY month DESC, u.name
  `)) as unknown as { user_id: string; name: string; day: number; week: number; month: number }[];
  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    dayKobo: num(row.day),
    weekKobo: num(row.week),
    monthKobo: num(row.month),
  }));
}

/** Money the signed-in staff member recorded today, this week and this month. */
export async function myCollections(ctx: Ctx) {
  requirePermission(ctx, "payment.record");
  const today = businessDate(ctx.clock());
  const receivedBy = ctx.actor.userId;
  const [day, week, month] = await Promise.all([
    moneyReceived(db, { from: today, to: today }, { receivedBy }),
    moneyReceived(db, periodOf("week", today).soFar, { receivedBy }),
    moneyReceived(db, periodOf("month", today).soFar, { receivedBy }),
  ]);
  return { today, day, week, month };
}
