import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import {
  charges,
  meetings,
  operators,
  photos,
  rules,
  smsOutbox,
  stickerIncidents,
  tricycles,
  users,
  violations,
} from "@/db/schema";
import { addDays, businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput } from "@/lib/errors";
import { idField, optionalText, requiredText } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { photoBytes, photoField } from "@/lib/photo";
import { holderOn, offRoadOn } from "./assignments";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { applyCredit, voidCharge } from "./ledger";

/** The fine for a rule on a date, read when the offence happens. */
export async function ruleAmount(exec: Executor, code: string, date: string): Promise<number> {
  const [row] = await exec
    .select({ amountKobo: rules.amountKobo })
    .from(rules)
    .where(and(eq(rules.code, code), lte(rules.effectiveFrom, date)))
    .orderBy(desc(rules.effectiveFrom))
    .limit(1);
  if (!row) throw new Error(`No amount configured for rule ${code}`);
  return row.amountKobo;
}

export async function savePhoto(tx: Tx, ctx: Ctx, dataUrl: string) {
  const [row] = await tx
    .insert(photos)
    .values({ data: photoBytes(dataUrl), uploadedBy: ctx.actor.userId, createdAt: ctx.clock() })
    .returning({ id: photos.id });
  return row!.id;
}

export async function proposeViolation(
  tx: Tx,
  ctx: Ctx,
  input: {
    ruleCode: string;
    operatorId: string;
    tricycleId: string | null;
    occurredOn: string;
    occurrenceKey: string;
    photoId?: string | null;
    note?: string | null;
  },
) {
  const amountKobo = await ruleAmount(tx, input.ruleCode, input.occurredOn);
  const [row] = await tx
    .insert(violations)
    .values({
      ...input,
      amountKobo,
      status: "proposed",
      raisedBy: ctx.actor.userId,
      createdAt: ctx.clock(),
    })
    .onConflictDoNothing()
    .returning({ id: violations.id });
  if (row) {
    await auditFrom(ctx, tx, {
      action: "violation.propose",
      entityType: "operator",
      entityId: input.operatorId,
      after: { rule: input.ruleCode, occurredOn: input.occurredOn, amountKobo },
    });
  }
  return row ?? null;
}

async function lockViolation(tx: Tx, id: string) {
  const [row] = await tx.select().from(violations).where(eq(violations.id, id)).for("update");
  if (!row) throw new DomainError("Offence not found.");
  return row;
}

export async function confirmViolation(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "violation.confirm");
  const id = parseInput(idField("offence"), rawId);
  await db.transaction(async (tx) => {
    const v = await lockViolation(tx, id);
    if (v.status !== "proposed") throw new DomainError("This offence has already been decided.");
    if (v.raisedBy === ctx.actor.userId) {
      throw new DomainError("Someone else must confirm an offence you raised.");
    }
    const [charge] = await tx
      .insert(charges)
      .values({
        type: "penalty",
        operatorId: v.operatorId,
        tricycleId: v.tricycleId,
        amountKobo: v.amountKobo,
        businessDate: v.occurredOn,
      })
      .returning({ id: charges.id });
    await tx
      .update(violations)
      .set({
        status: "confirmed",
        chargeId: charge!.id,
        decidedBy: ctx.actor.userId,
        decidedAt: ctx.clock(),
      })
      .where(eq(violations.id, id));
    const [operator] = await tx.select({ phone: operators.phone }).from(operators).where(eq(operators.id, v.operatorId));
    await tx.insert(smsOutbox).values({
      toPhone: operator!.phone,
      kind: "offence",
      createdAt: ctx.clock(),
      body: `Jayngol: Offence on ${formatDate(v.occurredOn)}: ${RULE_NAMES[v.ruleCode] ?? v.ruleCode}. Fine ${formatNaira(v.amountKobo)}.`,
    });
    await auditFrom(ctx, tx, {
      action: "violation.confirm",
      entityType: "operator",
      entityId: v.operatorId,
      after: { rule: v.ruleCode, amountKobo: v.amountKobo },
    });
  });
}

const reasonSchema = z.object({ reason: requiredText("Reason", 500) });

export async function rejectViolation(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "violation.confirm");
  const id = parseInput(idField("offence"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  await db.transaction(async (tx) => {
    const v = await lockViolation(tx, id);
    if (v.status !== "proposed") throw new DomainError("This offence has already been decided.");
    await tx
      .update(violations)
      .set({
        status: "rejected",
        decidedBy: ctx.actor.userId,
        decidedAt: ctx.clock(),
        decisionReason: reason,
      })
      .where(eq(violations.id, id));
    // A rejected sticker report did not start a removal, so the next failed
    // check is a new report and not part of this one.
    await tx
      .update(stickerIncidents)
      .set({ closedOn: v.occurredOn })
      .where(and(eq(stickerIncidents.violationId, id), isNull(stickerIncidents.closedOn)));
    await auditFrom(ctx, tx, {
      action: "violation.reject",
      entityType: "operator",
      entityId: v.operatorId,
      after: { rule: v.ruleCode },
      reason,
    });
  });
}

export async function waiveViolation(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "violation.waive");
  const id = parseInput(idField("offence"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  await db.transaction(async (tx) => {
    const v = await lockViolation(tx, id);
    if (v.status !== "confirmed") throw new DomainError("Only a confirmed offence can be waived.");
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, v.operatorId)).for("update");
    if (v.chargeId) {
      await voidCharge(tx, v.chargeId, { userId: ctx.actor.userId, at: ctx.clock() }, reason);
      await applyCredit(tx, v.operatorId);
    }
    await tx
      .update(violations)
      .set({
        status: "waived",
        decidedBy: ctx.actor.userId,
        decidedAt: ctx.clock(),
        decisionReason: reason,
      })
      .where(eq(violations.id, id));
    await auditFrom(ctx, tx, {
      action: "violation.waive",
      entityType: "operator",
      entityId: v.operatorId,
      after: { rule: v.ruleCode, amountKobo: v.amountKobo },
      reason,
    });
  });
}

const lateWorkSchema = z.object({
  tricycleId: idField("tricycle"),
  trackerAt: z
    .string("Enter the time from the tracker")
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Enter the time from the tracker"),
  photo: photoField("Screenshot"),
  note: optionalText(500),
});

/**
 * R7. Times are WAT. A night runs from after 10:00 pm until 5:00 am and belongs
 * to the date it started on, so 10:30 pm and 1:00 am are the same offence.
 */
export async function raiseLateWork(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "violation.raise");
  const input = parseInput(lateWorkSchema, raw);
  if (!input.photo) throw fieldError("photo", "Add the tracker screenshot");

  const at = new Date(`${input.trackerAt}:00+01:00`);
  if (Number.isNaN(at.getTime())) throw fieldError("trackerAt", "Enter a real date and time");
  if (at > ctx.clock()) throw fieldError("trackerAt", "This time has not happened yet");

  const day = input.trackerAt.slice(0, 10);
  const time = input.trackerAt.slice(11);
  const night = time < "05:00" ? addDays(day, -1) : time > "22:00" ? day : null;
  if (!night) throw fieldError("trackerAt", "Only work after 10:00 pm and before 5:00 am is an offence");

  return db.transaction(async (tx) => {
    const [tricycle] = await tx
      .select({ id: tricycles.id })
      .from(tricycles)
      .where(eq(tricycles.id, input.tricycleId))
      .for("update");
    if (!tricycle) throw fieldError("tricycleId", "Choose a tricycle");
    if (await offRoadOn(tx, input.tricycleId, night)) {
      throw fieldError("tricycleId", "This tricycle was off the road that night");
    }
    const operatorId = await holderOn(tx, input.tricycleId, night);
    if (!operatorId) throw fieldError("tricycleId", "No operator held this tricycle that night");

    const photoId = await savePhoto(tx, ctx, input.photo!);
    const row = await proposeViolation(tx, ctx, {
      ruleCode: "R7",
      operatorId,
      tricycleId: input.tricycleId,
      occurredOn: night,
      occurrenceKey: `R7:${operatorId}:${night}`,
      photoId,
      note: input.note ?? null,
    });
    if (!row) throw new DomainError("This operator already has this offence for that night.");
    return row;
  });
}

/** What an operator sees: only decided offences, never unconfirmed reports. */
export async function getMyCompliance(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  const operatorId = ctx.actor.operatorId;
  if (!operatorId) throw new DomainError("This login is not linked to an operator.");
  const [offences, upcoming] = await Promise.all([
    db
      .select({
        id: violations.id,
        ruleCode: violations.ruleCode,
        status: violations.status,
        occurredOn: violations.occurredOn,
        amountKobo: violations.amountKobo,
        decisionReason: violations.decisionReason,
        note: violations.note,
        photoId: violations.photoId,
        tricycleCode: tricycles.codeNumber,
      })
      .from(violations)
      .leftJoin(tricycles, eq(tricycles.id, violations.tricycleId))
      .where(
        and(
          eq(violations.operatorId, operatorId),
          inArray(violations.status, ["confirmed", "waived"]),
        ),
      )
      .orderBy(desc(violations.occurredOn), desc(violations.createdAt))
      .limit(100),
    db
      .select({ id: meetings.id, title: meetings.title, scheduledFor: meetings.scheduledFor })
      .from(meetings)
      .where(
        and(
          eq(meetings.status, "scheduled"),
          gte(meetings.businessDate, businessDate(ctx.clock())),
        ),
      )
      .orderBy(asc(meetings.scheduledFor))
      .limit(5),
  ]);
  return { offences, upcoming };
}

const STATUSES = ["proposed", "confirmed", "rejected", "waived"] as const;

export async function listViolations(ctx: Ctx, status?: string) {
  requirePermission(ctx, "violation.view");
  const wanted = STATUSES.find((s) => s === status);
  return db
    .select({
      id: violations.id,
      ruleCode: violations.ruleCode,
      status: violations.status,
      occurredOn: violations.occurredOn,
      amountKobo: violations.amountKobo,
      raisedBy: violations.raisedBy,
      raisedByName: users.name,
      decisionReason: violations.decisionReason,
      note: violations.note,
      photoId: violations.photoId,
      operatorId: violations.operatorId,
      operatorName: operators.name,
      tricycleCode: tricycles.codeNumber,
    })
    .from(violations)
    .innerJoin(operators, eq(operators.id, violations.operatorId))
    .leftJoin(tricycles, eq(tricycles.id, violations.tricycleId))
    .leftJoin(users, eq(users.id, violations.raisedBy))
    .where(wanted ? eq(violations.status, wanted) : undefined)
    .orderBy(desc(violations.occurredOn), desc(violations.createdAt))
    .limit(200);
}

export const RULE_NAMES: Record<string, string> = {
  R1: "Balance not paid within 2 days",
  R2: "Tricycle not washed and polished",
  R3: "Late for service",
  R4: "Company sticker removed",
  R5: "At general meeting without tricycle",
  R6: "Absent from general meeting",
  R7: "Working after 10:00 pm",
  R8: "Came to pay balance without tricycle",
};
