import { sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { rateOn } from "./assignments";

/**
 * One operator's daily balance for one day: what is due, what has been paid
 * towards it and by which receipts, and what is left. Each tricycle's balance
 * is taken once a day, so Take payment never accepts more than what is left.
 *
 * Before the nightly job raises the day, the amount due is the tricycle's rate
 * for that day, under the same conditions the job uses, and money already
 * taken for the day is waiting for it.
 */

export type DayPayment = {
  receiptNumber: string;
  /** What this payment put towards the day. */
  amountKobo: number;
  receivedAt: Date;
  receivedBy: string;
};

export type DayStatus = {
  date: string;
  /** The tricycle the operator held that day, if any. */
  tricycleCode: string | null;
  /** Null when no balance is due that day: no tricycle, a holiday, the workshop. */
  dueKobo: number | null;
  paidKobo: number;
  leftKobo: number;
  /** Whether the nightly job has raised the day's balance yet. */
  raised: boolean;
  payments: DayPayment[];
};

const num = (value: unknown) => Number(value ?? 0);

export async function dayStatus(exec: Executor, operatorId: string, date: string): Promise<DayStatus> {
  const [state] = (await exec.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM job_runs WHERE job = 'daily' AND business_date = ${date}::date) AS job_ran,
      (SELECT COUNT(*) FROM charges WHERE operator_id = ${operatorId}
         AND type = 'daily_balance' AND business_date = ${date}::date)::int AS charges,
      (SELECT COALESCE(SUM(c.amount_kobo), 0) FROM valid_charges c WHERE c.operator_id = ${operatorId}
         AND c.type = 'daily_balance' AND c.business_date = ${date}::date)::float8 AS due,
      (SELECT COALESCE(SUM(e.amount_kobo), 0) FROM effective_allocations e
         JOIN valid_charges c ON c.id = e.charge_id
        WHERE c.operator_id = ${operatorId} AND c.type = 'daily_balance'
          AND c.business_date = ${date}::date)::float8 AS paid
  `)) as unknown as { job_ran: boolean; charges: number; due: number; paid: number }[];

  // The assignment that covered the day: issued before it, not returned before it.
  const [held] = (await exec.execute(sql`
    SELECT a.id, t.code_number,
      (o.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM non_collection_days n WHERE n.business_date = ${date}::date)
        AND NOT EXISTS (SELECT 1 FROM off_road_periods p WHERE p.tricycle_id = t.id
                          AND p.starts_on < ${date}::date
                          AND (p.ends_on IS NULL OR p.ends_on >= ${date}::date))) AS chargeable
    FROM assignments a
    JOIN tricycles t ON t.id = a.tricycle_id
    JOIN operators o ON o.id = a.operator_id
    WHERE a.operator_id = ${operatorId} AND a.issued_on < ${date}::date
      AND (a.returned_on IS NULL OR a.returned_on >= ${date}::date)
    ORDER BY a.issued_on DESC
    LIMIT 1
  `)) as unknown as { id: string; code_number: string; chargeable: boolean }[];

  const raised = !!state?.job_ran || num(state?.charges) > 0;
  let dueKobo: number | null;
  let paidKobo: number;
  if (raised) {
    dueKobo = num(state?.due) > 0 ? num(state?.due) : null;
    paidKobo = num(state?.paid);
  } else {
    dueKobo = held?.chargeable ? await rateOn(exec, held.id, date) : null;
    // Money taken for the day waits for it, unallocated.
    const [waiting] = (await exec.execute(sql`
      SELECT COALESCE(SUM(p.amount_kobo - COALESCE((
               SELECT SUM(a.amount_kobo) FROM payment_allocations a
               JOIN valid_charges c ON c.id = a.charge_id WHERE a.payment_id = p.id), 0)), 0)::float8 AS waiting
      FROM payments p
      WHERE p.operator_id = ${operatorId} AND p.purpose = 'day_balance' AND p.for_date = ${date}::date
        AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
    `)) as unknown as { waiting: number }[];
    paidKobo = num(waiting?.waiting);
  }

  const payments = (await exec.execute(sql`
    SELECT p.receipt_number, p.received_at, u.name AS received_by,
      CASE WHEN ${raised}::boolean
        THEN (SELECT COALESCE(SUM(e.amount_kobo), 0) FROM effective_allocations e
                JOIN valid_charges c ON c.id = e.charge_id
               WHERE e.payment_id = p.id AND c.type = 'daily_balance' AND c.business_date = ${date}::date)
        ELSE p.amount_kobo END::float8 AS amount
    FROM payments p
    JOIN users u ON u.id = p.received_by
    WHERE p.operator_id = ${operatorId}
      AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
      AND ((p.purpose = 'day_balance' AND p.for_date = ${date}::date)
           OR EXISTS (SELECT 1 FROM effective_allocations e JOIN valid_charges c ON c.id = e.charge_id
                       WHERE e.payment_id = p.id AND c.type = 'daily_balance'
                         AND c.business_date = ${date}::date))
    ORDER BY p.received_at, p.id
  `)) as unknown as { receipt_number: string; received_at: string | Date; received_by: string; amount: number }[];

  return {
    date,
    tricycleCode: held?.code_number ?? null,
    dueKobo,
    paidKobo,
    leftKobo: dueKobo === null ? 0 : Math.max(0, dueKobo - paidKobo),
    raised,
    payments: payments
      .filter((p) => num(p.amount) > 0)
      .map((p) => ({
        receiptNumber: p.receipt_number,
        amountKobo: num(p.amount),
        receivedAt: new Date(p.received_at),
        receivedBy: p.received_by,
      })),
  };
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" });

/** "₦12,000 at 9:14 by Amina Yusuf (receipt R-000123)", for the latest payment. */
export function describeLastPayment(status: DayStatus, formatNaira: (kobo: number) => string): string {
  const last = status.payments.at(-1);
  if (!last) return "";
  return `${formatNaira(last.amountKobo)} at ${timeFormat.format(last.receivedAt)} by ${last.receivedBy} (receipt ${last.receiptNumber})`;
}
