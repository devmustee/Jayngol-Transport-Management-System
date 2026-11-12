import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requirePermission, type Ctx } from "./context";

/**
 * A read-only list for the Manager of payments that may have been taken twice,
 * from before each tricycle's balance was limited to once a day. It changes
 * nothing: mistakes are put right with Reverse payment on each receipt.
 */

export type ReviewPayment = {
  id: string;
  receiptNumber: string;
  amountKobo: number;
  method: string;
  purpose: string;
  receivedAt: Date;
  receivedBy: string;
};

export type RepeatDay = {
  operatorId: string;
  operatorName: string;
  date: string;
  tricycleCode: string | null;
  /** The day's daily balance, or null when none was raised. */
  dueKobo: number | null;
  totalKobo: number;
  /** Two payments of the same amount on the same day: most likely entered twice. */
  sameAmount: boolean;
  payments: ReviewPayment[];
};

export type UnusedCredit = ReviewPayment & {
  operatorId: string;
  operatorName: string;
  businessDate: string;
  unusedKobo: number;
};

const num = (value: unknown) => Number(value ?? 0);

type PaymentRow = {
  id: string;
  receipt_number: string;
  amount: number;
  method: string;
  purpose: string;
  received_at: string | Date;
  received_by: string;
};

const toPayment = (row: PaymentRow): ReviewPayment => ({
  id: row.id,
  receiptNumber: row.receipt_number,
  amountKobo: num(row.amount),
  method: row.method,
  purpose: row.purpose,
  receivedAt: new Date(row.received_at),
  receivedBy: row.received_by,
});

/**
 * Operator-days with more than one live payment that went towards balances.
 * Payments only for fines or the loan are left out: those are paid apart.
 */
export async function repeatPaymentDays(ctx: Ctx): Promise<RepeatDay[]> {
  requirePermission(ctx, "payment.reverse");
  const rows = (await db.execute(sql`
    WITH live AS (
      SELECT p.*, u.name AS received_by_name
      FROM payments p
      JOIN users u ON u.id = p.received_by
      WHERE NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
        AND p.purpose NOT IN ('fine', 'loan')
    ), days AS (
      SELECT operator_id, business_date FROM live
      GROUP BY operator_id, business_date HAVING COUNT(*) > 1
    )
    SELECT d.operator_id, o.name AS operator_name, d.business_date::text AS date,
      (SELECT SUM(c.amount_kobo) FROM valid_charges c WHERE c.operator_id = d.operator_id
         AND c.type = 'daily_balance' AND c.business_date = d.business_date)::float8 AS due,
      (SELECT t.code_number FROM charges c JOIN tricycles t ON t.id = c.tricycle_id
        WHERE c.operator_id = d.operator_id AND c.type = 'daily_balance'
          AND c.business_date = d.business_date LIMIT 1) AS tricycle_code,
      json_agg(json_build_object(
        'id', l.id, 'receipt_number', l.receipt_number, 'amount', l.amount_kobo,
        'method', l.method, 'purpose', l.purpose, 'received_at', l.received_at,
        'received_by', l.received_by_name) ORDER BY l.received_at, l.id) AS payments
    FROM days d
    JOIN operators o ON o.id = d.operator_id
    JOIN live l ON l.operator_id = d.operator_id AND l.business_date = d.business_date
    GROUP BY d.operator_id, o.name, d.business_date
    ORDER BY d.business_date DESC, o.name
  `)) as unknown as {
    operator_id: string;
    operator_name: string;
    date: string;
    due: number | null;
    tricycle_code: string | null;
    payments: PaymentRow[];
  }[];

  return rows.map((row) => {
    const payments = row.payments.map(toPayment);
    const amounts = payments.map((p) => p.amountKobo);
    return {
      operatorId: row.operator_id,
      operatorName: row.operator_name,
      date: row.date,
      tricycleCode: row.tricycle_code,
      dueKobo: row.due === null ? null : num(row.due),
      totalKobo: amounts.reduce((sum, a) => sum + a, 0),
      sameAmount: new Set(amounts).size < amounts.length,
      payments,
    };
  });
}

/** Live payments with money not used on any charge yet, largest first. */
export async function unusedCredit(ctx: Ctx): Promise<UnusedCredit[]> {
  requirePermission(ctx, "payment.reverse");
  const rows = (await db.execute(sql`
    SELECT * FROM (
      SELECT p.id, p.receipt_number, p.amount_kobo::float8 AS amount, p.method::text AS method,
             p.purpose::text AS purpose, p.received_at, u.name AS received_by,
             p.operator_id, o.name AS operator_name, p.business_date::text AS business_date,
             (p.amount_kobo - COALESCE((SELECT SUM(a.amount_kobo) FROM payment_allocations a
                JOIN valid_charges c ON c.id = a.charge_id WHERE a.payment_id = p.id), 0))::float8 AS unused
      FROM payments p
      JOIN users u ON u.id = p.received_by
      JOIN operators o ON o.id = p.operator_id
      WHERE NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
    ) x
    WHERE x.unused > 0
    ORDER BY x.unused DESC, x.received_at DESC
  `)) as unknown as (PaymentRow & {
    operator_id: string;
    operator_name: string;
    business_date: string;
    unused: number;
  })[];
  return rows.map((row) => ({
    ...toPayment(row),
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    businessDate: row.business_date,
    unusedKobo: num(row.unused),
  }));
}
