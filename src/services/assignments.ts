import { and, asc, desc, eq, gt, gte, isNull, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import { assignments, balanceRates, offRoadPeriods, operators, tricycleBalances, tricycles, workOrders } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { dailyBalanceField, dateField, idField, optionalText, requiredText } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { voidBalancesAfter } from "./ledger";
import { notifyOperators } from "./notices";

const issueSchema = z.object({
  tricycleId: idField("tricycle"),
  operatorId: idField("operator"),
  issuedOn: dateField("Date issued"),
});

const returnSchema = z.object({
  returnedOn: dateField("Date returned"),
  reason: z.enum(["reassigned", "operator_left", "tricycle_retired", "other"], "Choose a reason"),
  note: optionalText(),
});

const balanceSchema = z.object({
  dailyBalance: dailyBalanceField,
  effectiveFrom: dateField("Start date"),
  reason: requiredText("Reason", 500),
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

      // The operator is charged the tricycle's own amount, including any change
      // already set to start after the issue date.
      const rates = scheduleFrom(await balancesOf(tx, tricycle.id), input.issuedOn);
      if (rates === "not_set") {
        throw fieldError("tricycleId", "Set this tricycle's daily balance first");
      }
      if (rates === "not_yet") {
        throw fieldError("issuedOn", "This tricycle has no daily balance on that date");
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
      await tx.insert(balanceRates).values(
        rates.map((rate) => ({
          assignmentId: assignment!.id,
          amountKobo: rate.amountKobo,
          effectiveFrom: rate.effectiveFrom,
          createdBy: ctx.actor.userId,
        })),
      );
      await tx.update(tricycles).set({ status: "issued" }).where(eq(tricycles.id, tricycle.id));
      await auditFrom(ctx, tx, {
        action: "assignment.issue",
        entityType: "tricycle",
        entityId: tricycle.id,
        after: {
          operatorId: operator.id,
          issuedOn: input.issuedOn,
          dailyBalanceKobo: rates[0]!.amountKobo,
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
 * Changes a tricycle's daily balance from a date. If it is with an operator,
 * their charges follow from that date. A change cannot start in the past:
 * daily balances already raised were charged at the amount in force then.
 */
export async function changeTricycleBalance(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "rate.change");
  const id = parseInput(idField("tricycle"), rawId);
  const input = parseInput(balanceSchema, raw);
  if (input.effectiveFrom < businessDate(ctx.clock())) {
    throw fieldError("effectiveFrom", "A new daily balance cannot start in the past");
  }

  await db.transaction(async (tx) => {
    const [tricycle] = await tx.select().from(tricycles).where(eq(tricycles.id, id)).for("update");
    if (!tricycle) throw new DomainError("Tricycle not found.");
    if (tricycle.status === "retired") throw new DomainError("A retired tricycle has no daily balance.");

    const before = await balanceOn(tx, id, input.effectiveFrom);
    await tx.insert(tricycleBalances).values({
      tricycleId: id,
      amountKobo: input.dailyBalance,
      effectiveFrom: input.effectiveFrom,
      reason: input.reason,
      createdBy: ctx.actor.userId,
    });

    const [open] = await tx
      .select()
      .from(assignments)
      .where(and(eq(assignments.tricycleId, id), isNull(assignments.returnedOn)))
      .for("update");
    if (open) {
      await tx.insert(balanceRates).values({
        assignmentId: open.id,
        amountKobo: input.dailyBalance,
        effectiveFrom: input.effectiveFrom,
        createdBy: ctx.actor.userId,
      });
      const from = before === null ? "" : ` from ${formatNaira(before)}`;
      await notifyOperators(tx, ctx.clock(), [
        {
          operatorId: open.operatorId,
          kind: "balance_changed",
          body: `Your daily balance for ${tricycle.codeNumber} changes${from} to ${formatNaira(input.dailyBalance)}, starting ${formatDate(input.effectiveFrom)}.`,
        },
      ]);
    }

    await auditFrom(ctx, tx, {
      action: "tricycle.change_balance",
      entityType: "tricycle",
      entityId: id,
      before: { dailyBalanceKobo: before },
      after: {
        dailyBalanceKobo: input.dailyBalance,
        effectiveFrom: input.effectiveFrom,
        operatorId: open?.operatorId ?? null,
      },
      reason: input.reason,
    });
  });
}

type BalanceRow = { amountKobo: number; effectiveFrom: string; createdAt: Date };

const balancesOf = (exec: Executor, tricycleId: string): Promise<BalanceRow[]> =>
  exec
    .select({
      amountKobo: tricycleBalances.amountKobo,
      effectiveFrom: tricycleBalances.effectiveFrom,
      createdAt: tricycleBalances.createdAt,
    })
    .from(tricycleBalances)
    .where(eq(tricycleBalances.tricycleId, tricycleId))
    .orderBy(asc(tricycleBalances.effectiveFrom), asc(tricycleBalances.createdAt));

/**
 * The amounts to charge from `from` onwards: the one in force that day, then
 * each later change. Where two rows start the same day, the newer one wins.
 */
export function scheduleFrom(rows: BalanceRow[], from: string) {
  if (rows.length === 0) return "not_set" as const;
  const byDate = new Map<string, number>();
  for (const row of rows) byDate.set(row.effectiveFrom, row.amountKobo);
  const dates = [...byDate.keys()].sort();
  const start = dates.filter((d) => d <= from).at(-1);
  if (!start) return "not_yet" as const;
  return [
    { effectiveFrom: from, amountKobo: byDate.get(start)! },
    ...dates.filter((d) => d > from).map((d) => ({ effectiveFrom: d, amountKobo: byDate.get(d)! })),
  ];
}

/** A tricycle's daily balance on a date, or null when none is set by then. */
export async function balanceOn(exec: Executor, tricycleId: string, date: string): Promise<number | null> {
  const [row] = await exec
    .select({ amountKobo: tricycleBalances.amountKobo })
    .from(tricycleBalances)
    .where(and(eq(tricycleBalances.tricycleId, tricycleId), lte(tricycleBalances.effectiveFrom, date)))
    .orderBy(desc(tricycleBalances.effectiveFrom), desc(tricycleBalances.createdAt))
    .limit(1);
  return row?.amountKobo ?? null;
}

/** Every amount a tricycle has had, newest first. */
export const tricycleBalanceHistory = (tricycleId: string) =>
  db
    .select({
      id: tricycleBalances.id,
      amountKobo: tricycleBalances.amountKobo,
      effectiveFrom: tricycleBalances.effectiveFrom,
      reason: tricycleBalances.reason,
      createdAt: tricycleBalances.createdAt,
    })
    .from(tricycleBalances)
    .where(eq(tricycleBalances.tricycleId, tricycleId))
    .orderBy(desc(tricycleBalances.effectiveFrom), desc(tricycleBalances.createdAt));

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
