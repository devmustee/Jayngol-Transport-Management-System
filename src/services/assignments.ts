import { and, desc, eq, gt, gte, isNull, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import { assignments, balanceRates, offRoadPeriods, operators, tricycles, workOrders } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { dateField, idField, optionalText, positiveNairaField } from "@/lib/fields";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { voidBalancesAfter } from "./ledger";

const issueSchema = z.object({
  tricycleId: idField("tricycle"),
  operatorId: idField("operator"),
  issuedOn: dateField("Date issued"),
  dailyBalance: positiveNairaField("Daily balance"),
});

const returnSchema = z.object({
  returnedOn: dateField("Date returned"),
  reason: z.enum(["reassigned", "operator_left", "tricycle_retired", "other"], "Choose a reason"),
  note: optionalText(),
});

const rateSchema = z.object({
  dailyBalance: positiveNairaField("Daily balance"),
  effectiveFrom: dateField("Start date"),
});

const OVERLAPS = {
  one_operator_per_tricycle: fieldError(
    "issuedOn",
    "This tricycle was already with an operator on that date",
  ),
  one_tricycle_per_operator: fieldError(
    "issuedOn",
    "This operator already had a tricycle on that date",
  ),
};

const within = <T>(outer: Tx | undefined, work: (tx: Tx) => Promise<T>) =>
  outer ? work(outer) : db.transaction(work);

/** Pass outer to make the issue part of a larger change, such as reinstatement. */
export async function issueTricycle(ctx: Ctx, raw: unknown, outer?: Tx) {
  requirePermission(ctx, "assignment.manage");
  const input = parseInput(issueSchema, raw);
  if (input.issuedOn > businessDate(ctx.clock())) {
    throw fieldError("issuedOn", "Date issued cannot be in the future");
  }

  try {
    return await within(outer, async (tx) => {
      const [tricycle] = await tx
        .select()
        .from(tricycles)
        .where(eq(tricycles.id, input.tricycleId))
        .for("update");
      if (!tricycle) throw new DomainError("Tricycle not found.");
      if (tricycle.status !== "in_stock") {
        throw new DomainError(`This tricycle cannot be issued while it is ${statusText(tricycle.status)}.`);
      }
      if (input.issuedOn < tricycle.purchasedOn) {
        throw fieldError("issuedOn", "Date issued cannot be before the date purchased");
      }

      const [operator] = await tx
        .select()
        .from(operators)
        .where(eq(operators.id, input.operatorId))
        .for("update");
      if (!operator) throw new DomainError("Operator not found.");
      if (operator.status !== "active") {
        throw fieldError("operatorId", "Only an active operator can be issued a tricycle");
      }

      const [assignment] = await tx
        .insert(assignments)
        .values({
          tricycleId: tricycle.id,
          operatorId: operator.id,
          issuedOn: input.issuedOn,
          issuedBy: ctx.actor.userId,
        })
        .returning({ id: assignments.id });
      await tx.insert(balanceRates).values({
        assignmentId: assignment!.id,
        amountKobo: input.dailyBalance,
        effectiveFrom: input.issuedOn,
        createdBy: ctx.actor.userId,
      });
      await tx.update(tricycles).set({ status: "issued" }).where(eq(tricycles.id, tricycle.id));
      await auditFrom(ctx, tx, {
        action: "assignment.issue",
        entityType: "tricycle",
        entityId: tricycle.id,
        after: {
          operatorId: operator.id,
          issuedOn: input.issuedOn,
          dailyBalanceKobo: input.dailyBalance,
        },
      });
      return assignment!;
    });
  } catch (error) {
    rethrowConstraint(error, OVERLAPS);
  }
}

export async function returnTricycle(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "assignment.manage");
  const id = parseInput(idField("assignment"), rawId);
  const input = parseInput(returnSchema, raw);
  if (input.returnedOn > businessDate(ctx.clock())) {
    throw fieldError("returnedOn", "Date returned cannot be in the future");
  }

  await db.transaction((tx) => closeAssignment(tx, ctx, id, input));
}

/**
 * Daily balances already raised for days after the return date are voided,
 * because the operator no longer had the tricycle on those days.
 */
export async function closeAssignment(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: {
    returnedOn: string;
    reason: "reassigned" | "operator_left" | "tricycle_retired" | "sacked" | "other";
    note?: string;
  },
) {
  const [assignment] = await tx
    .select()
    .from(assignments)
    .where(eq(assignments.id, id))
    .for("update");
  if (!assignment) throw new DomainError("Issue record not found.");
  if (assignment.returnedOn) throw new DomainError("This tricycle has already been returned.");
  if (input.returnedOn < assignment.issuedOn) {
    throw fieldError("returnedOn", "Date returned cannot be before the date issued");
  }

  await tx
    .update(assignments)
    .set({
      returnedOn: input.returnedOn,
      returnReason: input.reason,
      returnNote: input.note ?? null,
      returnedBy: ctx.actor.userId,
    })
    .where(eq(assignments.id, id));
  await tx
    .update(tricycles)
    .set({ status: "in_stock" })
    // A tricycle in the workshop stays off-road until the repair is finished.
    .where(and(eq(tricycles.id, assignment.tricycleId), ne(tricycles.status, "off_road")));
  // Nobody is left to bring it in. The nightly job plans again once it is issued.
  await tx
    .delete(workOrders)
    .where(
      and(
        eq(workOrders.tricycleId, assignment.tricycleId),
        eq(workOrders.type, "service"),
        eq(workOrders.status, "scheduled"),
      ),
    );
  await voidBalancesAfter(tx, assignment.operatorId, id, input.returnedOn, {
    userId: ctx.actor.userId,
    at: ctx.clock(),
  });
  await auditFrom(ctx, tx, {
    action: "assignment.return",
    entityType: "tricycle",
    entityId: assignment.tricycleId,
    before: { operatorId: assignment.operatorId, issuedOn: assignment.issuedOn },
    after: { returnedOn: input.returnedOn, reason: input.reason },
    reason: input.note,
  });
}

/**
 * Rates cannot start in the past. Daily balances will be charged at the rate
 * in force on the day, so a backdated rate would disagree with those charges.
 */
export async function changeRate(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "rate.change");
  const id = parseInput(idField("assignment"), rawId);
  const input = parseInput(rateSchema, raw);
  if (input.effectiveFrom < businessDate(ctx.clock())) {
    throw fieldError("effectiveFrom", "A new daily balance cannot start in the past");
  }

  await db.transaction(async (tx) => {
    const [assignment] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.id, id))
      .for("update");
    if (!assignment) throw new DomainError("Issue record not found.");
    if (assignment.returnedOn) throw new DomainError("This tricycle has already been returned.");

    const before = await rateOn(tx, id, input.effectiveFrom);
    await tx.insert(balanceRates).values({
      assignmentId: id,
      amountKobo: input.dailyBalance,
      effectiveFrom: input.effectiveFrom,
      createdBy: ctx.actor.userId,
    });
    await auditFrom(ctx, tx, {
      action: "assignment.change_rate",
      entityType: "tricycle",
      entityId: assignment.tricycleId,
      before: { dailyBalanceKobo: before },
      after: { dailyBalanceKobo: input.dailyBalance, effectiveFrom: input.effectiveFrom },
    });
  });
}

/** The daily balance in force for an assignment on a given business date. */
export async function rateOn(
  exec: Executor,
  assignmentId: string,
  date: string,
): Promise<number | null> {
  const [row] = await exec
    .select({ amountKobo: balanceRates.amountKobo })
    .from(balanceRates)
    .where(and(eq(balanceRates.assignmentId, assignmentId), lte(balanceRates.effectiveFrom, date)))
    .orderBy(desc(balanceRates.effectiveFrom), desc(balanceRates.createdAt))
    .limit(1);
  return row?.amountKobo ?? null;
}

export const currentRate = (assignmentId: string, today: string) =>
  rateOn(db, assignmentId, today);

export const ratesFor = (assignmentId: string) =>
  db
    .select({
      id: balanceRates.id,
      amountKobo: balanceRates.amountKobo,
      effectiveFrom: balanceRates.effectiveFrom,
      createdAt: balanceRates.createdAt,
    })
    .from(balanceRates)
    .where(eq(balanceRates.assignmentId, assignmentId))
    .orderBy(desc(balanceRates.effectiveFrom), desc(balanceRates.createdAt));

function statusText(status: string): string {
  if (status === "issued") return "with an operator";
  if (status === "off_road") return "off the road";
  if (status === "retired") return "retired";
  return status;
}

/** Who held a tricycle on a date. On a handover day, the newer holder. */
export async function holderOn(exec: Executor, tricycleId: string, date: string) {
  const [row] = await exec
    .select({ operatorId: assignments.operatorId })
    .from(assignments)
    .where(
      and(
        eq(assignments.tricycleId, tricycleId),
        lte(assignments.issuedOn, date),
        or(isNull(assignments.returnedOn), gte(assignments.returnedOn, date)),
      ),
    )
    .orderBy(desc(assignments.issuedOn))
    .limit(1);
  return row?.operatorId ?? null;
}

/** Whether a tricycle was in the workshop on a date. The release date is back on the road. */
export async function offRoadOn(exec: Executor, tricycleId: string, date: string) {
  const [row] = await exec
    .select({ id: offRoadPeriods.id })
    .from(offRoadPeriods)
    .where(
      and(
        eq(offRoadPeriods.tricycleId, tricycleId),
        lte(offRoadPeriods.startsOn, date),
        or(isNull(offRoadPeriods.endsOn), gt(offRoadPeriods.endsOn, date)),
      ),
    )
    .limit(1);
  return !!row;
}
