import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import {
  assignments,
  charges,
  depositSettlementItems,
  depositSettlements,
  lateEvaluations,
  operators,
  paymentAllocations,
  paymentReversals,
  payments,
  users,
} from "@/db/schema";
import { addDays, addMonths, businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput } from "@/lib/errors";
import { idField, optionalText } from "@/lib/fields";
import { formatDate } from "@/lib/format";

const monthName = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
import { formatNaira, parseNairaToKobo } from "@/lib/money";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { moneySourceField, recordMovement, takeMoneyOut } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { applyContributionCredit } from "./contributions";
import { allocate, applyCredit, openCharges, syncLoanStatus, voidCharge, type OpenCharge } from "./ledger";
import { notifyOperators } from "./notices";
import { notifyMany } from "./notifications";

/** The owner is told when more than this is given back at once, as with large expenses. */
export const LARGE_REFUND_KOBO = 5_000_000;
/** The owner is told of a damage deduction above this. */
export const LARGE_DAMAGE_KOBO = 2_000_000;

/** What a deposit can clear, in the order the settle screen lists them. */
export const DEBT_KINDS = ["daily_balance", "penalty", "loan", "contribution"] as const;
export type DebtKind = (typeof DEBT_KINDS)[number];

/** The first day of the date's month. */
export const monthStart = (date: string) => `${date.slice(0, 8)}01`;
/** The last day of the date's month: refund day. */
export const monthEnd = (date: string) => addDays(addMonths(monthStart(date), 1), -1);
const isMonthEnd = (date: string) => monthEnd(date) === date;

/**
 * Savings neither reversed nor refunded. `before` keeps only those received
 * before that date: what is due while the operator works, outside refund day.
 */
async function heldOf(exec: Executor, operatorId: string, before: string | null = null) {
  const rows = (await exec.execute(sql`
    SELECT d.id, d.amount_kobo::float8 AS amount, d.business_date::text AS date FROM operator_deposits d
    WHERE d.operator_id = ${operatorId}
      AND NOT EXISTS (SELECT 1 FROM operator_deposit_reversals r WHERE r.deposit_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM deposit_settlement_items i WHERE i.deposit_id = d.id)
      ${before ? sql`AND d.business_date < ${before}::date` : sql``}
    ORDER BY d.received_at
  `)) as unknown as { id: string; amount: number; date: string }[];
  return { ids: rows.map((row) => row.id), heldKobo: rows.reduce((sum, row) => sum + row.amount, 0), rows };
}

async function debtsOf(exec: Executor, operatorId: string) {
  const lists = await Promise.all(DEBT_KINDS.map((kind) => openCharges(exec, operatorId, kind)));
  return Object.fromEntries(DEBT_KINDS.map((kind, i) => [kind, lists[i]!])) as Record<DebtKind, OpenCharge[]>;
}

const sum = (charges: OpenCharge[]) => charges.reduce((total, c) => total + c.outstandingKobo, 0);

/**
 * Which savings can be refunded today, or why none can.
 * - Left or sacked, tricycle back: everything held.
 * - Working, on refund day (the month end) and not yet refunded today: everything held.
 * - Working, any other day: only savings from earlier months that were never refunded.
 */
async function dueRule(exec: Executor, operator: { id: string; status: string }, today: string) {
  if (operator.status !== "active") {
    const [open] = await exec
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.operatorId, operator.id), isNull(assignments.returnedOn)))
      .limit(1);
    return open
      ? { before: null, notYet: "The tricycle must be returned before the savings are given back." }
      : { before: null, notYet: null };
  }
  if (isMonthEnd(today)) {
    const [done] = await exec
      .select({ id: depositSettlements.id })
      .from(depositSettlements)
      .where(
        and(
          eq(depositSettlements.operatorId, operator.id),
          eq(depositSettlements.businessDate, today),
          isNull(depositSettlements.undoneAt),
        ),
      )
      .limit(1);
    if (!done) return { before: null, notYet: null };
    // Refunded today already: anything saved since counts towards next month.
    return { before: monthStart(today), notYet: `Refunded today. New savings are given back on ${formatDate(monthEnd(addDays(today, 1)))}.` };
  }
  return { before: monthStart(today), notYet: `Savings are given back on ${formatDate(monthEnd(today))}.` };
}

/** Everything the refund screen shows: what is saved, what is due, what is owed and whether it can be refunded now. */
export async function depositPosition(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const [operator] = await db
    .select({ id: operators.id, status: operators.status })
    .from(operators)
    .where(eq(operators.id, operatorId));
  if (!operator) return null;
  const rule = await dueRule(db, operator, today);
  const [held, due, debts, history] = await Promise.all([
    heldOf(db, operatorId),
    heldOf(db, operatorId, rule.before),
    debtsOf(db, operatorId),
    settlementsOf(db, operatorId),
  ]);
  const blocked = operator.status !== "active" && rule.notYet;
  return {
    heldKobo: held.heldKobo,
    /** Saved since the 1st of this month. */
    savedThisMonthKobo: held.rows.filter((row) => row.date >= monthStart(today)).reduce((s, row) => s + row.amount, 0),
    dueKobo: blocked ? 0 : due.heldKobo,
    /** Shown when nothing (or only part) is due. */
    notYet: blocked || due.heldKobo === 0 ? rule.notYet : null,
    refundDay: monthEnd(today),
    owed: Object.fromEntries(
      DEBT_KINDS.map((kind) => [kind, { kobo: sum(debts[kind]), count: debts[kind].length }]),
    ) as Record<DebtKind, { kobo: number; count: number }>,
    canSettle: can(ctx.actor.role, "deposit.settle"),
    settlements: history,
  };
}

const settleSchema = z.object({
  operatorId: idField("operator"),
  /** The kinds of debt the savings clear. Unticked ones stay owed. */
  clear: z.array(z.enum(DEBT_KINDS)).default([]),
  /** Damage to the tricycle, taken out after debts. Beyond what is left, it is owed as a fine. */
  damage: z.preprocess((value) => (value === "" ? undefined : value), z.string().optional()),
  damageWhat: optionalText(200),
  damageOnPurpose: z.preprocess((value) => value === "on" || value === true || value === "true", z.boolean()),
  source: z.preprocess((value) => value || undefined, moneySourceField.optional()),
  reference: optionalText(60),
});
type SettleInput = z.infer<typeof settleSchema>;

/**
 * Refunds an operator's savings: the ticked debts are cleared oldest first on
 * a "From deposit" receipt, damage is taken out, and the rest leaves the
 * chosen cash or bank. All of it is saved together, or none of it.
 */
export async function settleDeposit(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "deposit.settle");
  const input = parseInput(settleSchema, raw);
  return db.transaction((tx) => settleIn(tx, ctx, input, true));
}

async function settleIn(tx: Tx, ctx: Ctx, input: SettleInput, tellOwner: boolean) {
  const now = ctx.clock();
  const today = businessDate(now);
  const [operator] = await tx
    .select({ id: operators.id, name: operators.name, status: operators.status })
    .from(operators)
    .where(eq(operators.id, input.operatorId))
    .for("update");
  if (!operator) throw new DomainError("Operator not found.");
  const rule = await dueRule(tx, operator, today);
  if (operator.status !== "active" && rule.notYet) throw new DomainError(rule.notYet);
  const held = await heldOf(tx, operator.id, rule.before);
  if (held.heldKobo <= 0) throw new DomainError(rule.notYet ?? `Nothing is saved for ${operator.name}.`);

  // Oldest first across every ticked kind, so small savings clear the oldest debts.
  const debts = await debtsOf(tx, operator.id);
  const ticked = input.clear
    .flatMap((kind) => debts[kind])
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const clearedKobo = Math.min(held.heldKobo, sum(ticked));
  const leftKobo = held.heldKobo - clearedKobo;

  let damageKobo = 0;
  if (input.damage !== undefined) {
    const typed = parseNairaToKobo(input.damage);
    if (typed === null) throw fieldError("damage", "Enter an amount, for example 8,000");
    damageKobo = typed;
  }
  if (damageKobo > 0 && !input.damageWhat) throw fieldError("damageWhat", "Say what was damaged, for example broken windscreen");
  const keptKobo = Math.min(damageKobo, leftKobo);
  const owedFineKobo = damageKobo - keptKobo;
  const givenBackKobo = leftKobo - keptKobo;
  if (givenBackKobo > 0 && !input.source) throw fieldError("source", "Choose where the money given back comes from");

  // What the savings clear is a payment like any other, so receipts, the
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
      .returning({ id: payments.id });
    paymentId = payment!.id;
    await allocate(tx, paymentId, ticked, clearedKobo);
    if (input.clear.includes("loan")) await syncLoanStatus(tx, operator.id);
  }

  // Damage the savings could not cover is owed, and paid like any fine.
  let damageChargeId: string | null = null;
  if (owedFineKobo > 0) {
    const [charge] = await tx
      .insert(charges)
      .values({ type: "penalty", operatorId: operator.id, amountKobo: owedFineKobo, businessDate: today })
      .returning({ id: charges.id });
    damageChargeId = charge!.id;
  }

  const [settlement] = await tx
    .insert(depositSettlements)
    .values({
      operatorId: operator.id,
      heldKobo: held.heldKobo,
      clearedKobo,
      givenBackKobo,
      keptKobo,
      keptReason: damageKobo > 0 ? input.damageWhat! : null,
      damageOnPurpose: damageKobo > 0 && input.damageOnPurpose,
      damageChargeId,
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
    damageKobo > 0 ? `${formatNaira(damageKobo)} for damage: ${input.damageWhat}` : null,
    owedFineKobo > 0 ? `${formatNaira(owedFineKobo)} of it is owed as a fine` : null,
    givenBackKobo > 0 ? `${formatNaira(givenBackKobo)} given back to you` : "nothing to give back",
  ].filter(Boolean);
  const next = operator.status === "active" ? ` Start saving for ${monthName(addDays(monthEnd(today), 1))}.` : "";
  await notifyOperators(tx, now, [
    {
      operatorId: operator.id,
      kind: "receipt",
      body: `Your savings of ${formatNaira(held.heldKobo)} were settled on ${formatDate(today)}: ${parts.join(", ")}.${next}`,
    },
  ]);
  const owner = [];
  if (tellOwner && givenBackKobo > LARGE_REFUND_KOBO) {
    owner.push({
      kind: "large_deposit_refund" as const,
      body: `${formatNaira(givenBackKobo)} given back to ${operator.name}`,
      at: now,
      link: `/operators/${operator.id}#deposit`,
      entity: { type: "deposit_settlement", id },
      dedupeKey: `large_deposit_refund:${id}`,
      createdBy: ctx.actor.userId,
    });
  }
  if (damageKobo > LARGE_DAMAGE_KOBO) {
    owner.push({
      kind: "large_damage_deduction" as const,
      body: `${formatNaira(damageKobo)} for damage taken from ${operator.name}'s savings: ${input.damageWhat}${input.damageOnPurpose ? " (on purpose)" : ""}`,
      at: now,
      link: `/operators/${operator.id}#deposit`,
      entity: { type: "deposit_settlement", id },
      dedupeKey: `large_damage_deduction:${id}`,
      createdBy: ctx.actor.userId,
    });
  }
  if (owner.length > 0) await notifyMany(tx, owner);
  await auditFrom(ctx, tx, {
    action: "deposit.settle",
    entityType: "operator",
    entityId: operator.id,
    after: { heldKobo: held.heldKobo, clearedKobo, givenBackKobo, keptKobo, owedFineKobo, onPurpose: input.damageOnPurpose, cleared: input.clear },
    reason: input.damageWhat,
  });
  return { id, heldKobo: held.heldKobo, clearedKobo, givenBackKobo, keptKobo, owedFineKobo };
}

const refundAllSchema = z.object({
  operatorIds: z.array(idField("operator")).min(1, "Tick at least one operator"),
  source: moneySourceField,
  reference: optionalText(60),
});

/**
 * Month-end refunds in one step: for each ticked operator, every debt is
 * cleared from their savings and the rest is given back from one source.
 * Damage is left for refunds done one by one. All of it, or none of it.
 */
export async function refundAllDue(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "deposit.settle");
  const input = parseInput(refundAllSchema, raw);
  const now = ctx.clock();
  return db.transaction(async (tx) => {
    let givenBackKobo = 0;
    let clearedKobo = 0;
    for (const operatorId of [...new Set(input.operatorIds)].sort()) {
      const done = await settleIn(
        tx,
        ctx,
        { operatorId, clear: [...DEBT_KINDS], damageOnPurpose: false, source: input.source, reference: input.reference },
        false,
      );
      givenBackKobo += done.givenBackKobo;
      clearedKobo += done.clearedKobo;
    }
    if (givenBackKobo > LARGE_REFUND_KOBO) {
      await notifyMany(tx, [
        {
          kind: "large_deposit_refund",
          body: `${formatNaira(givenBackKobo)} given back to ${input.operatorIds.length} operators at the month end`,
          at: now,
          link: "/deposits",
          createdBy: ctx.actor.userId,
        },
      ]);
    }
    return { count: input.operatorIds.length, givenBackKobo, clearedKobo };
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
    if (found.damageChargeId) {
      const [paid] = (await tx.execute(sql`
        SELECT COALESCE(SUM(e.amount_kobo), 0)::float8 AS paid FROM effective_allocations e WHERE e.charge_id = ${found.damageChargeId}
      `)) as unknown as { paid: number }[];
      if ((paid?.paid ?? 0) > 0) {
        throw new DomainError("Part of the damage fine has been paid, so this refund cannot be undone. Reverse that payment first.");
      }
      await voidCharge(tx, found.damageChargeId, { userId: ctx.actor.userId, at: now }, "Deposit refund undone");
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
        body: `The settlement of your savings on ${formatDate(found.businessDate)} was a mistake and has been undone. Your savings of ${formatNaira(found.heldKobo)} are held again.`,
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
      damageOnPurpose: depositSettlements.damageOnPurpose,
      owedFineKobo: sql<number>`COALESCE((SELECT c.amount_kobo FROM charges c WHERE c.id = ${depositSettlements.damageChargeId}), 0)::float8`,
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

/**
 * Operators whose savings can be refunded today, oldest first: everyone on
 * refund day (the month end) not yet refunded, savings left from earlier
 * months, and those who left. With what each owes, for Refund all.
 */
export async function depositsToSettle(exec: Executor = db, today = businessDate(new Date())) {
  const start = monthStart(today);
  const refundDay = isMonthEnd(today);
  return (await exec.execute(sql`
    WITH held AS (
      SELECT d.operator_id, d.amount_kobo, d.business_date FROM operator_deposits d
      WHERE NOT EXISTS (SELECT 1 FROM operator_deposit_reversals r WHERE r.deposit_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM deposit_settlement_items i WHERE i.deposit_id = d.id)
    )
    SELECT o.id AS operator_id, o.name, o.status::text AS status,
           SUM(h.amount_kobo)::float8 AS held, MIN(h.business_date)::text AS since,
           EXISTS (SELECT 1 FROM assignments a WHERE a.operator_id = o.id AND a.returned_on IS NULL) AS has_tricycle,
           EXISTS (SELECT 1 FROM work_orders w JOIN assignments a ON a.tricycle_id = w.tricycle_id AND a.returned_on IS NULL
                   WHERE a.operator_id = o.id AND w.created_at >= ${start}::date) AS workshop_this_month,
           (SELECT COALESCE(SUM(GREATEST(c.amount_kobo
              - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e WHERE e.charge_id = c.id), 0)
              - COALESCE((SELECT SUM(w.amount_kobo) FROM effective_waivers w WHERE w.charge_id = c.id), 0), 0)), 0)::float8
            FROM valid_charges c WHERE c.operator_id = o.id
              AND c.type IN ('daily_balance', 'penalty', 'loan', 'contribution')) AS owed
    FROM held h JOIN operators o ON o.id = h.operator_id
    WHERE o.status <> 'active'
       OR h.business_date < ${start}::date
       OR (${refundDay} AND NOT EXISTS (
             SELECT 1 FROM deposit_settlements s
             WHERE s.operator_id = o.id AND s.business_date = ${today}::date AND s.undone_at IS NULL))
    GROUP BY o.id, o.name, o.status
    ORDER BY MIN(h.business_date), o.name
  `)) as unknown as {
    operator_id: string;
    name: string;
    status: string;
    held: number;
    since: string;
    has_tricycle: boolean;
    workshop_this_month: boolean;
    owed: number;
  }[];
}

/** Working operators with a tricycle who have saved nothing since the 1st. A reminder only. */
export async function notSavingThisMonth(exec: Executor = db, today = businessDate(new Date())) {
  return (await exec.execute(sql`
    SELECT o.id AS operator_id, o.name FROM operators o
    WHERE o.status = 'active'
      AND EXISTS (SELECT 1 FROM assignments a WHERE a.operator_id = o.id AND a.returned_on IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM operator_deposits d
        WHERE d.operator_id = o.id AND d.business_date >= ${monthStart(today)}::date
          AND NOT EXISTS (SELECT 1 FROM operator_deposit_reversals r WHERE r.deposit_id = d.id))
    ORDER BY o.name
  `)) as unknown as { operator_id: string; name: string }[];
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
