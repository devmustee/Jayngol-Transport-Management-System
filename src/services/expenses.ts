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
import { notifyMany } from "./notifications";
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
        custodianId: input.source.custodianId,
        account: input.source.account,
        collectedOn: businessDate(now),
        collectedBy: ctx.actor.userId,
        createdAt: now,
      })
      .returning({ id: expenseAdvances.id });
    await takeMoneyOut(tx, {
      ...input.source,
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

const expenseSchema = z.object({
  description: requiredText("What it was for", 300),
  category: z.enum(expenseCategory.enumValues, "Choose a category"),
  amount: positiveNairaField("Amount"),
  spentOn: dateField("Date spent"),
  photo: photoField("Receipt"),
});

const correctionSchema = expenseSchema.omit({ photo: true });

/** A Manager's expense over this is reported to the owner, since nobody approves it. */
export const LARGE_EXPENSE_KOBO = 5_000_000;

/** The Manager's own expenses need no approval; everyone else's wait for the Manager. */
const finalOnSaving = (ctx: Ctx) => ctx.actor.role === "manager";

/** Expenses come straight off the company balance, never out of a person's cash in hand. */
const BALANCE = { custodianId: null, account: "bank" as const };

function refuseFuture(spentOn: string, now: Date) {
  if (spentOn > businessDate(now)) throw fieldError("spentOn", "This date cannot be in the future");
}

/**
 * An expense is money spent, recorded once: it comes off the company balance now
 * and waits for the Assistant Manager's approval. It is never paid back.
 */
export async function recordExpense(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "expense.record");
  const input = parseInput(expenseSchema, raw);
  const now = ctx.clock();
  refuseFuture(input.spentOn, now);
  return db.transaction(async (tx) => {
    const [advance] = await tx
      .insert(expenseAdvances)
      .values({
        purpose: input.description,
        amountKobo: input.amount,
        ...BALANCE,
        status: finalOnSaving(ctx) ? "countersigned" : "submitted",
        collectedOn: input.spentOn,
        collectedBy: ctx.actor.userId,
        createdAt: now,
        submittedAt: now,
        countersignedAt: finalOnSaving(ctx) ? now : null,
        oneStep: true,
      })
      .returning({ id: expenseAdvances.id });
    const id = advance!.id;
    await takeMoneyOut(tx, {
      ...BALANCE,
      amountKobo: input.amount,
      sourceType: "expense_advance",
      sourceId: id,
      at: now,
    });
    const photoId = input.photo ? await savePhoto(tx, ctx, input.photo) : null;
    await tx.insert(expenseLines).values({
      advanceId: id,
      kind: "spent",
      category: input.category,
      description: input.description,
      amountKobo: input.amount,
      spentOn: input.spentOn,
      photoId,
      createdBy: ctx.actor.userId,
      createdAt: now,
    });
    await auditFrom(ctx, tx, {
      action: "expense.record",
      entityType: "expense_advance",
      entityId: id,
      after: { amountKobo: input.amount, category: input.category, spentOn: input.spentOn },
    });
    if (finalOnSaving(ctx)) await tellOwner(tx, id, input.description, input.amount, now, ctx);
    return advance!;
  });
}

async function tellOwner(tx: Tx, id: string, description: string, amountKobo: number, at: Date, ctx: Ctx) {
  if (amountKobo <= LARGE_EXPENSE_KOBO) return;
  await notifyMany(tx, [
    {
      kind: "large_expense",
      body: `${formatNaira(amountKobo)}: ${description}`,
      at,
      link: `/expenses/${id}`,
      entity: { type: "expense_advance", id },
      dedupeKey: `large_expense:${id}:${amountKobo}`,
      createdBy: ctx.actor.userId,
    },
  ]);
}

/** The one spent line of an expense recorded in one step, or null for an older advance. */
async function singleLine(tx: Tx, advance: { id: string; amountKobo: number; oneStep: boolean }) {
  if (!advance.oneStep) return null;
  const lines = await tx
    .select({ line: expenseLines, voided: expenseLineVoids.lineId })
    .from(expenseLines)
    .leftJoin(expenseLineVoids, eq(expenseLineVoids.lineId, expenseLines.id))
    .where(eq(expenseLines.advanceId, advance.id));
  if (lines.some((row) => row.line.kind === "change")) return null;
  const active = lines.filter((row) => row.voided === null);
  if (active.length !== 1 || active[0]!.line.amountKobo !== advance.amountKobo) return null;
  return active[0]!.line;
}

type Correctable = {
  status: string;
  collectedBy: string;
  countersignedBy: string | null;
  createdAt: Date;
};

/**
 * Whether the person may still correct or remove an expense: their own one sent
 * back, or the Manager's own one (which nobody approves) on the day it was saved.
 */
export function correctableBy(ctx: Ctx, advance: Correctable): "sent_back" | "same_day" | null {
  if (advance.collectedBy !== ctx.actor.userId) return null;
  if (advance.status === "open") return "sent_back";
  const sameDay = businessDate(advance.createdAt) === businessDate(ctx.clock());
  if (advance.status === "countersigned" && advance.countersignedBy === null && finalOnSaving(ctx) && sameDay) {
    return "same_day";
  }
  return null;
}

function requireCorrectable(ctx: Ctx, advance: Correctable) {
  const how = correctableBy(ctx, advance);
  if (how) return how;
  if (advance.status === "countersigned") throw new DomainError("This expense is approved and final.");
  if (advance.collectedBy !== ctx.actor.userId && advance.status !== "cancelled") {
    throw new DomainError("Only the person who recorded it can correct it.");
  }
  throw new DomainError("Only an expense sent back can be corrected.");
}

/**
 * Corrects a wrong entry: one sent back goes for approval again, the Manager's
 * own stays final. The money moves by the difference only.
 */
export async function correctExpense(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "expense.record");
  const id = parseInput(idField("expense"), rawId);
  const input = parseInput(correctionSchema, raw);
  const now = ctx.clock();
  refuseFuture(input.spentOn, now);
  await db.transaction(async (tx) => {
    const advance = await lockAdvance(tx, id);
    const how = requireCorrectable(ctx, advance);
    const line = await singleLine(tx, advance);
    if (!line) throw new DomainError("This older record is corrected line by line.");
    const difference = input.amount - advance.amountKobo;
    const money = { custodianId: advance.custodianId, account: advance.account, sourceId: id, at: now };
    if (difference > 0) {
      await takeMoneyOut(tx, { ...money, amountKobo: difference, sourceType: "expense_advance" }, "amount");
    } else if (difference < 0) {
      await recordMovement(tx, { ...money, amountKobo: -difference, sourceType: "expense_advance_cancel" });
    }
    await tx.insert(expenseLineVoids).values({ lineId: line.id, voidedBy: ctx.actor.userId, reason: "Corrected", voidedAt: now });
    await tx.insert(expenseLines).values({
      advanceId: id,
      kind: "spent",
      category: input.category,
      description: input.description,
      amountKobo: input.amount,
      spentOn: input.spentOn,
      photoId: line.photoId,
      createdBy: ctx.actor.userId,
      createdAt: now,
    });
    await tx
      .update(expenseAdvances)
      .set({
        purpose: input.description,
        amountKobo: input.amount,
        collectedOn: input.spentOn,
        // Sent back: it goes for approval again. The Manager's own stays final.
        ...(how === "sent_back" ? { status: "submitted" as const, submittedAt: now, returnNote: null } : {}),
      })
      .where(eq(expenseAdvances.id, id));
    if (how === "same_day") await tellOwner(tx, id, input.description, input.amount, now, ctx);
    await auditFrom(ctx, tx, {
      action: "expense.correct",
      entityType: "expense_advance",
      entityId: id,
      before: { amountKobo: line.amountKobo, category: line.category, spentOn: line.spentOn },
      after: { amountKobo: input.amount, category: input.category, spentOn: input.spentOn },
    });
  });
}

/**
 * Removes an expense entered by mistake while it can still be corrected, and
 * puts the money back on the balance. Not a refund.
 */
export async function removeExpense(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "expense.record");
  const id = parseInput(idField("expense"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const advance = await lockAdvance(tx, id);
    requireCorrectable(ctx, advance);
    const line = await singleLine(tx, advance);
    if (!line) throw new DomainError("This older record is corrected line by line.");
    await tx.insert(expenseLineVoids).values({ lineId: line.id, voidedBy: ctx.actor.userId, reason, voidedAt: now });
    await tx
      .update(expenseAdvances)
      .set({ status: "cancelled", cancelReason: reason })
      .where(eq(expenseAdvances.id, id));
    await recordMovement(tx, {
      custodianId: advance.custodianId,
      account: advance.account,
      amountKobo: advance.amountKobo,
      sourceType: "expense_advance_cancel",
      sourceId: id,
      at: now,
    });
    await auditFrom(ctx, tx, { action: "expense.remove", entityType: "expense_advance", entityId: id, reason });
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
        account: advance.account,
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
        account: advance.account,
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

/**
 * Sends a fully accounted record on. The Manager's own needs no approval, so it
 * is final at once; anyone else's waits for the Manager.
 */
async function sendOn(tx: Tx, advance: { id: string; collectedBy: string }, now: Date) {
  const [recorder] = await tx.select({ role: users.role }).from(users).where(eq(users.id, advance.collectedBy));
  await tx
    .update(expenseAdvances)
    .set(
      recorder?.role === "manager"
        ? { status: "countersigned", submittedAt: now, countersignedAt: now, returnNote: null }
        : { status: "submitted", submittedAt: now, returnNote: null },
    )
    .where(eq(expenseAdvances.id, advance.id));
}

export async function submitAdvance(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "expense.record");
  const id = parseInput(idField("expense record"), rawId);
  await db.transaction(async (tx) => {
    const advance = await lockAdvance(tx, id);
    requireOpen(advance);
    const left = advance.amountKobo - (await accountedFor(tx, id));
    if (left !== 0) throw new DomainError(`${formatNaira(left)} is still to be accounted for.`);
    await sendOn(tx, advance, ctx.clock());
    await auditFrom(ctx, tx, { action: "expense.submit", entityType: "expense_advance", entityId: id });
  });
}

/** What is left on an older record when it is finished without being itemised. */
export const REST_OF_FUNDS = "Rest of the funds, not itemised";

/**
 * Finishes an older record from when funds were collected first. Whatever was
 * not itemised is counted as spent under Other, since money is not paid back.
 */
export async function finishAdvance(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "expense.record");
  const id = parseInput(idField("expense record"), rawId);
  await db.transaction(async (tx) => {
    const advance = await lockAdvance(tx, id);
    requireOpen(advance);
    if (advance.oneStep) throw new DomainError("Correct this expense instead.");
    const now = ctx.clock();
    const left = advance.amountKobo - (await accountedFor(tx, id));
    if (left > 0) {
      await tx.insert(expenseLines).values({
        advanceId: id,
        kind: "spent",
        category: "other",
        description: REST_OF_FUNDS,
        amountKobo: left,
        spentOn: businessDate(now),
        createdBy: ctx.actor.userId,
        createdAt: now,
      });
    }
    await sendOn(tx, advance, now);
    await auditFrom(ctx, tx, {
      action: "expense.finish",
      entityType: "expense_advance",
      entityId: id,
      after: { otherKobo: left },
    });
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
    const advance = await requireSubmitted(tx, id);
    if (advance.collectedBy === ctx.actor.userId) {
      throw new DomainError("Someone else must approve an expense you recorded.");
    }
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
      account: advance.account,
      amountKobo: advance.amountKobo,
      sourceType: "expense_advance_cancel",
      sourceId: id,
      at: now,
    });
    await auditFrom(ctx, tx, { action: "expense.cancel", entityType: "expense_advance", entityId: id, reason });
  });
}

/** What waits on this person: expenses to approve, and their own sent back. */
export async function advanceCounts(ctx: Ctx) {
  const mine = eq(expenseAdvances.collectedBy, ctx.actor.userId);
  const [toApprove, sentBack] = await Promise.all([
    can(ctx.actor.role, "expense.countersign")
      ? db
          .select({ value: count() })
          .from(expenseAdvances)
          .where(and(eq(expenseAdvances.status, "submitted"), sql`NOT ${mine}`))
      : Promise.resolve([{ value: 0 }]),
    db
      .select({ value: count() })
      .from(expenseAdvances)
      .where(and(eq(expenseAdvances.status, "open"), mine, sql`${expenseAdvances.returnNote} IS NOT NULL`)),
  ]);
  return { toApprove: toApprove[0]?.value ?? 0, sentBack: sentBack[0]?.value ?? 0 };
}

export async function listAdvances(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const monthStart = `${today.slice(0, 7)}-01`;
  const listed = () =>
    db
      .select({
        id: expenseAdvances.id,
        purpose: expenseAdvances.purpose,
        amountKobo: expenseAdvances.amountKobo,
        status: expenseAdvances.status,
        collectedOn: expenseAdvances.collectedOn,
        collectedBy: expenseAdvances.collectedBy,
        countersignedBy: expenseAdvances.countersignedBy,
        returnNote: expenseAdvances.returnNote,
        accountedKobo: accounted,
        oneStep: expenseAdvances.oneStep,
        recordedBy: users.name,
      })
      .from(expenseAdvances)
      .innerJoin(users, eq(users.id, expenseAdvances.collectedBy))
      .orderBy(desc(expenseAdvances.collectedOn), desc(expenseAdvances.createdAt));
  const [waiting, approved, month] = await Promise.all([
    // Everything still waiting on someone is always listed; approved ones only the latest.
    listed().where(inArray(expenseAdvances.status, ["open", "submitted"])),
    listed().where(eq(expenseAdvances.status, "countersigned")).limit(100),
    // Same rule as the report: spent lines by the day spent, voided lines and removed records left out.
    db.execute(sql`
      SELECT COALESCE(SUM(l.amount_kobo), 0)::float8 AS total FROM expense_lines l
      JOIN expense_advances a ON a.id = l.advance_id AND a.status <> 'cancelled'
      WHERE l.kind = 'spent' AND l.spent_on BETWEEN ${monthStart}::date AND ${today}::date
        AND NOT EXISTS (SELECT 1 FROM expense_line_voids v WHERE v.line_id = l.id)
    `) as unknown as Promise<{ total: number }[]>,
  ]);
  const open = waiting.filter((row) => row.status === "open");
  return {
    sentBack: open.filter((row) => row.oneStep),
    /** Older records from when funds were collected first (phase 3 clears these). */
    older: open.filter((row) => !row.oneStep),
    submitted: waiting.filter((row) => row.status === "submitted"),
    done: approved,
    spentThisMonthKobo: month[0]?.total ?? 0,
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
  const oneStepRecord = advance.oneStep;
  const single =
    !lines.some((row) => row.line.kind === "change") &&
    active.length === 1 &&
    active[0]!.line.kind === "spent" &&
    active[0]!.line.amountKobo === advance.amountKobo;
  const accountedKobo = active.reduce((sum, row) => sum + row.line.amountKobo, 0);
  return {
    advance,
    lines,
    single,
    /** Recorded in one step, so shown as one expense rather than funds to account for. */
    oneStep: oneStepRecord,
    /** How this person may still correct or remove it, if at all. */
    correctable: single && oneStepRecord && can(ctx.actor.role, "expense.record") ? correctableBy(ctx, advance) : null,
    /** The Manager's own expense: final on saving, approved by nobody. */
    noApprovalNeeded: advance.status === "countersigned" && advance.countersignedBy === null,
    accountedKobo,
    leftKobo: advance.amountKobo - accountedKobo,
    spentKobo: active.filter((row) => row.line.kind === "spent").reduce((sum, row) => sum + row.line.amountKobo, 0),
    collectedByName: nameOf(advance.collectedBy),
    countersignedByName: nameOf(advance.countersignedBy),
    sourceName: nameOf(advance.custodianId),
    sourceAccount: advance.account,
    canRecord: can(ctx.actor.role, "expense.record"),
    canCountersign: can(ctx.actor.role, "expense.countersign"),
  };
}
