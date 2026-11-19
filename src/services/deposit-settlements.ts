import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import {
  assignments,
  depositSettlementItems,
  depositSettlements,
  lateEvaluations,
  operators,
  paymentAllocations,
  paymentReversals,
  payments,
  users,
} from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput } from "@/lib/errors";
import { idField, optionalText } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira, parseNairaToKobo } from "@/lib/money";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { moneySourceField, recordMovement, takeMoneyOut } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { applyContributionCredit } from "./contributions";
import { allocate, applyCredit, openCharges, syncLoanStatus, type OpenCharge } from "./ledger";
import { notifyOperators } from "./notices";
import { notifyMany } from "./notifications";

/** The owner is told when more than this is given back at once, as with large expenses. */
export const LARGE_REFUND_KOBO = 5_000_000;

/** What a deposit can clear, in the order the settle screen lists them. */
export const DEBT_KINDS = ["daily_balance", "penalty", "loan", "contribution"] as const;
export type DebtKind = (typeof DEBT_KINDS)[number];

/** Deposits neither reversed nor settled: still held for the operator. */
const heldDeposits = (operatorId: string) => sql`
  SELECT d.id, d.amount_kobo::float8 AS amount FROM operator_deposits d
  WHERE d.operator_id = ${operatorId}
    AND NOT EXISTS (SELECT 1 FROM operator_deposit_reversals r WHERE r.deposit_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM deposit_settlement_items i WHERE i.deposit_id = d.id)
  ORDER BY d.received_at
`;

async function heldOf(exec: Executor, operatorId: string) {
  const rows = (await exec.execute(heldDeposits(operatorId))) as unknown as { id: string; amount: number }[];
  return { ids: rows.map((row) => row.id), heldKobo: rows.reduce((sum, row) => sum + row.amount, 0) };
}

async function debtsOf(exec: Executor, operatorId: string) {
  const lists = await Promise.all(DEBT_KINDS.map((kind) => openCharges(exec, operatorId, kind)));
  return Object.fromEntries(DEBT_KINDS.map((kind, i) => [kind, lists[i]!])) as Record<DebtKind, OpenCharge[]>;
}

const sum = (charges: OpenCharge[]) => charges.reduce((total, c) => total + c.outstandingKobo, 0);

/** Why a deposit cannot be settled yet, or null when it can. */
async function blocker(exec: Executor, operator: { id: string; status: string }) {
  if (operator.status === "active") return "A deposit is settled once the operator has left or been sacked.";
  const [open] = await exec
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.operatorId, operator.id), isNull(assignments.returnedOn)))
    .limit(1);
  return open ? "The tricycle must be returned before the deposit is settled." : null;
}

/** Everything the settle screen shows: what is held, what is owed and whether it can be settled now. */
export async function depositPosition(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "finance.view");
  const [operator] = await db
    .select({ id: operators.id, status: operators.status })
    .from(operators)
    .where(eq(operators.id, operatorId));
  if (!operator) return null;
  const [held, debts, notYet, history] = await Promise.all([
    heldOf(db, operatorId),
    debtsOf(db, operatorId),
    blocker(db, operator),
    settlementsOf(db, operatorId),
  ]);
  return {
    heldKobo: held.heldKobo,
    owed: Object.fromEntries(
      DEBT_KINDS.map((kind) => [kind, { kobo: sum(debts[kind]), count: debts[kind].length }]),
    ) as Record<DebtKind, { kobo: number; count: number }>,
    notYet,
    canSettle: can(ctx.actor.role, "deposit.settle"),
    settlements: history,
  };
}

const settleSchema = z.object({
  operatorId: idField("operator"),
  /** The kinds of debt the deposit clears. Unticked ones stay owed. */
  clear: z.array(z.enum(DEBT_KINDS)).default([]),
  /** Empty means everything left after clearing debts is given back. */
  giveBack: z.preprocess((value) => (value === "" ? undefined : value), z.string().optional()),
  source: z.preprocess((value) => value || undefined, moneySourceField.optional()),
  reference: optionalText(60),
  keptReason: optionalText(300),
});

/**
 * Settles every deposit still held for an operator who has stopped working:
 * the ticked debts are cleared oldest first on a "Paid from deposit" receipt,
 * the money given back leaves the chosen cash or bank, and anything else is
 * kept with a reason. All of it is saved together, or none of it.
 */
export async function settleDeposit(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "deposit.settle");
  const input = parseInput(settleSchema, raw);
  const now = ctx.clock();
  const today = businessDate(now);

  return db.transaction(async (tx) => {
    const [operator] = await tx
      .select({ id: operators.id, name: operators.name, status: operators.status })
      .from(operators)
      .where(eq(operators.id, input.operatorId))
      .for("update");
    if (!operator) throw new DomainError("Operator not found.");
    const notYet = await blocker(tx, operator);
    if (notYet) throw new DomainError(notYet);

    const held = await heldOf(tx, operator.id);
    if (held.heldKobo <= 0) throw new DomainError("No deposit is held for this operator.");

    // Oldest first across every ticked kind, so a small deposit clears the oldest debts.
    const debts = await debtsOf(tx, operator.id);
    const ticked = input.clear
      .flatMap((kind) => debts[kind])
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
    const clearedKobo = Math.min(held.heldKobo, sum(ticked));
    const leftKobo = held.heldKobo - clearedKobo;

    let givenBackKobo = leftKobo;
    if (input.giveBack !== undefined) {
      const typed = parseNairaToKobo(input.giveBack);
      if (typed === null) throw fieldError("giveBack", "Enter an amount, for example 10,500");
      if (typed > leftKobo) {
        throw fieldError("giveBack", `At most ${formatNaira(leftKobo)} is left to give back`);
      }
      givenBackKobo = typed;
    }
    const keptKobo = leftKobo - givenBackKobo;
    if (keptKobo > 0 && !input.keptReason) {
      throw fieldError("keptReason", `Say why ${formatNaira(keptKobo)} is kept, for example damage to the tricycle`);
    }
    if (givenBackKobo > 0 && !input.source) throw fieldError("source", "Choose where the money given back comes from");

    // What the deposit clears is a payment like any other, so receipts, the
    // debt list and the statement all follow. It adds no money: the deposit already did.
    let paymentId: string | null = null;
    if (clearedKobo > 0) {
      const seq = (await tx.execute(sql`SELECT nextval('receipt_seq')::int AS n`)) as unknown as { n: number }[];
      const [payment] = await tx
        .insert(payments)
        .values({
          operatorId: operator.id,
          amountKobo: clearedKobo,
          method: "deposit",
          receivedAt: now,
          businessDate: today,
          receivedBy: ctx.actor.userId,
          receiptNumber: `R-${String(seq[0]!.n).padStart(6, "0")}`,
          clientId: crypto.randomUUID(),
          purpose: "general",
        })
        .returning({ id: payments.id, receiptNumber: payments.receiptNumber });
      paymentId = payment!.id;
      await allocate(tx, paymentId, ticked, clearedKobo);
      if (input.clear.includes("loan")) await syncLoanStatus(tx, operator.id);
    }

    const [settlement] = await tx
      .insert(depositSettlements)
      .values({
        operatorId: operator.id,
        heldKobo: held.heldKobo,
        clearedKobo,
        givenBackKobo,
        keptKobo,
        keptReason: keptKobo > 0 ? input.keptReason! : null,
        paymentId,
        custodianId: givenBackKobo > 0 ? input.source!.custodianId : null,
        account: givenBackKobo > 0 && !input.source!.custodianId ? input.source!.account : null,
        reference: input.reference ?? null,
        settledBy: ctx.actor.userId,
        settledAt: now,
        businessDate: today,
      })
      .returning({ id: depositSettlements.id });
    const id = settlement!.id;
    await tx.insert(depositSettlementItems).values(held.ids.map((depositId) => ({ settlementId: id, depositId })));

    if (givenBackKobo > 0) {
      await takeMoneyOut(
        tx,
        { ...input.source!, amountKobo: givenBackKobo, sourceType: "deposit_refund", sourceId: id, at: now },
        "source",
      );
    }

    const parts = [
      clearedKobo > 0 ? `${formatNaira(clearedKobo)} cleared what you owed` : null,
      givenBackKobo > 0 ? `${formatNaira(givenBackKobo)} given back` : null,
      keptKobo > 0 ? `${formatNaira(keptKobo)} kept: ${input.keptReason}` : null,
    ].filter(Boolean);
    await notifyOperators(tx, now, [
      {
        operatorId: operator.id,
        kind: "receipt",
        body: `Your deposit of ${formatNaira(held.heldKobo)} was settled on ${formatDate(today)}: ${parts.join(", ")}.`,
      },
    ]);
    if (givenBackKobo > LARGE_REFUND_KOBO) {
      await notifyMany(tx, [
        {
          kind: "large_deposit_refund",
          body: `${formatNaira(givenBackKobo)} given back to ${operator.name}`,
          at: now,
          link: `/operators/${operator.id}#deposit`,
          entity: { type: "deposit_settlement", id },
          dedupeKey: `large_deposit_refund:${id}`,
          createdBy: ctx.actor.userId,
        },
      ]);
    }
    await auditFrom(ctx, tx, {
      action: "deposit.settle",
      entityType: "operator",
      entityId: operator.id,
      after: { heldKobo: held.heldKobo, clearedKobo, givenBackKobo, keptKobo, cleared: input.clear },
      reason: input.keptReason,
    });
    return { id, heldKobo: held.heldKobo, clearedKobo, givenBackKobo, keptKobo };
  });
}

/**
 * For a settlement saved by mistake, on the day it was saved: the debts are
 * owed again, the money given back is put back, and the deposit is held again.
 */
export async function undoSettlement(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "deposit.settle");
  const id = parseInput(idField("settlement"), rawId);
  const now = ctx.clock();
  const today = businessDate(now);

  await db.transaction(async (tx) => {
    const [found] = await tx.select().from(depositSettlements).where(eq(depositSettlements.id, id));
    if (!found) throw new DomainError("Settlement not found.");
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, found.operatorId)).for("update");
    const [current] = await tx.select().from(depositSettlements).where(eq(depositSettlements.id, id)).for("update");
    if (current!.undoneAt) throw new DomainError("This settlement has already been undone.");
    if (current!.businessDate !== today) {
      throw new DomainError("A settlement can only be undone on the day it was saved.");
    }

    if (found.paymentId) {
      await tx.insert(paymentReversals).values({
        paymentId: found.paymentId,
        reversedBy: ctx.actor.userId,
        reason: "Deposit settlement undone",
        reversedAt: now,
      });
      // A balance this payment had kept on time must be judged again tonight.
      const affected = await tx
        .select({ chargeId: paymentAllocations.chargeId })
        .from(paymentAllocations)
        .where(eq(paymentAllocations.paymentId, found.paymentId));
      for (const { chargeId } of affected) {
        await tx
          .delete(lateEvaluations)
          .where(and(eq(lateEvaluations.chargeId, chargeId), eq(lateEvaluations.outcome, "on_time")));
      }
      await syncLoanStatus(tx, found.operatorId);
      await applyCredit(tx, found.operatorId);
      await applyContributionCredit(tx, found.operatorId);
    }
    if (found.givenBackKobo > 0) {
      await recordMovement(tx, {
        custodianId: found.custodianId,
        account: found.account ?? "bank",
        amountKobo: found.givenBackKobo,
        sourceType: "deposit_refund_undo",
        sourceId: id,
        at: now,
      });
    }
    await tx.delete(depositSettlementItems).where(eq(depositSettlementItems.settlementId, id));
    await tx
      .update(depositSettlements)
      .set({ undoneAt: now, undoneBy: ctx.actor.userId })
      .where(eq(depositSettlements.id, id));
    await notifyOperators(tx, now, [
      {
        operatorId: found.operatorId,
        kind: "receipt",
        body: `The settlement of your deposit on ${formatDate(found.businessDate)} was a mistake and has been undone. Your deposit of ${formatNaira(found.heldKobo)} is held again.`,
      },
    ]);
    await auditFrom(ctx, tx, {
      action: "deposit.settle_undo",
      entityType: "operator",
      entityId: found.operatorId,
      before: { heldKobo: found.heldKobo, clearedKobo: found.clearedKobo, givenBackKobo: found.givenBackKobo, keptKobo: found.keptKobo },
    });
  });
}

/** An operator's settlements, newest first, with where the money given back came from. */
async function settlementsOf(exec: Executor, operatorId: string) {
  const rows = await exec
    .select({
      id: depositSettlements.id,
      heldKobo: depositSettlements.heldKobo,
      clearedKobo: depositSettlements.clearedKobo,
      givenBackKobo: depositSettlements.givenBackKobo,
      keptKobo: depositSettlements.keptKobo,
      keptReason: depositSettlements.keptReason,
      paymentId: depositSettlements.paymentId,
      receiptNumber: payments.receiptNumber,
      custodianName: users.name,
      account: depositSettlements.account,
      reference: depositSettlements.reference,
      businessDate: depositSettlements.businessDate,
      undoneAt: depositSettlements.undoneAt,
    })
    .from(depositSettlements)
    .leftJoin(payments, eq(payments.id, depositSettlements.paymentId))
    .leftJoin(users, eq(users.id, depositSettlements.custodianId))
    .where(eq(depositSettlements.operatorId, operatorId))
    .orderBy(desc(depositSettlements.settledAt));
  return rows;
}

/** The operator's own settlements, for their portal. The ID comes only from the login session. */
export async function getMySettlements(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  if (!ctx.actor.operatorId) throw new DomainError("This login is not linked to an operator.");
  return (await settlementsOf(db, ctx.actor.operatorId)).filter((row) => !row.undoneAt);
}

/** Operators who stopped working with a deposit still held: the oldest deposit first. */
export async function depositsToSettle(exec: Executor = db) {
  return (await exec.execute(sql`
    SELECT o.id AS operator_id, o.name, o.status::text AS status,
           SUM(d.amount_kobo)::float8 AS held, MIN(d.business_date)::text AS since
    FROM operator_deposits d JOIN operators o ON o.id = d.operator_id
    WHERE o.status <> 'active'
      AND NOT EXISTS (SELECT 1 FROM operator_deposit_reversals r WHERE r.deposit_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM deposit_settlement_items i WHERE i.deposit_id = d.id)
    GROUP BY o.id, o.name, o.status
    ORDER BY MIN(d.business_date), o.name
  `)) as unknown as { operator_id: string; name: string; status: string; held: number; since: string }[];
}

/** Settlements still standing, newest first, for the deposits page. */
export async function listSettlements(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  return db
    .select({
      id: depositSettlements.id,
      operatorId: depositSettlements.operatorId,
      operatorName: operators.name,
      heldKobo: depositSettlements.heldKobo,
      clearedKobo: depositSettlements.clearedKobo,
      givenBackKobo: depositSettlements.givenBackKobo,
      keptKobo: depositSettlements.keptKobo,
      keptReason: depositSettlements.keptReason,
      businessDate: depositSettlements.businessDate,
    })
    .from(depositSettlements)
    .innerJoin(operators, eq(operators.id, depositSettlements.operatorId))
    .where(isNull(depositSettlements.undoneAt))
    .orderBy(desc(depositSettlements.settledAt))
    .limit(200);
}

export type Settlement = Awaited<ReturnType<typeof settlementsOf>>[number];
