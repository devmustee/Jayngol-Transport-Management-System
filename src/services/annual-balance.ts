import { sql } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { addDays, businessDate } from "@/lib/clock";
import { monthEnd, weekStart, type DateRange } from "@/lib/periods";
import { requirePermission, type Ctx } from "./context";
import type { Column } from "./reports";

/**
 * The whole year, by month and by week, with month subtotals and a year total.
 *
 * Every figure is first worked out per day and then added up, so the weeks add
 * up exactly to their month and the months to the year. A week that crosses a
 * month end is split, so each part sits in its own month. The rules are the
 * same as balance-periods.ts: Due and Paid follow the day a balance was for,
 * Received follows the day money came in, and reversed payments and voided
 * charges never count.
 */

export type YearFigures = {
  dueKobo: number;
  /** Paid towards these days' balances, whenever the money came in. */
  paidKobo: number;
  owedKobo: number;
  receivedKobo: number;
  cashKobo: number;
  posKobo: number;
  transferKobo: number;
  /** What the money received paid for. Credit is money not yet used for anything. */
  forBalancesKobo: number;
  forFinesKobo: number;
  /** Loan repayments: the part of money received that went to loans. */
  forLoansKobo: number;
  creditKobo: number;
  expensesKobo: number;
  loansGivenKobo: number;
  /** Money received less expenses and loans given. */
  netKobo: number;
  /** Deposits are held for operators, so they are never income and stay out of Net. */
  depositsKobo: number;
};

type DayFigures = Omit<YearFigures, "owedKobo" | "creditKobo" | "netKobo">;

const DAY_KEYS = [
  "dueKobo",
  "paidKobo",
  "receivedKobo",
  "cashKobo",
  "posKobo",
  "transferKobo",
  "forBalancesKobo",
  "forFinesKobo",
  "forLoansKobo",
  "expensesKobo",
  "loansGivenKobo",
  "depositsKobo",
] as const satisfies readonly (keyof DayFigures)[];

export type WeekPart = { range: DateRange; figures: YearFigures };
export type MonthRow = {
  /** 1 to 12. */
  month: number;
  range: DateRange;
  /** After today: nothing can have happened yet. */
  future: boolean;
  weeks: WeekPart[];
  figures: YearFigures;
};
export type AnnualBalance = {
  year: number;
  /** The last day counted: today in the current year, otherwise 31 December. */
  upTo: string;
  months: MonthRow[];
  total: YearFigures;
};

const zero = (): DayFigures => ({
  dueKobo: 0,
  paidKobo: 0,
  receivedKobo: 0,
  cashKobo: 0,
  posKobo: 0,
  transferKobo: 0,
  forBalancesKobo: 0,
  forFinesKobo: 0,
  forLoansKobo: 0,
  expensesKobo: 0,
  loansGivenKobo: 0,
  depositsKobo: 0,
});

function finish(day: DayFigures): YearFigures {
  return {
    ...day,
    owedKobo: day.dueKobo - day.paidKobo,
    creditKobo: day.receivedKobo - day.forBalancesKobo - day.forFinesKobo - day.forLoansKobo,
    netKobo: day.receivedKobo - day.expensesKobo - day.loansGivenKobo,
  };
}

function addInto(into: DayFigures, from: DayFigures) {
  for (const key of DAY_KEYS) into[key] += from[key];
}

/** Each figure for each day of the range that has anything, keyed by date. */
async function dailyFigures(exec: Executor, range: DateRange): Promise<Map<string, DayFigures>> {
  const { from, to } = range;
  const [balances, received, purposes, expenses, loansGiven, deposits] = await Promise.all([
    exec.execute(sql`
      SELECT c.business_date::text AS day, SUM(c.amount_kobo)::float8 AS due,
             SUM(LEAST(c.amount_kobo, COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                                WHERE e.charge_id = c.id), 0)))::float8 AS paid
      FROM valid_charges c
      WHERE c.type = 'daily_balance' AND c.business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY c.business_date
    `),
    exec.execute(sql`
      SELECT p.business_date::text AS day, SUM(p.amount_kobo)::float8 AS total,
             COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'cash'), 0)::float8 AS cash,
             COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'pos'), 0)::float8 AS pos,
             COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'transfer'), 0)::float8 AS transfer
      FROM payments p
      WHERE p.business_date BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
      GROUP BY p.business_date
    `),
    exec.execute(sql`
      SELECT p.business_date::text AS day,
             COALESCE(SUM(a.amount_kobo) FILTER (WHERE c.type = 'daily_balance'), 0)::float8 AS balances,
             COALESCE(SUM(a.amount_kobo) FILTER (WHERE c.type = 'penalty'), 0)::float8 AS fines,
             COALESCE(SUM(a.amount_kobo) FILTER (WHERE c.type = 'loan'), 0)::float8 AS loans
      FROM payments p
      JOIN payment_allocations a ON a.payment_id = p.id
      JOIN valid_charges c ON c.id = a.charge_id
      WHERE p.business_date BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
      GROUP BY p.business_date
    `),
    exec.execute(sql`
      SELECT l.spent_on::text AS day, SUM(l.amount_kobo)::float8 AS total
      FROM expense_lines l JOIN expense_advances a ON a.id = l.advance_id
      WHERE l.kind = 'spent' AND a.status <> 'cancelled'
        AND l.spent_on BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM expense_line_voids v WHERE v.line_id = l.id)
      GROUP BY l.spent_on
    `),
    exec.execute(sql`
      SELECT disbursed_on::text AS day, SUM(principal_kobo)::float8 AS total
      FROM loans
      WHERE status <> 'cancelled' AND disbursed_on BETWEEN ${from}::date AND ${to}::date
      GROUP BY disbursed_on
    `),
    exec.execute(sql`
      SELECT d.business_date::text AS day, SUM(d.amount_kobo)::float8 AS total
      FROM operator_deposits d
      WHERE d.business_date BETWEEN ${from}::date AND ${to}::date
        AND NOT EXISTS (SELECT 1 FROM operator_deposit_reversals r WHERE r.deposit_id = d.id)
      GROUP BY d.business_date
    `),
  ]);

  const days = new Map<string, DayFigures>();
  const at = (day: string) => {
    let figures = days.get(day);
    if (!figures) days.set(day, (figures = zero()));
    return figures;
  };
  type Row = Record<string, string | number | null>;
  const n = (value: unknown) => Number(value ?? 0);
  for (const row of balances as unknown as Row[]) {
    const day = at(String(row.day));
    day.dueKobo = n(row.due);
    day.paidKobo = n(row.paid);
  }
  for (const row of received as unknown as Row[]) {
    const day = at(String(row.day));
    day.receivedKobo = n(row.total);
    day.cashKobo = n(row.cash);
    day.posKobo = n(row.pos);
    day.transferKobo = n(row.transfer);
  }
  for (const row of purposes as unknown as Row[]) {
    const day = at(String(row.day));
    day.forBalancesKobo = n(row.balances);
    day.forFinesKobo = n(row.fines);
    day.forLoansKobo = n(row.loans);
  }
  for (const row of expenses as unknown as Row[]) at(String(row.day)).expensesKobo = n(row.total);
  for (const row of loansGiven as unknown as Row[]) at(String(row.day)).loansGivenKobo = n(row.total);
  for (const row of deposits as unknown as Row[]) at(String(row.day)).depositsKobo = n(row.total);
  return days;
}

/** The parts of each Monday-to-Sunday week inside a month, cut off at `upTo`. */
export function weekParts(range: DateRange): DateRange[] {
  const parts: DateRange[] = [];
  let from = range.from;
  while (from <= range.to) {
    const sunday = addDays(weekStart(from), 6);
    const to = sunday < range.to ? sunday : range.to;
    parts.push({ from, to });
    from = addDays(to, 1);
  }
  return parts;
}

function sumDays(days: Map<string, DayFigures>, range: DateRange): DayFigures {
  const total = zero();
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    const figures = days.get(day);
    if (figures) addInto(total, figures);
  }
  return total;
}

/** The earliest and latest years the page offers. */
export function yearBounds(today: string) {
  return { first: 2020, last: Number(today.slice(0, 4)) };
}

/** A year from a page address, or the current year. */
export function parseYear(value: string | null | undefined, today: string): number {
  const { first, last } = yearBounds(today);
  const year = Number(value);
  return Number.isInteger(year) && year >= first && year <= last ? year : last;
}

export async function buildAnnualBalance(exec: Executor, year: number, today: string): Promise<AnnualBalance> {
  const yearEnd = `${year}-12-31`;
  const upTo = today < yearEnd ? today : yearEnd;
  const days = await dailyFigures(exec, { from: `${year}-01-01`, to: upTo });

  const total = zero();
  const months: MonthRow[] = [];
  for (let month = 1; month <= 12; month++) {
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    const full = { from, to: monthEnd(from) };
    const future = from > upTo;
    const counted = { from, to: full.to < upTo ? full.to : upTo };
    const weeks = future
      ? []
      : weekParts(counted).map((range) => ({ range, figures: finish(sumDays(days, range)) }));
    const monthTotal = zero();
    for (const week of weeks) addInto(monthTotal, week.figures);
    addInto(total, monthTotal);
    months.push({ month, range: full, future, weeks, figures: finish(monthTotal) });
  }
  return { year, upTo, months, total: finish(total) };
}

export async function annualBalance(ctx: Ctx, year: number): Promise<AnnualBalance> {
  requirePermission(ctx, "finance.view");
  return buildAnnualBalance(db, year, businessDate(ctx.clock()));
}

/* ---------- CSV ---------- */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const monthName = (month: number) => MONTH_NAMES[month - 1]!;

export const ANNUAL_COLUMNS: Column[] = [
  { key: "line", label: "Line", kind: "text" },
  { key: "from", label: "From", kind: "date" },
  { key: "to", label: "To", kind: "date" },
  { key: "due", label: "Balances due", kind: "naira" },
  { key: "paid", label: "Paid", kind: "naira" },
  { key: "owed", label: "Still owed", kind: "naira" },
  { key: "received", label: "Money received", kind: "naira" },
  { key: "cash", label: "Cash", kind: "naira" },
  { key: "pos", label: "POS", kind: "naira" },
  { key: "transfer", label: "Transfer", kind: "naira" },
  { key: "forBalances", label: "For balances", kind: "naira" },
  { key: "forFines", label: "For fines", kind: "naira" },
  { key: "loansRepaid", label: "Loans repaid", kind: "naira" },
  { key: "credit", label: "Credit", kind: "naira" },
  { key: "expenses", label: "Expenses", kind: "naira" },
  { key: "loansGiven", label: "Loans given", kind: "naira" },
  { key: "net", label: "Net", kind: "naira" },
  { key: "deposits", label: "Deposits taken", kind: "naira" },
];

function csvRow(line: string, range: DateRange, f: YearFigures) {
  return {
    line,
    from: range.from,
    to: range.to,
    due: f.dueKobo,
    paid: f.paidKobo,
    owed: f.owedKobo,
    received: f.receivedKobo,
    cash: f.cashKobo,
    pos: f.posKobo,
    transfer: f.transferKobo,
    forBalances: f.forBalancesKobo,
    forFines: f.forFinesKobo,
    loansRepaid: f.forLoansKobo,
    credit: f.creditKobo,
    expenses: f.expensesKobo,
    loansGiven: f.loansGivenKobo,
    net: f.netKobo,
    deposits: f.depositsKobo,
  };
}

/** Every week, then its month subtotal, then the year total. */
export function annualRows(report: AnnualBalance) {
  const rows: Record<string, string | number>[] = [];
  for (const month of report.months) {
    if (month.future) continue;
    for (const week of month.weeks) rows.push(csvRow(`Week, ${monthName(month.month)}`, week.range, week.figures));
    rows.push(
      csvRow(`${monthName(month.month)} subtotal`, { from: month.range.from, to: month.weeks.at(-1)!.range.to }, month.figures),
    );
  }
  rows.push(csvRow(`${report.year} total`, { from: `${report.year}-01-01`, to: report.upTo }, report.total));
  return rows;
}
