import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { expenseAdvances, expenseLines, expenseLineVoids, expenseCategory, users } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField, idField, positiveNairaField, requiredText } from "@/lib/fields";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { photoField } from "@/lib/photo";
import { auditFrom } from "./audit";
import { moneySourceField, recordMovement, takeMoneyOut } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { savePhoto } from "./violations";

// Written out in full: Drizzle drops the table name on single-table selects, and
// a bare column here would bind to the inner query instead.
const accounted = sql<number>`COALESCE((
  SELECT SUM(l.amount_kobo) FROM expense_lines l
  WHERE l.advance_id = expense_advances.id
    AND NOT EXISTS (SELECT 1 FROM expense_line_voids v WHERE v.line_id = l.id)), 0)::float8`;

async function lockAdvance(tx: Tx, id: string) {
  const [advance] = await tx.select().from(expenseAdvances).where(eq(expenseAdvances.id, id)).for("update");
  if (!advance) throw new DomainError("Expense record not found.");
  return advance;
}

function requireOpen(advance: { status: string }) {
  if (advance.status !== "open") throw new DomainError("This can no longer be changed.");
}

async function accountedFor(tx: Tx, id: string) {
  const [row] = await tx
    .select({ total: accounted })
    .from(expenseAdvances)
    .where(eq(expenseAdvances.id, id));
  return row?.total ?? 0;
}

const advanceSchema = z.object({
  purpose: requiredText("Purpose", 300),
  amount: positiveNairaField("Amount"),
  source: moneySourceField,
});

export async function createAdvance(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "expense.record");
  const input = parseInput(advanceSchema, raw);
  const now = ctx.clock();
  return db.transaction(async (tx) => {
    const [advance] = await tx
      .insert(expenseAdvances)
      .values({
        purpose: input.purpose,
        amountKobo: input.amount,
        custodianId: input.source,
        collectedOn: businessDate(now),
        collectedBy: ctx.actor.userId,
        createdAt: now,
      })
      .returning({ id: expenseAdvances.id });
    await takeMoneyOut(tx, {
      custodianId: input.source,
      amountKobo: input.amount,
      sourceType: "expense_advance",
      sourceId: advance!.id,
      at: now,
    });
    await auditFrom(ctx, tx, {
      action: "expense.advance",
      entityType: "expense_advance",
      entityId: advance!.id,
      after: { amountKobo: input.amount, purpose: input.purpose },
    });
    return advance!;
  });
}

const lineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("spent"),
    category: z.enum(expenseCategory.enumValues, "Choose a category"),
    description: requiredText("What it was for", 300),
    amount: positiveNairaField("Amount"),
    spentOn: dateField("Date"),
    photo: photoField("Receipt"),
  }),
  z.object({ kind: z.literal("change"), amount: positiveNairaField("Amount") }),
]);

/** What was spent, or change handed back. The two together must come to the advance. */
export async function addExpenseLine(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "expense.record");
  const id = parseInput(idField("expense record"), rawId);
  const input = parseInput(lineSchema, raw);
  const now = ctx.clock();
  const today = businessDate(now);
  if (input.kind === "spent" && input.spentOn > today) {
    throw fieldError("spentOn", "This date cannot be in the future");
  }
  return db.transaction(async (tx) => {
    const advance = await lockAdvance(tx, id);
    requireOpen(advance);
    const left = advance.amountKobo - (await accountedFor(tx, id));
    if (input.amount > left) {
      throw fieldError("amount", `Only ${formatNaira(left)} is left to account for`);
    }
    const spent = input.kind === "spent" ? input : null;
    const photoId = spent?.photo ? await savePhoto(tx, ctx, spent.photo) : null;
    const [line] = await tx
      .insert(expenseLines)
      .values({
        advanceId: id,
        kind: input.kind,
        category: spent?.category ?? null,
        description: spent?.description ?? "Change returned",
        amountKobo: input.amount,
        spentOn: spent?.spentOn ?? today,
        photoId,
        createdBy: ctx.actor.userId,
        createdAt: now,
      })
      .returning({ id: expenseLines.id });
    if (input.kind === "change") {
      await recordMovement(tx, {
        custodianId: advance.custodianId,
        amountKobo: input.amount,
        sourceType: "expense_change",
        sourceId: line!.id,
        at: now,
      });
    }
    await auditFrom(ctx, tx, {
      action: "expense.line",
      entityType: "expense_advance",
      entityId: id,
      after: { kind: input.kind, amountKobo: input.amount },
    });
    return line!;
  });
}

const reasonSchema = z.object({ reason: requiredText("Reason", 500) });

export async function voidExpenseLine(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "expense.record");
  const id = parseInput(idField("entry"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const [line] = await tx.select().from(expenseLines).where(eq(expenseLines.id, id));
    if (!line) throw new DomainError("Entry not found.");
    const advance = await lockAdvance(tx, line.advanceId);
    requireOpen(advance);
    const [done] = await tx.select().from(expenseLineVoids).where(eq(expenseLineVoids.lineId, id));
    if (done) throw new DomainError("This entry has already been removed.");
    await tx.insert(expenseLineVoids).values({ lineId: id, voidedBy: ctx.actor.userId, reason, voidedAt: now });
    if (line.kind === "change") {
      await takeMoneyOut(tx, {
        custodianId: advance.custodianId,
        amountKobo: line.amountKobo,
        sourceType: "expense_change_void",
        sourceId: id,
        at: now,
      }).catch((error) => {
        if (error instanceof DomainError) {
          throw new DomainError("That cash has already left this person's hands, so the change cannot be removed today.");
        }
        throw error;
      });
    }
    await auditFrom(ctx, tx, {
      action: "expense.line_void",
      entityType: "expense_advance",
      entityId: line.advanceId,
      before: { kind: line.kind, amountKobo: line.amountKobo },
      reason,
    });
  });
}

export async function submitAdvance(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "expense.record");
  const id = parseInput(idField("expense record"), rawId);
  await db.transaction(async (tx) => {
    const advance = await lockAdvance(tx, id);
    requireOpen(advance);
    const left = advance.amountKobo - (await accountedFor(tx, id));
    if (left !== 0) throw new DomainError(`${formatNaira(left)} is still to be accounted for.`);
    await tx
      .update(expenseAdvances)
      .set({ status: "submitted", submittedAt: ctx.clock(), returnNote: null })
      .where(eq(expenseAdvances.id, id));
    await auditFrom(ctx, tx, { action: "expense.submit", entityType: "expense_advance", entityId: id });
  });
}

async function requireSubmitted(tx: Tx, id: string) {
  const advance = await lockAdvance(tx, id);
  if (advance.status !== "submitted") throw new DomainError("This is not waiting for a countersign.");
  return advance;
}

export async function countersignAdvance(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "expense.countersign");
  const id = parseInput(idField("expense record"), rawId);
  await db.transaction(async (tx) => {
    await requireSubmitted(tx, id);
    await tx
      .update(expenseAdvances)
      .set({ status: "countersigned", countersignedBy: ctx.actor.userId, countersignedAt: ctx.clock() })
      .where(eq(expenseAdvances.id, id));
    await auditFrom(ctx, tx, { action: "expense.countersign", entityType: "expense_advance", entityId: id });
  });
}

export async function sendBackAdvance(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "expense.countersign");
  const id = parseInput(idField("expense record"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  await db.transaction(async (tx) => {
    await requireSubmitted(tx, id);
    await tx
      .update(expenseAdvances)
      .set({ status: "open", submittedAt: null, returnNote: reason })
      .where(eq(expenseAdvances.id, id));
    await auditFrom(ctx, tx, { action: "expense.send_back", entityType: "expense_advance", entityId: id, reason });
  });
}

/** For funds recorded by mistake. Anything already accounted for must be removed first. */
export async function cancelAdvance(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "expense.record");
  const id = parseInput(idField("expense record"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const advance = await lockAdvance(tx, id);
    requireOpen(advance);
    if ((await accountedFor(tx, id)) > 0) throw new DomainError("Remove the entries on this record first.");
    await tx.update(expenseAdvances).set({ status: "cancelled", cancelReason: reason }).where(eq(expenseAdvances.id, id));
    await recordMovement(tx, {
      custodianId: advance.custodianId,
      amountKobo: advance.amountKobo,
      sourceType: "expense_advance_cancel",
      sourceId: id,
      at: now,
    });
    await auditFrom(ctx, tx, { action: "expense.cancel", entityType: "expense_advance", entityId: id, reason });
  });
}

export async function advanceCounts() {
  const rows = await db
    .select({ status: expenseAdvances.status, value: count() })
    .from(expenseAdvances)
    .where(inArray(expenseAdvances.status, ["open", "submitted"]))
    .groupBy(expenseAdvances.status);
  const of = (status: string) => rows.find((row) => row.status === status)?.value ?? 0;
  return { open: of("open"), submitted: of("submitted") };
}

export async function listAdvances(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const rows = await db
    .select({
      id: expenseAdvances.id,
      purpose: expenseAdvances.purpose,
      amountKobo: expenseAdvances.amountKobo,
      status: expenseAdvances.status,
      collectedOn: expenseAdvances.collectedOn,
      returnNote: expenseAdvances.returnNote,
      accountedKobo: accounted,
    })
    .from(expenseAdvances)
    .orderBy(desc(expenseAdvances.collectedOn), desc(expenseAdvances.createdAt))
    .limit(200);
  const open = rows.filter((row) => row.status === "open");
  return {
    open,
    outstandingKobo: open.reduce((sum, row) => sum + row.amountKobo - row.accountedKobo, 0),
    submitted: rows.filter((row) => row.status === "submitted"),
    done: rows.filter((row) => row.status === "countersigned"),
    canRecord: can(ctx.actor.role, "expense.record"),
  };
}

export async function getAdvance(ctx: Ctx, id: string) {
  requirePermission(ctx, "finance.view");
  const [advance] = await db.select().from(expenseAdvances).where(eq(expenseAdvances.id, id)).limit(1);
  if (!advance) return null;
  const lines = await db
    .select({ line: expenseLines, voidReason: expenseLineVoids.reason })
    .from(expenseLines)
    .leftJoin(expenseLineVoids, eq(expenseLineVoids.lineId, expenseLines.id))
    .where(eq(expenseLines.advanceId, id))
    .orderBy(asc(expenseLines.createdAt));
  const ids = [advance.collectedBy, advance.countersignedBy, advance.custodianId].filter((v): v is string => !!v);
  const people = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  const nameOf = (value: string | null) => people.find((person) => person.id === value)?.name ?? null;
  const active = lines.filter((row) => row.voidReason === null);
  const accountedKobo = active.reduce((sum, row) => sum + row.line.amountKobo, 0);
  return {
    advance,
    lines,
    accountedKobo,
    leftKobo: advance.amountKobo - accountedKobo,
    spentKobo: active.filter((row) => row.line.kind === "spent").reduce((sum, row) => sum + row.line.amountKobo, 0),
    collectedByName: nameOf(advance.collectedBy),
    countersignedByName: nameOf(advance.countersignedBy),
    sourceName: nameOf(advance.custodianId),
    canRecord: can(ctx.actor.role, "expense.record"),
    canCountersign: can(ctx.actor.role, "expense.countersign"),
  };
}
