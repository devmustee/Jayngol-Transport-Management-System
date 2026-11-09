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
type Report = { title: string; ranged: boolean; columns: Column[]; query: (range: Range) => SQL };

const between = (column: SQL, { from, to }: Range) => sql`${column} BETWEEN ${from}::date AND ${to}::date`;

export const REPORTS = {
  collections: {
    title: "Daily collections",
    ranged: true,
    columns: [
      { key: "day", label: "Date", kind: "date" },
      { key: "due", label: "Balances due", kind: "naira", total: true },
      { key: "cash", label: "Cash", kind: "naira", total: true },
      { key: "transfer", label: "Transfer", kind: "naira", total: true },
      { key: "pos", label: "POS", kind: "naira", total: true },
      { key: "collected", label: "Total received", kind: "naira", total: true },
    ],
    query: ({ from, to }) => sql`
      SELECT d::date::text AS day,
        COALESCE((SELECT SUM(c.amount_kobo) FROM valid_charges c WHERE c.type = 'daily_balance' AND c.business_date = d::date), 0)::float8 AS due,
        COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'cash'), 0)::float8 AS cash,
        COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'transfer'), 0)::float8 AS transfer,
        COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.method = 'pos'), 0)::float8 AS pos,
        COALESCE(SUM(p.amount_kobo), 0)::float8 AS collected
      FROM generate_series(${from}::date, ${to}::date, interval '1 day') d
      LEFT JOIN payments p ON p.business_date = d::date
        AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
      GROUP BY d ORDER BY d DESC`,
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
    ],
    query: (range) => sql`
      SELECT c.business_date::text AS day, u.name, c.expected_kobo::float8 AS expected, c.counted_kobo::float8 AS counted,
        (c.counted_kobo - c.expected_kobo)::float8 AS difference, COALESCE(c.explanation, '') AS explanation
      FROM cash_closes c JOIN users u ON u.id = c.custodian_id
      WHERE ${between(sql`c.business_date`, range)}
      ORDER BY c.business_date DESC, u.name`,
  },
} satisfies Record<string, Report>;

export type ReportKey = keyof typeof REPORTS;
export const isReportKey = (key: string): key is ReportKey => Object.hasOwn(REPORTS, key);

export async function runReport(ctx: Ctx, key: ReportKey, range: Range) {
  requirePermission(ctx, "finance.view");
  const report: Report = REPORTS[key];
  const rows = (await db.execute(report.query(range))) as unknown as Record<string, string | number>[];
  const totals = Object.fromEntries(
    report.columns
      .filter((column) => column.total)
      .map((column) => [column.key, rows.reduce((sum, row) => sum + Number(row[column.key] ?? 0), 0)]),
  );
  return { title: report.title, ranged: report.ranged, columns: report.columns, rows, totals };
}

/** A spreadsheet runs a cell starting with these as a formula, so names are neutralised. */
const neutralise = (text: string) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
const quote = (text: string) => (/[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

export function reportCsv(report: Awaited<ReturnType<typeof runReport>>): string {
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
