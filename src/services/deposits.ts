import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db";
import {
  bankMovements,
  cashMovements,
  operatorDepositReversals,
  operatorDeposits,
  operators,
  paymentReferences,
  users,
} from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { asPgError, DomainError, fieldError, parseInput } from "@/lib/errors";
import { idField, positiveNairaField, requiredText } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { auditFrom } from "./audit";
import { cashDate } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { notifyOperators } from "./notices";
import { bankReferenceField } from "./payments";

const depositSchema = z.object({
  operatorId: idField("operator"),
  clientId: z.uuid(),
  amount: positiveNairaField("Amount"),
  method: z.enum(["cash", "transfer", "pos"], "Choose how the money was paid"),
  reference: bankReferenceField,
});

/**
 * A deposit is held for the operator: it joins the cash or bank trail like any
 * other money, but it is not a payment, so it never counts as a collection or
 * settles a charge.
 */
export async function recordDeposit(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "payment.record");
  const input = parseInput(depositSchema, raw);
  if (input.method !== "cash" && !input.reference) {
    throw fieldError("reference", "Enter the bank or POS reference");
  }
  const now = ctx.clock();
  const today = businessDate(now);

  try {
    return await db.transaction(async (tx) => {
      const [operator] = await tx
        .select({ id: operators.id, status: operators.status })
        .from(operators)
        .where(eq(operators.id, input.operatorId))
        .for("update");
      if (!operator) throw new DomainError("Operator not found.");

      const [existing] = await tx
        .select({ id: operatorDeposits.id })
        .from(operatorDeposits)
        .where(eq(operatorDeposits.clientId, input.clientId));
      if (existing) return existing;

      if (operator.status !== "active") throw new DomainError("Only an active operator can make a deposit.");

      const seq = (await tx.execute(sql`SELECT nextval('deposit_receipt_seq')::int AS n`)) as unknown as { n: number }[];
      const receiptNumber = `DEP-${String(seq[0]!.n).padStart(6, "0")}`;
      const [deposit] = await tx
        .insert(operatorDeposits)
        .values({
          clientId: input.clientId,
          operatorId: operator.id,
          amountKobo: input.amount,
          method: input.method,
          receiptNumber,
          receivedBy: ctx.actor.userId,
          receivedAt: now,
          businessDate: today,
        })
        .returning({ id: operatorDeposits.id });

      if (input.method === "cash") {
        await tx.insert(cashMovements).values({
          custodianId: ctx.actor.userId,
          amountKobo: input.amount,
          businessDate: await cashDate(tx, ctx.actor.userId, today),
          sourceType: "deposit",
          sourceId: deposit!.id,
          at: now,
        });
      } else {
        await tx.insert(paymentReferences).values({ depositId: deposit!.id, reference: input.reference! });
        await tx.insert(bankMovements).values({
          amountKobo: input.amount,
          businessDate: today,
          sourceType: "deposit",
          sourceId: deposit!.id,
          at: now,
        });
      }

      await notifyOperators(tx, now, [
        {
          operatorId: operator.id,
          kind: "receipt",
          body: `Deposit of ${formatNaira(input.amount)} received on ${formatDate(today)}. Receipt ${receiptNumber}.`,
        },
      ]);
      await auditFrom(ctx, tx, {
        action: "deposit.record",
        entityType: "operator_deposit",
        entityId: deposit!.id,
        after: { operatorId: operator.id, amountKobo: input.amount, method: input.method, receiptNumber },
      });
      return { id: deposit!.id };
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "one_live_reference") {
      throw fieldError("reference", "This reference has already been used on another payment or deposit");
    }
    // Two identical submissions raced: the winner's deposit is the answer.
    if (asPgError(error)?.constraint_name === "operator_deposits_client_id_unique") {
      const [winner] = await db
        .select({ id: operatorDeposits.id })
        .from(operatorDeposits)
        .where(eq(operatorDeposits.clientId, input.clientId));
      if (winner) return winner;
    }
    throw error;
  }
}

/** The receipt stays on record. The money comes back out of the trail it went into. */
export async function reverseDeposit(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "payment.reverse");
  const id = parseInput(idField("deposit"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  const now = ctx.clock();
  const today = businessDate(now);

  await db.transaction(async (tx) => {
    const [found] = await tx.select().from(operatorDeposits).where(eq(operatorDeposits.id, id));
    if (!found) throw new DomainError("Deposit not found.");
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, found.operatorId)).for("update");

    const [already] = await tx
      .select({ id: operatorDepositReversals.depositId })
      .from(operatorDepositReversals)
      .where(eq(operatorDepositReversals.depositId, id));
    if (already) throw new DomainError("This deposit has already been reversed.");

    await tx.insert(operatorDepositReversals).values({
      depositId: id,
      reversedBy: ctx.actor.userId,
      reason,
      reversedAt: now,
    });

    if (found.method === "cash") {
      await tx.insert(cashMovements).values({
        custodianId: found.receivedBy,
        amountKobo: -found.amountKobo,
        businessDate: await cashDate(tx, found.receivedBy, today),
        sourceType: "deposit_reversal",
        sourceId: id,
        at: now,
      });
    } else {
      await tx.update(paymentReferences).set({ releasedAt: now }).where(eq(paymentReferences.depositId, id));
      await tx.insert(bankMovements).values({
        amountKobo: -found.amountKobo,
        businessDate: today,
        sourceType: "deposit_reversal",
        sourceId: id,
        at: now,
      });
    }

    await auditFrom(ctx, tx, {
      action: "deposit.reverse",
      entityType: "operator_deposit",
      entityId: id,
      before: { amountKobo: found.amountKobo, receiptNumber: found.receiptNumber },
      reason,
    });
  });
}

const LIST_LIMIT = 200;

const depositRow = {
  id: operatorDeposits.id,
  receiptNumber: operatorDeposits.receiptNumber,
  amountKobo: operatorDeposits.amountKobo,
  method: operatorDeposits.method,
  businessDate: operatorDeposits.businessDate,
  receivedAt: operatorDeposits.receivedAt,
  operatorId: operatorDeposits.operatorId,
  operatorName: operators.name,
  reversedAt: operatorDepositReversals.reversedAt,
};

const depositRows = (exec: Executor) =>
  exec
    .select(depositRow)
    .from(operatorDeposits)
    .innerJoin(operators, eq(operators.id, operatorDeposits.operatorId))
    .leftJoin(operatorDepositReversals, eq(operatorDepositReversals.depositId, operatorDeposits.id))
    .$dynamic();

const heldTotal = (operatorId?: string) => sql`
  SELECT COALESCE(SUM(d.amount_kobo), 0)::float8 AS held FROM operator_deposits d
  WHERE NOT EXISTS (SELECT 1 FROM operator_deposit_reversals r WHERE r.deposit_id = d.id)
    ${operatorId ? sql`AND d.operator_id = ${operatorId}` : sql``}
`;

async function heldKobo(exec: Executor, operatorId?: string) {
  const rows = (await exec.execute(heldTotal(operatorId))) as unknown as { held: number }[];
  return rows[0]?.held ?? 0;
}

async function depositsOf(exec: Executor, operatorId: string) {
  const [items, held] = await Promise.all([
    depositRows(exec)
      .where(eq(operatorDeposits.operatorId, operatorId))
      .orderBy(desc(operatorDeposits.receivedAt))
      .limit(LIST_LIMIT),
    heldKobo(exec, operatorId),
  ]);
  return { items, heldKobo: held };
}

export async function listDeposits(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const [rows, held] = await Promise.all([
    depositRows(db).orderBy(desc(operatorDeposits.receivedAt)).limit(LIST_LIMIT + 1),
    heldKobo(db),
  ]);
  return { items: rows.slice(0, LIST_LIMIT), truncated: rows.length > LIST_LIMIT, heldKobo: held };
}

export async function operatorDepositsFor(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "finance.view");
  return depositsOf(db, operatorId);
}

/** The operator's own deposits. The ID comes only from the login session. */
export async function getMyDeposits(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  if (!ctx.actor.operatorId) throw new DomainError("This login is not linked to an operator.");
  return depositsOf(db, ctx.actor.operatorId);
}

export async function getDeposit(ctx: Ctx, id: string) {
  requirePermission(ctx, "finance.view");
  const [row] = await db
    .select({
      deposit: operatorDeposits,
      operatorName: operators.name,
      receivedByName: users.name,
      reversalReason: operatorDepositReversals.reason,
      reversedAt: operatorDepositReversals.reversedAt,
      reference: paymentReferences.reference,
      confirmedAt: paymentReferences.confirmedAt,
    })
    .from(operatorDeposits)
    .innerJoin(operators, eq(operators.id, operatorDeposits.operatorId))
    .innerJoin(users, eq(users.id, operatorDeposits.receivedBy))
    .leftJoin(operatorDepositReversals, eq(operatorDepositReversals.depositId, operatorDeposits.id))
    .leftJoin(paymentReferences, eq(paymentReferences.depositId, operatorDeposits.id))
    .where(eq(operatorDeposits.id, id))
    .limit(1);
  return row ?? null;
}
