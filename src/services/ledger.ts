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
    SELECT p.id,
           (p.amount_kobo - COALESCE((
             SELECT SUM(a.amount_kobo) FROM payment_allocations a
             JOIN valid_charges c ON c.id = a.charge_id
             WHERE a.payment_id = p.id), 0))::float8 AS free
    FROM payments p
    WHERE p.operator_id = ${operatorId}
      AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
    ORDER BY p.received_at, p.id
  `)) as unknown as { id: string; free: number }[];
  return rows.filter((row) => row.free > 0);
}

/**
 * Spends advance payments on daily balances, oldest first. Callers must hold
 * the operator's row lock. Credit never pays a fine without the cashier's say.
 */
export async function applyCredit(tx: Tx, operatorId: string): Promise<void> {
  const credits = await unallocatedPayments(tx, operatorId);
  if (credits.length === 0) return;
  const balances = await openCharges(tx, operatorId, "daily_balance");
  for (const credit of credits) {
    await allocate(tx, credit.id, balances, credit.free);
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
