import { sql } from "drizzle-orm";
import type { Executor, Tx } from "@/db";
import { chargeVoids, paymentAllocations } from "@/db/schema";

/**
 * What an operator owes is always worked out from charges and allocations.
 * Nothing stores a running balance, so there is nothing that can drift.
 */
export type OpenCharge = {
  id: string;
  type: "daily_balance" | "penalty" | "loan";
  amountKobo: number;
  paidKobo: number;
  outstandingKobo: number;
  businessDate: string;
};

export async function openCharges(
  exec: Executor,
  operatorId: string,
  type: OpenCharge["type"],
): Promise<OpenCharge[]> {
  const rows = (await exec.execute(sql`
    SELECT c.id, c.type::text AS type, c.amount_kobo::float8 AS amount,
           c.business_date::text AS business_date,
           COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                     WHERE e.charge_id = c.id), 0)::float8 AS paid
    FROM valid_charges c
    WHERE c.operator_id = ${operatorId} AND c.type = ${type}::charge_type
    ORDER BY c.business_date, c.created_at, c.id
  `)) as unknown as {
    id: string;
    type: OpenCharge["type"];
    amount: number;
    paid: number;
    business_date: string;
  }[];
  return rows
    .map((row) => ({
      id: row.id,
      type: row.type,
      amountKobo: row.amount,
      paidKobo: row.paid,
      outstandingKobo: row.amount - row.paid,
      businessDate: row.business_date,
    }))
    .filter((charge) => charge.outstandingKobo > 0);
}

/** Puts money from a payment against the oldest charges. Returns what is left. */
export async function allocate(
  tx: Tx,
  paymentId: string,
  charges: OpenCharge[],
  amountKobo: number,
): Promise<number> {
  let remaining = amountKobo;
  for (const charge of charges) {
    if (remaining <= 0) break;
    if (charge.outstandingKobo <= 0) continue;
    const applied = Math.min(remaining, charge.outstandingKobo);
    await tx.insert(paymentAllocations).values({
      paymentId,
      chargeId: charge.id,
      amountKobo: applied,
    });
    charge.paidKobo += applied;
    charge.outstandingKobo -= applied;
    remaining -= applied;
  }
  return remaining;
}

/** Payment money not yet attached to any charge that still counts. */
export async function unallocatedPayments(exec: Executor, operatorId: string) {
  const rows = (await exec.execute(sql`
    SELECT p.id, p.purpose::text AS purpose, p.for_date::text AS for_date,
           (p.amount_kobo - COALESCE((
             SELECT SUM(a.amount_kobo) FROM payment_allocations a
             JOIN valid_charges c ON c.id = a.charge_id
             WHERE a.payment_id = p.id), 0))::float8 AS free
    FROM payments p
    WHERE p.operator_id = ${operatorId}
      AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
    ORDER BY p.received_at, p.id
  `)) as unknown as { id: string; purpose: string; for_date: string | null; free: number }[];
  return rows
    .filter((row) => row.free > 0)
    .map((row) => ({ id: row.id, free: row.free, forDate: row.purpose === "day_balance" ? row.for_date : null }));
}

/**
 * Whether a day's balances have been raised for this operator: the nightly job
 * has run for that day, or a balance for it exists. Until then, money paid for
 * that day waits for it.
 */
async function dayIsRaised(exec: Executor, operatorId: string, date: string): Promise<boolean> {
  const [row] = (await exec.execute(sql`
    SELECT EXISTS (SELECT 1 FROM job_runs WHERE job = 'daily' AND business_date = ${date}::date)
        OR EXISTS (SELECT 1 FROM charges WHERE operator_id = ${operatorId}
                   AND type = 'daily_balance' AND business_date = ${date}::date) AS raised
  `)) as unknown as { raised: boolean }[];
  return !!row?.raised;
}

/**
 * Puts payment money on daily balances. Money paid for a day pays that day
 * first, even when older days are unpaid. If that day's balance is not raised
 * yet, the money waits for it. Anything beyond the day, and money not tied to
 * a day, pays the oldest days first. Returns what is left as credit.
 */
export async function allocateBalances(
  tx: Tx,
  operatorId: string,
  payment: { id: string; forDate: string | null },
  balances: OpenCharge[],
  amountKobo: number,
): Promise<number> {
  if (amountKobo <= 0) return 0;
  if (!payment.forDate) return allocate(tx, payment.id, balances, amountKobo);
  const forDate = payment.forDate;
  const left = await allocate(
    tx,
    payment.id,
    balances.filter((charge) => charge.businessDate === forDate),
    amountKobo,
  );
  if (left <= 0 || !(await dayIsRaised(tx, operatorId, forDate))) return left;
  return allocate(tx, payment.id, balances, left);
}

/**
 * Spends credit on daily balances: money paid for a day goes to that day,
 * the rest to the oldest days. Callers must hold the operator's row lock.
 * Credit never pays a fine without the cashier's say.
 */
export async function applyCredit(tx: Tx, operatorId: string): Promise<void> {
  const credits = await unallocatedPayments(tx, operatorId);
  if (credits.length === 0) return;
  const balances = await openCharges(tx, operatorId, "daily_balance");
  for (const credit of credits) {
    await allocateBalances(tx, operatorId, credit, balances, credit.free);
  }
}

export async function voidCharge(
  tx: Tx,
  chargeId: string,
  by: { userId: string | null; at: Date },
  reason: string,
): Promise<void> {
  await tx
    .insert(chargeVoids)
    .values({ chargeId, voidedBy: by.userId, reason, voidedAt: by.at })
    .onConflictDoNothing();
}

export async function voidBalancesAfter(
  tx: Tx,
  operatorId: string,
  assignmentId: string,
  date: string,
  by: { userId: string; at: Date },
): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT c.id FROM valid_charges c
    WHERE c.type = 'daily_balance' AND c.assignment_id = ${assignmentId}
      AND c.business_date > ${date}::date
  `)) as unknown as { id: string }[];
  for (const row of rows) {
    await voidCharge(tx, row.id, by, "Tricycle was returned before this date");
  }
  if (rows.length > 0) await applyCredit(tx, operatorId);
}

/** Start of a Lagos calendar day, as SQL. Payments before it count as earlier. */
const startOf = (date: string) => sql`(${date}::date::timestamp AT TIME ZONE 'Africa/Lagos')`;

/** Daily balances not fully paid by the start of the given date, per operator. */
export async function unpaidDaysAsOf(exec: Executor, date: string) {
  const rows = (await exec.execute(sql`
    SELECT c.operator_id, COUNT(*)::int AS days, MIN(c.business_date)::text AS oldest
    FROM valid_charges c
    WHERE c.type = 'daily_balance' AND c.business_date < ${date}::date
      AND c.amount_kobo > COALESCE((
        SELECT SUM(e.amount_kobo) FROM effective_allocations e
        WHERE e.charge_id = c.id AND e.received_at < ${startOf(date)}), 0)
    GROUP BY c.operator_id
  `)) as unknown as { operator_id: string; days: number; oldest: string }[];
  return new Map(rows.map((row) => [row.operator_id, row]));
}

/** Unpaid daily balances before today. Today's balance is not late yet. */
export async function unpaidDaysBefore(exec: Executor, operatorId: string, today: string) {
  const open = await openCharges(exec, operatorId, "daily_balance");
  return open.filter((charge) => charge.businessDate < today).length;
}

/** Keeps a loan's status in step with what has been repaid. Callers hold the operator's lock. */
export async function syncLoanStatus(tx: Tx, operatorId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE loans l SET status = (CASE
      WHEN COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                     WHERE e.charge_id = l.charge_id), 0) >= l.principal_kobo
      THEN 'cleared' ELSE 'active' END)::loan_status
    WHERE l.operator_id = ${operatorId} AND l.status <> 'cancelled'
  `);
}
