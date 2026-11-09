import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db";
import { bankMovements, bankReconciliations, operatorDeposits, paymentReferences, payments } from "@/db/schema";
import { addMonths, businessDate } from "@/lib/clock";
import { asPgError, DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField, idField, nairaField, optionalText } from "@/lib/fields";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";

/** Only "the other person" can confirm money against the statement. */
export async function confirmBankPayment(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "bank.reconcile");
  const paymentId = parseInput(idField("payment"), rawId);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ receivedBy: payments.receivedBy, released: paymentReferences.releasedAt, confirmed: paymentReferences.confirmedAt })
      .from(paymentReferences)
      .innerJoin(payments, eq(payments.id, paymentReferences.paymentId))
      .where(eq(paymentReferences.paymentId, paymentId))
      .for("update", { of: paymentReferences });
    if (!row || row.released) throw new DomainError("This payment is no longer on record.");
    if (row.confirmed) throw new DomainError("This payment has already been confirmed.");
    if (row.receivedBy === ctx.actor.userId) throw new DomainError("A different person must confirm a payment you recorded.");
    await tx
      .update(paymentReferences)
      .set({ confirmedBy: ctx.actor.userId, confirmedAt: now })
      .where(and(eq(paymentReferences.paymentId, paymentId), isNull(paymentReferences.confirmedAt)));
    await auditFrom(ctx, tx, { action: "bank.confirm", entityType: "payment", entityId: paymentId });
  });
}

export async function confirmBankDeposit(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "bank.reconcile");
  const depositId = parseInput(idField("deposit"), rawId);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ receivedBy: operatorDeposits.receivedBy, released: paymentReferences.releasedAt, confirmed: paymentReferences.confirmedAt })
      .from(paymentReferences)
      .innerJoin(operatorDeposits, eq(operatorDeposits.id, paymentReferences.depositId))
      .where(eq(paymentReferences.depositId, depositId))
      .for("update", { of: paymentReferences });
    if (!row || row.released) throw new DomainError("This deposit is no longer on record.");
    if (row.confirmed) throw new DomainError("This deposit has already been confirmed.");
    if (row.receivedBy === ctx.actor.userId) throw new DomainError("A different person must confirm a deposit you recorded.");
    await tx
      .update(paymentReferences)
      .set({ confirmedBy: ctx.actor.userId, confirmedAt: now })
      .where(and(eq(paymentReferences.depositId, depositId), isNull(paymentReferences.confirmedAt)));
    await auditFrom(ctx, tx, { action: "bank.confirm", entityType: "operator_deposit", entityId: depositId });
  });
}

const openingSchema = z.object({ amount: nairaField("Opening balance"), date: dateField("Date") });

export async function setOpeningBalance(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "bank.opening");
  const input = parseInput(openingSchema, raw);
  if (input.date > businessDate(ctx.clock())) throw fieldError("date", "The date cannot be in the future");
  try {
    await db.transaction(async (tx) => {
      await tx.insert(bankMovements).values({
        amountKobo: input.amount,
        businessDate: input.date,
        sourceType: "opening_balance",
        sourceId: "opening",
        at: ctx.clock(),
      });
      await auditFrom(ctx, tx, {
        action: "bank.opening",
        entityType: "bank",
        entityId: "opening",
        after: { amountKobo: input.amount, date: input.date },
      });
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "one_opening_balance") {
      throw new DomainError("The opening balance has already been set.");
    }
    throw error;
  }
}

async function bookAt(exec: Executor, before: string) {
  const rows = (await exec.execute(sql`
    SELECT
      (SELECT COALESCE(SUM(amount_kobo), 0)::float8 FROM bank_movements
        WHERE account = 'bank' AND business_date < ${before}::date) AS book,
      (SELECT COALESCE(SUM(COALESCE(p.amount_kobo, d.amount_kobo)), 0)::float8 FROM payment_references r
        LEFT JOIN payments p ON p.id = r.payment_id
        LEFT JOIN operator_deposits d ON d.id = r.deposit_id
        WHERE r.released_at IS NULL AND r.confirmed_at IS NULL
          AND COALESCE(p.business_date, d.business_date) < ${before}::date) AS unconfirmed
  `)) as unknown as { book: number; unconfirmed: number }[];
  return { bookKobo: rows[0]?.book ?? 0, unconfirmedKobo: rows[0]?.unconfirmed ?? 0 };
}

const reconcileSchema = z.object({
  month: z.string("Choose the month").regex(/^\d{4}-\d{2}$/, "Choose the month"),
  statement: nairaField("Statement balance"),
  explanation: optionalText(),
});

/** Compares the month-end book balance with the bank's own figure and freezes the result. */
export async function recordReconciliation(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "bank.reconcile");
  const input = parseInput(reconcileSchema, raw);
  const first = `${input.month}-01`;
  const next = addMonths(first, 1);
  if (next > businessDate(ctx.clock())) throw fieldError("month", "You can only reconcile a month that has ended");
  try {
    await db.transaction(async (tx) => {
      const { bookKobo, unconfirmedKobo } = await bookAt(tx, next);
      if (input.statement !== bookKobo && !input.explanation) {
        throw fieldError("explanation", "Explain the difference");
      }
      await tx.insert(bankReconciliations).values({
        month: first,
        statementKobo: input.statement,
        bookKobo,
        unconfirmedKobo,
        explanation: input.explanation ?? null,
        recordedBy: ctx.actor.userId,
        createdAt: ctx.clock(),
      });
      await auditFrom(ctx, tx, {
        action: "bank.reconcile",
        entityType: "bank",
        entityId: first,
        after: { statementKobo: input.statement, bookKobo, unconfirmedKobo },
        reason: input.explanation,
      });
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "bank_reconciliations_month_unique") {
      throw fieldError("month", "This month has already been reconciled");
    }
    throw error;
  }
}

export async function bankPosition(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const [toConfirm, opening, history, position] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(p.id, d.id) AS id, CASE WHEN r.deposit_id IS NULL THEN 'payment' ELSE 'deposit' END AS kind,
             COALESCE(p.receipt_number, d.receipt_number) AS receipt,
             COALESCE(p.amount_kobo, d.amount_kobo)::float8 AS amount,
             COALESCE(p.method, d.method)::text AS method,
             COALESCE(p.business_date, d.business_date)::text AS date,
             COALESCE(p.received_by, d.received_by) AS received_by, r.reference, o.name AS operator
      FROM payment_references r
      LEFT JOIN payments p ON p.id = r.payment_id
      LEFT JOIN operator_deposits d ON d.id = r.deposit_id
      JOIN operators o ON o.id = COALESCE(p.operator_id, d.operator_id)
      WHERE r.released_at IS NULL AND r.confirmed_at IS NULL
      ORDER BY date, receipt LIMIT 60
    `),
    db.select({ id: bankMovements.id }).from(bankMovements).where(eq(bankMovements.sourceType, "opening_balance")).limit(1),
    db.select().from(bankReconciliations).orderBy(desc(bankReconciliations.month)).limit(24),
    bookAt(db, "infinity"),
  ]);
  return {
    today,
    ...position,
    toConfirm: toConfirm as unknown as {
      id: string;
      kind: "payment" | "deposit";
      receipt: string;
      amount: number;
      method: string;
      date: string;
      received_by: string;
      reference: string;
      operator: string;
    }[],
    hasOpening: opening.length > 0,
    history,
    userId: ctx.actor.userId,
    canReconcile: can(ctx.actor.role, "bank.reconcile"),
    canSetOpening: can(ctx.actor.role, "bank.opening"),
    lastMonth: addMonths(today, -1).slice(0, 7),
  };
}
