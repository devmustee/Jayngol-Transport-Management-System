import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import {
  assignments,
  bankMovements,
  cashMovements,
  charges,
  lateEvaluations,
  operators,
  paymentAllocations,
  paymentReversals,
  payments,
  smsOutbox,
  tricycles,
  users,
} from "@/db/schema";
import { addDays, businessDate } from "@/lib/clock";
import { DomainError, fieldError, ForbiddenError, parseInput, asPgError, rethrowConstraint } from "@/lib/errors";
import {
  dateField,
  idField,
  optionalNairaField,
  optionalText,
  positiveNairaField,
  requiredText,
} from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { cashDate } from "./cash-book";
import { allocate, applyCredit, openCharges, syncLoanStatus } from "./ledger";
import { proposeViolation } from "./violations";

const paymentSchema = z.object({
  operatorId: idField("operator"),
  clientId: z.uuid(),
  amount: positiveNairaField("Amount"),
  method: z.enum(["cash", "transfer", "pos"], "Choose how the money was paid"),
  tricyclePresent: z.enum(["yes", "no"]).optional(),
  penaltyAmount: optionalNairaField("Amount for penalties"),
  loanAmount: optionalNairaField("Amount for the loan"),
  backdateTo: z.preprocess((v) => (v === "" ? undefined : v), dateField("Payment date").optional()),
  backdateReason: optionalText(),
});

export async function recordPayment(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "payment.record");
  const input = parseInput(paymentSchema, raw);
  const now = ctx.clock();
  const today = businessDate(now);

  if (input.backdateTo || input.backdateReason) {
    if (!can(ctx.actor.role, "payment.backdate")) throw new ForbiddenError();
    if (!input.backdateTo) throw fieldError("backdateTo", "Choose the date the money was received");
    if (!input.backdateReason) throw fieldError("backdateReason", "A reason is required to backdate");
    if (input.backdateTo > today) throw fieldError("backdateTo", "Payment date cannot be in the future");
  }

  const penaltyAmount = input.penaltyAmount ?? 0;
  if (penaltyAmount > input.amount) {
    throw fieldError("penaltyAmount", "This cannot be more than the amount paid");
  }

  const receivedAt = input.backdateTo ? new Date(`${input.backdateTo}T12:00:00+01:00`) : now;
  const loanAmount = input.loanAmount ?? 0;
  if (penaltyAmount + loanAmount > input.amount) {
    throw fieldError("loanAmount", "Penalties and loan together cannot be more than the amount received");
  }

  const paymentDate = input.backdateTo ?? today;

  try {
    return await db.transaction(async (tx) => {
      const [operator] = await tx
        .select()
        .from(operators)
        .where(eq(operators.id, input.operatorId))
        .for("update");
      if (!operator) throw new DomainError("Operator not found.");

      const [existing] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.clientId, input.clientId));
      if (existing) return existing;

      const [current] = await tx
        .select({ tricycleId: assignments.tricycleId, status: tricycles.status })
        .from(assignments)
        .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
        .where(and(eq(assignments.operatorId, operator.id), isNull(assignments.returnedOn)))
        .limit(1);

      // Without a working tricycle there is nothing the operator could bring.
      const askTricycle = input.method !== "transfer" && !!current && current.status !== "off_road";
      if (askTricycle && !input.tricyclePresent) {
        throw fieldError("tricyclePresent", "Say whether the operator brought the tricycle");
      }

      const penalties = await openCharges(tx, operator.id, "penalty");
      const penaltiesOwed = penalties.reduce((sum, c) => sum + c.outstandingKobo, 0);
      if (penaltyAmount > penaltiesOwed) {
        throw fieldError(
          "penaltyAmount",
          `This operator owes only ${formatNaira(penaltiesOwed)} in penalties`,
        );
      }

      const loanCharges = await openCharges(tx, operator.id, "loan");
      const loanOwed = loanCharges.reduce((sum, c) => sum + c.outstandingKobo, 0);
      if (loanAmount > loanOwed) {
        throw fieldError("loanAmount", `This operator owes only ${formatNaira(loanOwed)} on the loan`);
      }

      const seq = (await tx.execute(sql`SELECT nextval('receipt_seq')::int AS n`)) as unknown as {
        n: number;
      }[];
      const [payment] = await tx
        .insert(payments)
        .values({
          operatorId: operator.id,
          amountKobo: input.amount,
          method: input.method,
          receivedAt,
          businessDate: paymentDate,
          receivedBy: ctx.actor.userId,
          tricyclePresent: askTricycle ? input.tricyclePresent === "yes" : null,
          receiptNumber: `R-${String(seq[0]!.n).padStart(6, "0")}`,
          clientId: input.clientId,
          backdateReason: input.backdateReason ?? null,
        })
        .returning();

      await allocate(tx, payment!.id, penalties, penaltyAmount);
      const balances = await openCharges(tx, operator.id, "daily_balance");
      await allocate(tx, payment!.id, loanCharges, loanAmount);
      await allocate(tx, payment!.id, balances, input.amount - penaltyAmount - loanAmount);
      if (loanAmount > 0) await syncLoanStatus(tx, operator.id);

      if (input.method === "cash") {
        await tx.insert(cashMovements).values({
          custodianId: ctx.actor.userId,
          amountKobo: input.amount,
          businessDate: await cashDate(tx, ctx.actor.userId, today),
          sourceType: "payment",
          sourceId: payment!.id,
          at: now,
        });
      } else {
        await tx.insert(bankMovements).values({
          amountKobo: input.amount,
          businessDate: paymentDate,
          sourceType: "payment",
          sourceId: payment!.id,
          at: now,
        });
      }

      if (askTricycle && input.tricyclePresent === "no") {
        await proposeViolation(tx, ctx, {
          ruleCode: "R8",
          operatorId: operator.id,
          tricycleId: current!.tricycleId,
          occurredOn: today,
          occurrenceKey: `R8:${operator.id}:${today}`,
        });
      }

      const owed = balances.reduce((sum, c) => sum + c.outstandingKobo, 0);
      await tx.insert(smsOutbox).values({
        toPhone: operator.phone,
        kind: "receipt",
        createdAt: now,
        body: `Jayngol: ${formatNaira(input.amount)} received on ${formatDate(paymentDate)}. Receipt ${payment!.receiptNumber}. Balance still owed: ${formatNaira(owed)}.`,
      });

      await auditFrom(ctx, tx, {
        action: input.backdateTo ? "payment.record_backdated" : "payment.record",
        entityType: "payment",
        entityId: payment!.id,
        after: {
          operatorId: operator.id,
          amountKobo: input.amount,
          method: input.method,
          receiptNumber: payment!.receiptNumber,
        },
        reason: input.backdateReason,
      });
      return { id: payment!.id };
    });
  } catch (error) {
    // Two identical submissions raced: the winner's payment is the answer.
    if (asPgError(error)?.constraint_name === "payments_client_unique") {
      const [winner] = await db
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.clientId, input.clientId));
      if (winner) return winner;
    }
    throw error;
  }
}

export async function reversePayment(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "payment.reverse");
  const id = parseInput(idField("payment"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  const now = ctx.clock();

  await db.transaction(async (tx) => {
    const [found] = await tx.select().from(payments).where(eq(payments.id, id));
    if (!found) throw new DomainError("Payment not found.");
    await tx
      .select({ id: operators.id })
      .from(operators)
      .where(eq(operators.id, found.operatorId))
      .for("update");

    const [already] = await tx
      .select({ id: paymentReversals.paymentId })
      .from(paymentReversals)
      .where(eq(paymentReversals.paymentId, id));
    if (already) throw new DomainError("This payment has already been reversed.");

    await tx.insert(paymentReversals).values({
      paymentId: id,
      reversedBy: ctx.actor.userId,
      reason,
      reversedAt: now,
    });

    if (found.method === "cash") {
      await tx.insert(cashMovements).values({
        custodianId: found.receivedBy,
        amountKobo: -found.amountKobo,
        businessDate: await cashDate(tx, found.receivedBy, businessDate(now)),
        sourceType: "payment_reversal",
        sourceId: id,
        at: now,
      });
    } else {
      await tx.insert(bankMovements).values({
        amountKobo: -found.amountKobo,
        businessDate: businessDate(now),
        sourceType: "payment_reversal",
        sourceId: id,
        at: now,
      });
    }

    try {
      await syncLoanStatus(tx, found.operatorId);
    } catch (error) {
      rethrowConstraint(error, {
        one_active_loan: new DomainError(
          "This payment cleared an earlier loan and the operator now has a new one. Cancel or clear the new loan first.",
        ),
      });
    }

    // A balance this payment had kept on time must be judged again tonight.
    const affected = await tx
      .select({ chargeId: paymentAllocations.chargeId })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, id));
    for (const { chargeId } of affected) {
      await tx
        .delete(lateEvaluations)
        .where(and(eq(lateEvaluations.chargeId, chargeId), eq(lateEvaluations.outcome, "on_time")));
    }

    await applyCredit(tx, found.operatorId);
    await auditFrom(ctx, tx, {
      action: "payment.reverse",
      entityType: "payment",
      entityId: id,
      before: { amountKobo: found.amountKobo, receiptNumber: found.receiptNumber },
      reason,
    });
  });
}

export async function getPayment(ctx: Ctx, id: string) {
  requirePermission(ctx, "finance.view");
  const [row] = await db
    .select({
      payment: payments,
      operatorName: operators.name,
      receivedByName: users.name,
      reversalReason: paymentReversals.reason,
      reversedAt: paymentReversals.reversedAt,
    })
    .from(payments)
    .innerJoin(operators, eq(operators.id, payments.operatorId))
    .innerJoin(users, eq(users.id, payments.receivedBy))
    .leftJoin(paymentReversals, eq(paymentReversals.paymentId, payments.id))
    .where(eq(payments.id, id))
    .limit(1);
  if (!row) return null;

  const lines = await db
    .select({
      amountKobo: paymentAllocations.amountKobo,
      type: charges.type,
      businessDate: charges.businessDate,
    })
    .from(paymentAllocations)
    .innerJoin(charges, eq(charges.id, paymentAllocations.chargeId))
    .where(eq(paymentAllocations.paymentId, id))
    .orderBy(charges.businessDate);
  const allocated = lines.reduce((sum, line) => sum + line.amountKobo, 0);
  return { ...row, lines, creditKobo: row.payment.amountKobo - allocated };
}

export async function listPayments(ctx: Ctx, date: string) {
  requirePermission(ctx, "finance.view");
  return db
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      amountKobo: payments.amountKobo,
      method: payments.method,
      receivedAt: payments.receivedAt,
      operatorName: operators.name,
      reversed: paymentReversals.paymentId,
    })
    .from(payments)
    .innerJoin(operators, eq(operators.id, payments.operatorId))
    .leftJoin(paymentReversals, eq(paymentReversals.paymentId, payments.id))
    .where(eq(payments.businessDate, date))
    .orderBy(desc(payments.receivedAt));
}

/** Everything the payment screen needs to show about one operator. */
export async function paymentContext(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "payment.record");
  const [operator] = await db.select().from(operators).where(eq(operators.id, operatorId)).limit(1);
  if (!operator) return null;
  const [current] = await db
    .select({
      codeNumber: tricycles.codeNumber,
      status: tricycles.status,
    })
    .from(assignments)
    .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
    .where(and(eq(assignments.operatorId, operatorId), isNull(assignments.returnedOn)))
    .limit(1);
  const [balances, penalties, loanCharges] = await Promise.all([
    openCharges(db, operatorId, "daily_balance"),
    openCharges(db, operatorId, "penalty"),
    openCharges(db, operatorId, "loan"),
  ]);
  return {
    operator,
    current: current ?? null,
    balances,
    balanceOwedKobo: balances.reduce((s, c) => s + c.outstandingKobo, 0),
    penaltiesOwedKobo: penalties.reduce((s, c) => s + c.outstandingKobo, 0),
    loanOwedKobo: loanCharges.reduce((s, c) => s + c.outstandingKobo, 0),
  };
}
