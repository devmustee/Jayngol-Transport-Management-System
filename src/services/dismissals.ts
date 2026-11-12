import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db";
import { assignments, dismissals, operators, violations } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField, idField, requiredText } from "@/lib/fields";
import { closeAssignment, issueTricycle } from "./assignments";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { SACKING_DAYS } from "./daily-job";
import { openCharges, unpaidDaysBefore } from "./ledger";

async function lockFlagged(exec: Executor, id: string, status: "flagged" | "confirmed") {
  const [row] = await exec.select().from(dismissals).where(eq(dismissals.id, id)).for("update");
  if (!row) throw new DomainError("Record not found.");
  if (row.status !== status) throw new DomainError("This has already been decided.");
  return row;
}

export async function confirmSacking(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "dismissal.decide");
  const id = parseInput(idField("record"), rawId);
  const { returnedOn } = parseInput(z.object({ returnedOn: dateField("Date tricycle taken back") }), raw);
  const today = businessDate(ctx.clock());
  if (returnedOn > today) throw fieldError("returnedOn", "This date cannot be in the future");

  await db.transaction(async (tx) => {
    const row = await lockFlagged(tx, id, "flagged");
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, row.operatorId)).for("update");
    if ((await unpaidDaysBefore(tx, row.operatorId, today)) < SACKING_DAYS) {
      throw new DomainError("This operator has paid since the alert and is no longer at 5 unpaid days.");
    }

    const [open] = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.operatorId, row.operatorId), isNull(assignments.returnedOn)))
      .limit(1);
    if (open) await closeAssignment(tx, ctx, open.id, { returnedOn, reason: "sacked" });

    await tx.update(operators).set({ status: "sacked" }).where(eq(operators.id, row.operatorId));
    await tx
      .update(dismissals)
      .set({ status: "confirmed", confirmedBy: ctx.actor.userId, confirmedOn: today })
      .where(eq(dismissals.id, id));
    await auditFrom(ctx, tx, {
      action: "dismissal.confirm",
      entityType: "operator",
      entityId: row.operatorId,
      after: { returnedOn },
    });
  });
}

export async function clearSackingAlert(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "dismissal.decide");
  const id = parseInput(idField("record"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  await db.transaction(async (tx) => {
    const row = await lockFlagged(tx, id, "flagged");
    await tx
      .update(dismissals)
      .set({ status: "resolved", clearedBy: ctx.actor.userId, clearReason: reason })
      .where(eq(dismissals.id, id));
    await auditFrom(ctx, tx, {
      action: "dismissal.clear",
      entityType: "operator",
      entityId: row.operatorId,
      reason,
    });
  });
}

/** Outstanding on all daily balances and all late-balance fines. */
export async function appealDue(exec: Executor, operatorId: string) {
  const [balances, penalties, lateFines] = await Promise.all([
    openCharges(exec, operatorId, "daily_balance"),
    openCharges(exec, operatorId, "penalty"),
    exec
      .select({ chargeId: violations.chargeId })
      .from(violations)
      .where(
        and(
          eq(violations.operatorId, operatorId),
          eq(violations.ruleCode, "R1"),
          eq(violations.status, "confirmed"),
        ),
      ),
  ]);
  const lateFineIds = new Set(lateFines.map((v) => v.chargeId));
  return {
    balancesKobo: balances.reduce((s, c) => s + c.outstandingKobo, 0),
    finesKobo: penalties
      .filter((c) => lateFineIds.has(c.id))
      .reduce((s, c) => s + c.outstandingKobo, 0),
  };
}

const reinstateSchema = z.object({
  tricycleId: idField("tricycle"),
  issuedOn: dateField("Date issued"),
});

export async function reinstateOperator(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "dismissal.decide");
  const id = parseInput(idField("record"), rawId);
  const input = parseInput(reinstateSchema, raw);

  await db.transaction(async (tx) => {
    const row = await lockFlagged(tx, id, "confirmed");
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, row.operatorId)).for("update");

    const due = await appealDue(tx, row.operatorId);
    if (due.balancesKobo > 0 || due.finesKobo > 0) {
      throw new DomainError(
        "All unpaid balances and late-payment fines must be paid before this operator can return.",
      );
    }

    await tx.update(operators).set({ status: "active" }).where(eq(operators.id, row.operatorId));
    await issueTricycle(
      ctx,
      { ...raw as object, operatorId: row.operatorId },
      tx,
    );
    await tx
      .update(dismissals)
      .set({
        status: "reinstated",
        reinstatedBy: ctx.actor.userId,
        reinstatedOn: businessDate(ctx.clock()),
      })
      .where(eq(dismissals.id, id));
    await auditFrom(ctx, tx, {
      action: "dismissal.reinstate",
      entityType: "operator",
      entityId: row.operatorId,
      after: { tricycleId: input.tricycleId, issuedOn: input.issuedOn },
    });
  });
}

export async function listDismissals(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const rows = await db
    .select({
      id: dismissals.id,
      status: dismissals.status,
      unpaidDays: dismissals.unpaidDays,
      flaggedOn: dismissals.flaggedOn,
      confirmedOn: dismissals.confirmedOn,
      operatorId: dismissals.operatorId,
      operatorName: operators.name,
    })
    .from(dismissals)
    .innerJoin(operators, eq(operators.id, dismissals.operatorId))
    .where(inArray(dismissals.status, ["flagged", "confirmed"]))
    .orderBy(desc(dismissals.flaggedOn));

  return Promise.all(
    rows.map(async (row) => ({ ...row, due: await appealDue(db, row.operatorId) })),
  );
}
