import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { charges, loans, operators, users } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { idField, optionalText, positiveNairaField, requiredText } from "@/lib/fields";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { moneySourceField, recordMovement, takeMoneyOut } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { voidCharge } from "./ledger";

// Written out in full: Drizzle drops the table name on single-table selects, and
// a bare column here would bind to the inner query instead.
const repaid = sql<number>`COALESCE((
  SELECT SUM(e.amount_kobo) FROM effective_allocations e WHERE e.charge_id = loans.charge_id), 0)::float8`;

const ALREADY = { one_active_loan: fieldError("operatorId", "This operator already has a loan to clear") };

const grantSchema = z.object({
  operatorId: idField("operator"),
  amount: positiveNairaField("Amount"),
  source: moneySourceField,
  note: optionalText(300),
});

/** No interest and no fee: what is owed is exactly what was given. */
export async function grantLoan(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "loan.approve");
  const input = parseInput(grantSchema, raw);
  const now = ctx.clock();
  const today = businessDate(now);
  try {
    return await db.transaction(async (tx) => {
      const [operator] = await tx.select().from(operators).where(eq(operators.id, input.operatorId)).for("update");
      if (!operator) throw new DomainError("Operator not found.");
      if (operator.status !== "active") throw fieldError("operatorId", "Only an active operator can be given a loan");

      const [charge] = await tx
        .insert(charges)
        .values({ type: "loan", operatorId: operator.id, amountKobo: input.amount, businessDate: today })
        .returning({ id: charges.id });
      const [loan] = await tx
        .insert(loans)
        .values({
          operatorId: operator.id,
          chargeId: charge!.id,
          principalKobo: input.amount,
          custodianId: input.source,
          note: input.note ?? null,
          disbursedOn: today,
          approvedBy: ctx.actor.userId,
          createdAt: now,
        })
        .returning({ id: loans.id });
      await takeMoneyOut(tx, {
        custodianId: input.source,
        amountKobo: input.amount,
        sourceType: "loan",
        sourceId: loan!.id,
        at: now,
      });
      await auditFrom(ctx, tx, {
        action: "loan.grant",
        entityType: "operator",
        entityId: operator.id,
        after: { amountKobo: input.amount },
      });
      return loan!;
    });
  } catch (error) {
    rethrowConstraint(error, ALREADY);
  }
}

/** For a loan entered by mistake. Once anything is repaid, it stands. */
export async function cancelLoan(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "loan.approve");
  const id = parseInput(idField("loan"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const [found] = await tx.select({ operatorId: loans.operatorId }).from(loans).where(eq(loans.id, id));
    if (!found) throw new DomainError("Loan not found.");
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, found.operatorId)).for("update");
    const [loan] = await tx.select({ row: loans, repaid }).from(loans).where(eq(loans.id, id)).for("update");
    if (loan!.row.status !== "active") throw new DomainError("Only an active loan can be cancelled.");
    if (loan!.repaid > 0) throw new DomainError("Part of this loan has been repaid, so it cannot be cancelled.");

    await tx.update(loans).set({ status: "cancelled", cancelReason: reason }).where(eq(loans.id, id));
    await voidCharge(tx, loan!.row.chargeId, { userId: ctx.actor.userId, at: now }, reason);
    await recordMovement(tx, {
      custodianId: loan!.row.custodianId,
      amountKobo: loan!.row.principalKobo,
      sourceType: "loan_cancel",
      sourceId: id,
      at: now,
    });
    await auditFrom(ctx, tx, { action: "loan.cancel", entityType: "operator", entityId: found.operatorId, reason });
  });
}

const fields = {
  id: loans.id,
  operatorId: loans.operatorId,
  operatorName: operators.name,
  principalKobo: loans.principalKobo,
  status: loans.status,
  disbursedOn: loans.disbursedOn,
  note: loans.note,
  repaidKobo: repaid,
};

export async function listLoans(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const rows = await db
    .select(fields)
    .from(loans)
    .innerJoin(operators, eq(operators.id, loans.operatorId))
    .orderBy(desc(loans.disbursedOn), desc(loans.createdAt))
    .limit(300);
  const active = rows.filter((row) => row.status === "active");
  return {
    active,
    cleared: rows.filter((row) => row.status === "cleared"),
    outstandingKobo: active.reduce((sum, row) => sum + row.principalKobo - row.repaidKobo, 0),
    canApprove: can(ctx.actor.role, "loan.approve"),
  };
}

/** Active operators free to take a loan. */
export async function operatorsForLoan(ctx: Ctx) {
  requirePermission(ctx, "loan.approve");
  return db
    .select({ id: operators.id, name: operators.name })
    .from(operators)
    .leftJoin(loans, and(eq(loans.operatorId, operators.id), eq(loans.status, "active")))
    .where(and(eq(operators.status, "active"), isNull(loans.id)))
    .orderBy(asc(operators.name));
}

export async function getLoan(ctx: Ctx, id: string) {
  requirePermission(ctx, "finance.view");
  const [loan] = await db
    .select({ ...fields, approvedByName: users.name, cancelReason: loans.cancelReason, chargeId: loans.chargeId })
    .from(loans)
    .innerJoin(operators, eq(operators.id, loans.operatorId))
    .innerJoin(users, eq(users.id, loans.approvedBy))
    .where(eq(loans.id, id))
    .limit(1);
  if (!loan) return null;
  const repayments = (await db.execute(sql`
    SELECT p.id, p.receipt_number, p.business_date::text AS date, a.amount_kobo::float8 AS amount,
           EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id) AS reversed
    FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
    WHERE a.charge_id = ${loan.chargeId}
    ORDER BY p.received_at DESC
  `)) as unknown as { id: string; receipt_number: string; date: string; amount: number; reversed: boolean }[];
  return {
    loan,
    repayments,
    owedKobo: loan.status === "cancelled" ? 0 : loan.principalKobo - loan.repaidKobo,
    canApprove: can(ctx.actor.role, "loan.approve"),
    canCollect: can(ctx.actor.role, "payment.record"),
  };
}
