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
  paymentReferences,
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
import { allocate, allocateBalances, applyCredit, openCharges, syncLoanStatus } from "./ledger";
import { describeLastPayment, dayStatus } from "./day-balance";
import { proposeViolation } from "./violations";
import { notifyOperators } from "./notices";

/** Spaces are ignored and letters uppercased, so the same reference always matches itself. */
export const bankReferenceField = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/\s+/g, "").toUpperCase() || undefined : value),
  z.string().regex(/^[A-Z0-9/-]{4,40}$/, "Enter the reference exactly as the bank or POS shows it").optional(),
);

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
  reference: bankReferenceField,
  /**
   * "day" pays one day's balance (the payment date). "old" pays unpaid days
   * before it, oldest first. "fine" pays fines and "loan" the loan, each on
   * its own. Missing keeps the older mixed rule, recorded as "general".
   */
  purpose: z.enum(["day", "old", "fine", "loan"]).optional(),
});

const PURPOSES = {
  day: "day_balance",
  old: "old_balance",
  fine: "fine",
  loan: "loan",
  general: "general",
} as const;

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

  const purpose = input.purpose ?? "general";
  // Balances, fines and the loan are each paid on their own.
  if (purpose !== "general" && ((input.penaltyAmount ?? 0) > 0 || (input.loanAmount ?? 0) > 0)) {
    throw fieldError(
      "amount",
      purpose === "day"
        ? "Fines and loans are paid separately, not with the day's balance"
        : "Balances, fines and the loan are each paid separately",
    );
  }
  const penaltyAmount = purpose === "fine" ? input.amount : (input.penaltyAmount ?? 0);
  if (penaltyAmount > input.amount) {
    throw fieldError("penaltyAmount", "This cannot be more than the amount paid");
  }

  const receivedAt = input.backdateTo ? new Date(`${input.backdateTo}T12:00:00+01:00`) : now;
  const loanAmount = purpose === "loan" ? input.amount : (input.loanAmount ?? 0);
  if (penaltyAmount + loanAmount > input.amount) {
    throw fieldError("loanAmount", "Penalties and loan together cannot be more than the amount received");
  }

  const paymentDate = input.backdateTo ?? today;
  if (input.method !== "cash" && !input.reference) {
    throw fieldError("reference", "Enter the bank or POS reference");
  }

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
      // Only the daily balance is brought with the tricycle; fines, old days
      // and the loan can be paid at the office without it.
      const askTricycle =
        (purpose === "day" || purpose === "general") &&
        input.method !== "transfer" &&
        !!current &&
        current.status !== "off_road";
      if (askTricycle && !input.tricyclePresent) {
        throw fieldError("tricyclePresent", "Say whether the operator brought the tricycle");
      }

      if (purpose === "day") await checkDayPayment(tx, operator.id, paymentDate, today, input.amount);

      const penalties = await openCharges(tx, operator.id, "penalty");
      const penaltiesOwed = penalties.reduce((sum, c) => sum + c.outstandingKobo, 0);
      if (penaltyAmount > penaltiesOwed) {
        throw fieldError(
          purpose === "fine" ? "amount" : "penaltyAmount",
          penaltiesOwed === 0
            ? "This operator owes no fines"
            : `This operator owes only ${formatNaira(penaltiesOwed)} in ${purpose === "fine" ? "fines" : "penalties"}`,
        );
      }

      const loanCharges = await openCharges(tx, operator.id, "loan");
      const loanOwed = loanCharges.reduce((sum, c) => sum + c.outstandingKobo, 0);
      if (loanAmount > loanOwed) {
        throw fieldError(
          purpose === "loan" ? "amount" : "loanAmount",
          loanOwed === 0 ? "This operator owes nothing on a loan" : `This operator owes only ${formatNaira(loanOwed)} on the loan`,
        );
      }

      // Older days only: today's balance is taken through Take payment.
      const allBalances = await openCharges(tx, operator.id, "daily_balance");
      const balances = purpose === "old" ? allBalances.filter((c) => c.businessDate < paymentDate) : allBalances;
      if (purpose === "old") {
        const olderOwed = balances.reduce((sum, c) => sum + c.outstandingKobo, 0);
        if (olderOwed === 0) throw fieldError("amount", "Nothing is owed for days before today");
        if (input.amount > olderOwed) {
          throw fieldError("amount", `Only ${formatNaira(olderOwed)} is owed for days before today`);
        }
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
          purpose: PURPOSES[purpose],
          forDate: purpose === "day" ? paymentDate : null,
        })
        .returning();

      if (input.method !== "cash") {
        await tx.insert(paymentReferences).values({ paymentId: payment!.id, reference: input.reference! });
      }

      await allocate(tx, payment!.id, penalties, penaltyAmount);
      await allocate(tx, payment!.id, loanCharges, loanAmount);
      await allocateBalances(tx, operator.id, payment!, balances, input.amount - penaltyAmount - loanAmount);
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

      const owed = allBalances.reduce((sum, c) => sum + c.outstandingKobo, 0);
      const paidFor = {
        day: ` for the balance of ${formatDate(paymentDate)}`,
        old: " for older days",
        fine: " for fines",
        loan: " for your loan",
        general: "",
      }[purpose];
      await notifyOperators(tx, now, [
        {
          operatorId: operator.id,
          kind: "receipt",
          body: `${formatNaira(input.amount)} received on ${formatDate(paymentDate)}${paidFor}. Receipt ${payment!.receiptNumber}. Balance still owed: ${formatNaira(owed)}.`,
        },
      ]);

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
    if (asPgError(error)?.constraint_name === "one_live_reference") {
      throw fieldError("reference", "This reference has already been used on another payment or deposit");
    }
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

/**
 * Each tricycle's balance is taken once a day: a payment for a day may cover
 * only what is left of that day's balance. The operator's row is locked, so
 * two staff saving at the same moment cannot both get through.
 */
async function checkDayPayment(tx: Tx, operatorId: string, date: string, today: string, amountKobo: number) {
  const status = await dayStatus(tx, operatorId, date);
  const day = date === today ? "today" : `on ${formatDate(date)}`;
  const balanceOf = date === today ? "Today's balance" : `The balance for ${formatDate(date)}`;
  if (status.dueKobo === null) {
    throw fieldError(
      "amount",
      status.tricycleCode
        ? `No balance is due for ${status.tricycleCode} ${day}`
        : `This operator had no tricycle ${day}, so no balance is due`,
    );
  }
  const code = status.tricycleCode ?? "this tricycle";
  if (status.leftKobo === 0) {
    const last = describeLastPayment(status, formatNaira);
    throw fieldError("amount", `${balanceOf} for ${code} is already paid${last ? `: ${last}` : ""}`);
  }
  if (amountKobo > status.leftKobo) {
    throw fieldError(
      "amount",
      status.paidKobo > 0
        ? `Only ${formatNaira(status.leftKobo)} is left to pay for ${code} ${day}`
        : `The balance for ${code} ${day} is ${formatNaira(status.leftKobo)}. Enter that amount or less.`,
    );
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

    await tx.update(paymentReferences).set({ releasedAt: now }).where(eq(paymentReferences.paymentId, id));

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

/** Where an operator's tricycle stands for one day, for Take payment. */
export async function paymentDayStatus(ctx: Ctx, operatorId: string, date: string) {
  requirePermission(ctx, "payment.record");
  return dayStatus(db, operatorId, date);
}

export type OwedFine = { chargeId: string; ruleCode: string | null; occurredOn: string; outstandingKobo: number };

/** One operator's unpaid fines, oldest first, with the rule each was for. */
export async function finesOwed(ctx: Ctx, operatorId: string): Promise<OwedFine[]> {
  requirePermission(ctx, "payment.record");
  const rows = (await db.execute(sql`
    SELECT c.id, c.business_date::text AS occurred_on, v.rule_code,
           (c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                      WHERE e.charge_id = c.id), 0))::float8 AS outstanding
    FROM valid_charges c
    LEFT JOIN violations v ON v.charge_id = c.id
    WHERE c.operator_id = ${operatorId} AND c.type = 'penalty'
    ORDER BY c.business_date, c.created_at, c.id
  `)) as unknown as { id: string; occurred_on: string; rule_code: string | null; outstanding: number }[];
  return rows
    .filter((row) => row.outstanding > 0)
    .map((row) => ({ chargeId: row.id, ruleCode: row.rule_code, occurredOn: row.occurred_on, outstandingKobo: row.outstanding }));
}

/** Every operator who owes fines, most owed first, for the Offences page. */
export async function operatorsOwingFines(ctx: Ctx) {
  requirePermission(ctx, "violation.view");
  const rows = (await db.execute(sql`
    SELECT o.id, o.name, COUNT(*)::int AS fines, SUM(x.outstanding)::float8 AS owed
    FROM (
      SELECT c.operator_id,
             c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                       WHERE e.charge_id = c.id), 0) AS outstanding
      FROM valid_charges c WHERE c.type = 'penalty'
    ) x
    JOIN operators o ON o.id = x.operator_id
    WHERE x.outstanding > 0
    GROUP BY o.id, o.name
    ORDER BY owed DESC, o.name
  `)) as unknown as { id: string; name: string; fines: number; owed: number }[];
  return rows.map((row) => ({ operatorId: row.id, name: row.name, fines: row.fines, owedKobo: row.owed }));
}

export async function paymentReferenceOf(paymentId: string) {
  const [row] = await db.select().from(paymentReferences).where(eq(paymentReferences.paymentId, paymentId));
  return row ?? null;
}
