import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { EXPENSE_CATEGORY_LABELS, LOAN_STATUS_LABELS } from "@/lib/format";
import { requirePermission, type Ctx } from "./context";

export type Column = {
  key: string;
  label: string;
  kind: "text" | "date" | "number" | "naira";
  total?: boolean;
  labels?: Record<string, string>;
};

type Range = { from: string; to: string };

/** How a groupable report adds up its rows. Weeks run Monday to Sunday. */
export const GROUPINGS = ["day", "week", "month", "year"] as const;
export type Grouping = (typeof GROUPINGS)[number];
export const GROUPING_LABELS: Record<Grouping, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };
/** For the quick choices above a groupable report. */
export const GROUPING_TABS: Record<Grouping, string> = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" };

/** Where a report starts when no date is chosen: enough periods to be useful. */
export function defaultFrom(today: string, group: Grouping): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  if (group === "year") return `${year - 4}-01-01`;
  if (group === "month") return `${year}-01-01`;
  if (group === "week") {
    const back = month > 2 ? `${year}-${String(month - 2).padStart(2, "0")}` : `${year - 1}-${String(month + 10).padStart(2, "0")}`;
    return `${back}-01`;
  }
  return `${today.slice(0, 8)}01`;
}
export const parseGrouping = (value: unknown): Grouping =>
  GROUPINGS.includes(value as Grouping) ? (value as Grouping) : "day";

type Report = {
  /** The name in the list of reports. */
  title: string;
  /** The heading once a grouping is chosen, when it differs from the title. */
  heading?: (group: Grouping) => string;
  ranged: boolean;
  /** Only reports that can be added up by week or month offer the choice. */
  groupable?: boolean;
  columns: Column[] | ((group: Grouping) => Column[]);
  query: (range: Range, group: Grouping) => SQL;
};

const between = (column: SQL, { from, to }: Range) => sql`${column} BETWEEN ${from}::date AND ${to}::date`;

const COLLECTION_FIGURES: Column[] = [
  { key: "due", label: "Balances due", kind: "naira", total: true },
  { key: "paid", label: "Paid", kind: "naira", total: true },
  { key: "owed", label: "Owed", kind: "naira", total: true },
  { key: "cash", label: "Cash", kind: "naira", total: true },
  { key: "transfer", label: "Transfer", kind: "naira", total: true },
  { key: "pos", label: "POS", kind: "naira", total: true },
  { key: "collected", label: "Total received", kind: "naira", total: true },
];

const STEP: Record<Grouping, SQL> = {
  day: sql`interval '1 day'`,
  week: sql`interval '7 days'`,
  month: sql`interval '1 month'`,
  year: sql`interval '1 year'`,
};

/** Each day, week, month or year from `from` to `to`, newest last; partial periods cut to the range. */
const periodsCte = ({ from, to }: Range, group: Grouping) => sql`
  periods AS (
    SELECT GREATEST(g::date, ${from}::date) AS lo,
           LEAST((g + ${STEP[group]} - interval '1 day')::date, ${to}::date) AS hi
    FROM generate_series(
      date_trunc(${group}, ${from}::date::timestamp),
      ${to}::date::timestamp,
      ${STEP[group]}
    ) g
  )`;

const periodColumns = (group: Grouping): Column[] =>
  group === "day"
    ? [{ key: "day", label: "Date", kind: "date" }]
    : [
        { key: "day", label: "From", kind: "date" },
        { key: "to", label: "To", kind: "date" },
      ];

const EXPENSE_CATEGORIES = Object.keys(EXPENSE_CATEGORY_LABELS) as (keyof typeof EXPENSE_CATEGORY_LABELS)[];

export const REPORTS = {
  collections: {
    title: "Collections by day, week or month",
    heading: (group) =>
      ({ day: "Daily collections", week: "Weekly collections", month: "Monthly collections", year: "Yearly collections" })[group],
    ranged: true,
    groupable: true,
    columns: (group) =>
      group === "day"
        ? [{ key: "day", label: "Date", kind: "date" }, ...COLLECTION_FIGURES]
        : [{ key: "day", label: "From", kind: "date" }, { key: "to", label: "To", kind: "date" }, ...COLLECTION_FIGURES],
    // Same rules as src/services/balance-periods.ts, so the report and the screens agree.
    // A week or month that runs past the chosen dates is cut to them, so the totals add up to the range.
    query: ({ from, to }, group) => sql`
      WITH periods AS (
        SELECT GREATEST(g::date, ${from}::date) AS lo,
               LEAST((g + ${STEP[group]} - interval '1 day')::date, ${to}::date) AS hi
        FROM generate_series(
          date_trunc(${group}, ${from}::date::timestamp),
          ${to}::date::timestamp,
          ${STEP[group]}
        ) g
      )
      SELECT periods.lo::text AS day, periods.hi::text AS "to",
        b.due, b.paid, b.due - b.paid AS owed,
        m.cash, m.transfer, m.pos, m.collected
      FROM periods
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(c.amount_kobo), 0)::float8 AS due,
               COALESCE(SUM(LEAST(c.amount_kobo, COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                                            WHERE e.charge_id = c.id), 0))), 0)::float8 AS paid
        FROM valid_charges c
        WHERE c.type = 'daily_balance' AND c.business_date BETWEEN periods.lo AND periods.hi
      ) b
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'cash'), 0)::float8 AS cash,
               COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'transfer'), 0)::float8 AS transfer,
               COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'pos'), 0)::float8 AS pos,
               COALESCE(SUM(p.amount_kobo), 0)::float8 AS collected
        FROM payments p
        WHERE p.business_date BETWEEN periods.lo AND periods.hi
          AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
      ) m
      ORDER BY periods.lo DESC`,
  },
  arrears: {
    title: "Unpaid balances",
    ranged: false,
    columns: [
      { key: "name", label: "Operator", kind: "text" },
      { key: "status", label: "Status", kind: "text" },
      { key: "days", label: "Unpaid days", kind: "number", total: true },
      { key: "oldest", label: "Oldest unpaid", kind: "date" },
      { key: "owed", label: "Owed", kind: "naira", total: true },
    ],
    query: () => sql`
      WITH open AS (
        SELECT c.operator_id, c.business_date,
          c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e WHERE e.charge_id = c.id), 0) AS owed
        FROM valid_charges c WHERE c.type = 'daily_balance'
      )
      SELECT o.name, o.status::text AS status, COUNT(*)::int AS days, MIN(open.business_date)::text AS oldest, SUM(open.owed)::float8 AS owed
      FROM open JOIN operators o ON o.id = open.operator_id
      WHERE open.owed > 0 GROUP BY o.id ORDER BY days DESC, o.name`,
  },
  tricycle_income: {
    title: "Income and repair cost per tricycle",
    ranged: true,
    columns: [
      { key: "code", label: "Tricycle", kind: "text" },
      { key: "income", label: "Balances received", kind: "naira", total: true },
      { key: "parts", label: "Parts", kind: "naira", total: true },
      { key: "labour", label: "Labour", kind: "naira", total: true },
      { key: "net", label: "Net", kind: "naira", total: true },
    ],
    query: (range) => sql`
      SELECT code, income, parts, labour, income - parts - labour AS net FROM (
        SELECT t.code_number AS code,
          COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
            JOIN valid_charges c ON c.id = e.charge_id JOIN payments p ON p.id = e.payment_id
            WHERE c.tricycle_id = t.id AND c.type = 'daily_balance' AND ${between(sql`p.business_date`, range)}), 0)::float8 AS income,
          COALESCE((SELECT -SUM(m.cost_kobo) FROM stock_movements m
            WHERE m.tricycle_id = t.id AND m.kind IN ('issued', 'returned') AND ${between(sql`m.business_date`, range)}), 0)::float8 AS parts,
          COALESCE((SELECT SUM(w.labour_cost_kobo) FROM work_orders w
            WHERE w.tricycle_id = t.id AND w.status = 'completed'
              AND ${between(sql`(w.completed_at AT TIME ZONE 'Africa/Lagos')::date`, range)}), 0)::float8 AS labour
        FROM tricycles t
      ) x ORDER BY code`,
  },
  offences_by_rule: {
    title: "Offences by rule",
    ranged: true,
    columns: [
      { key: "name", label: "Rule", kind: "text" },
      { key: "confirmed", label: "Confirmed", kind: "number", total: true },
      { key: "waived", label: "Waived", kind: "number", total: true },
      { key: "rejected", label: "Rejected", kind: "number", total: true },
      { key: "fines", label: "Fines", kind: "naira", total: true },
    ],
    query: (range) => sql`
      SELECT (SELECT r.name FROM rules r WHERE r.code = v.rule_code ORDER BY r.effective_from DESC LIMIT 1) AS name,
        COUNT(*) FILTER (WHERE v.status = 'confirmed')::int AS confirmed,
        COUNT(*) FILTER (WHERE v.status = 'waived')::int AS waived,
        COUNT(*) FILTER (WHERE v.status = 'rejected')::int AS rejected,
        COALESCE(SUM(v.amount_kobo) FILTER (WHERE v.status = 'confirmed'), 0)::float8 AS fines
      FROM violations v WHERE ${between(sql`v.occurred_on`, range)}
      GROUP BY v.rule_code ORDER BY v.rule_code`,
  },
  offences_by_operator: {
    title: "Offences by operator",
    ranged: true,
    columns: [
      { key: "name", label: "Operator", kind: "text" },
      { key: "confirmed", label: "Confirmed", kind: "number", total: true },
      { key: "fines", label: "Fines", kind: "naira", total: true },
    ],
    query: (range) => sql`
      SELECT o.name, COUNT(*)::int AS confirmed, SUM(v.amount_kobo)::float8 AS fines
      FROM violations v JOIN operators o ON o.id = v.operator_id
      WHERE v.status = 'confirmed' AND ${between(sql`v.occurred_on`, range)}
      GROUP BY o.id ORDER BY confirmed DESC, o.name`,
  },
  inspection_coverage: {
    title: "Inspections by supervisor",
    ranged: true,
    columns: [
      { key: "name", label: "Supervisor", kind: "text" },
      { key: "days", label: "Days worked", kind: "number" },
      { key: "total", label: "Inspections", kind: "number", total: true },
      { key: "problems", label: "Problems found", kind: "number", total: true },
    ],
    query: (range) => sql`
      SELECT u.name, COUNT(DISTINCT i.business_date)::int AS days, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE NOT i.washed OR NOT i.sticker_intact)::int AS problems
      FROM inspections i JOIN users u ON u.id = i.inspected_by
      WHERE ${between(sql`i.business_date`, range)}
      GROUP BY u.id ORDER BY total DESC`,
  },
  stock_usage: {
    title: "Store usage",
    ranged: true,
    columns: [
      { key: "name", label: "Item", kind: "text" },
      { key: "unit", label: "Unit", kind: "text" },
      { key: "quantity", label: "Quantity", kind: "number" },
      { key: "cost", label: "Cost", kind: "naira", total: true },
    ],
    query: (range) => sql`
      SELECT i.name, i.unit, (-SUM(m.quantity_milli) / 1000.0)::float8 AS quantity, (-SUM(m.cost_kobo))::float8 AS cost
      FROM stock_movements m JOIN stock_items i ON i.id = m.item_id
      WHERE m.kind = 'issued' AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id)
        AND ${between(sql`m.business_date`, range)}
      GROUP BY i.id ORDER BY i.name`,
  },
  expenses_by_category: {
    title: "Expenses by category",
    ranged: true,
    columns: [
      { key: "category", label: "Category", kind: "text", labels: EXPENSE_CATEGORY_LABELS },
      { key: "entries", label: "Entries", kind: "number", total: true },
      { key: "total", label: "Spent", kind: "naira", total: true },
    ],
    query: (range) => sql`
      SELECT l.category::text AS category, COUNT(*)::int AS entries, SUM(l.amount_kobo)::float8 AS total
      FROM expense_lines l
      JOIN expense_advances a ON a.id = l.advance_id AND a.status <> 'cancelled'
      WHERE l.kind = 'spent' AND ${between(sql`l.spent_on`, range)}
        AND NOT EXISTS (SELECT 1 FROM expense_line_voids v WHERE v.line_id = l.id)
      GROUP BY l.category ORDER BY total DESC`,
  },
  expenses: {
    title: "Expenses by day, week, month or year",
    heading: (group) =>
      ({ day: "Daily expenses", week: "Weekly expenses", month: "Monthly expenses", year: "Yearly expenses" })[group],
    ranged: true,
    groupable: true,
    columns: (group) => [
      ...periodColumns(group),
      { key: "collected", label: "Funds collected", kind: "naira", total: true },
      { key: "spent", label: "Spent", kind: "naira", total: true },
      ...EXPENSE_CATEGORIES.map((category) => ({
        key: category,
        label: EXPENSE_CATEGORY_LABELS[category],
        kind: "naira" as const,
        total: true,
      })),
      { key: "change", label: "Change returned", kind: "naira", total: true },
    ],
    // Same rule as the annual balance: spent lines by the day spent, voided lines and cancelled funds left out.
    // A day with nothing collected, spent or returned is left out; weeks, months and years always show.
    query: (range, group) => sql`
      WITH ${periodsCte(range, group)}
      SELECT * FROM (
        SELECT periods.lo::text AS day, periods.hi::text AS "to",
          (SELECT COALESCE(SUM(a.amount_kobo), 0) FROM expense_advances a
            WHERE a.status <> 'cancelled' AND a.collected_on BETWEEN periods.lo AND periods.hi)::float8 AS collected,
          l.spent, ${sql.join(
            EXPENSE_CATEGORIES.map((category) => sql`${sql.identifier(`c_${category}`)} AS ${sql.identifier(category)}`),
            sql`, `,
          )}, l.change
        FROM periods
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(x.amount_kobo) FILTER (WHERE x.kind = 'spent'), 0)::float8 AS spent,
                 ${sql.join(
                   EXPENSE_CATEGORIES.map(
                     (category) =>
                       sql`COALESCE(SUM(x.amount_kobo) FILTER (WHERE x.kind = 'spent' AND x.category = ${category}), 0)::float8 AS ${sql.identifier(`c_${category}`)}`,
                   ),
                   sql`, `,
                 )},
                 COALESCE(SUM(x.amount_kobo) FILTER (WHERE x.kind = 'change'), 0)::float8 AS change
          FROM expense_lines x
          JOIN expense_advances a ON a.id = x.advance_id AND a.status <> 'cancelled'
          WHERE x.spent_on BETWEEN periods.lo AND periods.hi
            AND NOT EXISTS (SELECT 1 FROM expense_line_voids v WHERE v.line_id = x.id)
        ) l
      ) r
      WHERE ${group !== "day"}::boolean OR r.collected > 0 OR r.spent > 0 OR r.change > 0
      ORDER BY r.day DESC`,
  },
  loan_book: {
    title: "Loan book",
    ranged: false,
    columns: [
      { key: "name", label: "Operator", kind: "text" },
      { key: "status", label: "Status", kind: "text", labels: LOAN_STATUS_LABELS },
      { key: "given_on", label: "Given", kind: "date" },
      { key: "principal", label: "Loan", kind: "naira", total: true },
      { key: "repaid", label: "Repaid", kind: "naira", total: true },
      { key: "owed", label: "Still owed", kind: "naira", total: true },
    ],
    query: () => sql`
      SELECT name, status, given_on, principal, repaid, principal - repaid AS owed FROM (
        SELECT o.name, l.status::text AS status, l.disbursed_on::text AS given_on, l.principal_kobo::float8 AS principal,
          COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e WHERE e.charge_id = l.charge_id), 0)::float8 AS repaid
        FROM loans l JOIN operators o ON o.id = l.operator_id WHERE l.status <> 'cancelled'
      ) x ORDER BY status, given_on DESC`,
  },
  cash_closes: {
    title: "Cash close history",
    ranged: true,
    columns: [
      { key: "day", label: "Date", kind: "date" },
      { key: "name", label: "Held by", kind: "text" },
      { key: "expected", label: "Expected", kind: "naira", total: true },
      { key: "counted", label: "Counted", kind: "naira", total: true },
      { key: "difference", label: "Difference", kind: "naira", total: true },
      { key: "explanation", label: "Explanation", kind: "text" },
      { key: "checked", label: "Checked by", kind: "text" },
    ],
    query: (range) => sql`
      SELECT c.business_date::text AS day, u.name, c.expected_kobo::float8 AS expected, c.counted_kobo::float8 AS counted,
        (c.counted_kobo - c.expected_kobo)::float8 AS difference, COALESCE(c.explanation, '') AS explanation,
        COALESCE(ck.name, '') AS checked
      FROM cash_closes c JOIN users u ON u.id = c.custodian_id
      LEFT JOIN cash_close_checks k ON k.close_id = c.id
      LEFT JOIN users ck ON ck.id = k.checked_by
      WHERE ${between(sql`c.business_date`, range)}
      ORDER BY c.business_date DESC, u.name`,
  },
} satisfies Record<string, Report>;

export type ReportKey = keyof typeof REPORTS;
export const isReportKey = (key: string): key is ReportKey => Object.hasOwn(REPORTS, key);

export async function runReport(ctx: Ctx, key: ReportKey, range: Range, requested: Grouping = "day") {
  requirePermission(ctx, "finance.view");
  const report: Report = REPORTS[key];
  const group = report.groupable ? requested : "day";
  const columns = typeof report.columns === "function" ? report.columns(group) : report.columns;
  const title = report.heading ? report.heading(group) : report.title;
  const rows = (await db.execute(report.query(range, group))) as unknown as Record<string, string | number>[];
  const totals = Object.fromEntries(
    columns
      .filter((column) => column.total)
      .map((column) => [column.key, rows.reduce((sum, row) => sum + Number(row[column.key] ?? 0), 0)]),
  );
  return { title, ranged: report.ranged, groupable: !!report.groupable, group, columns, rows, totals };
}

/** A spreadsheet runs a cell starting with these as a formula, so names are neutralised. */
const neutralise = (text: string) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
const quote = (text: string) => (/[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

export function reportCsv(report: Pick<Awaited<ReturnType<typeof runReport>>, "columns" | "rows">): string {
  const cell = (column: Column, value: string | number | undefined) => {
    if (value === undefined || value === null) return "";
    if (column.kind === "naira") return (Number(value) / 100).toFixed(2);
    if (column.kind === "number") return String(value);
    return quote(neutralise(column.labels?.[String(value)] ?? String(value)));
  };
  const lines = [
    report.columns.map((column) => quote(column.label)).join(","),
    ...report.rows.map((row) => report.columns.map((column) => cell(column, row[column.key])).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
