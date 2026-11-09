import { and, asc, count, desc, eq, gt, gte, isNull, lte, min, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import {
  assignments,
  inspections,
  operators,
  photos,
  stickerIncidents,
  tricycles,
  users,
  violations,
} from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField, idField, optionalText } from "@/lib/fields";
import { can } from "@/lib/permissions";
import { photoField } from "@/lib/photo";
import { holderOn, offRoadOn } from "./assignments";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { proposeViolation, savePhoto } from "./violations";

const FIVE_MINUTES = 5 * 60 * 1000;
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

const inspectionSchema = z.object({
  clientId: idField("submission"),
  tricycleId: idField("tricycle"),
  washed: z.boolean("Say whether it was washed"),
  stickerIntact: z.boolean("Say whether the sticker is there"),
  note: optionalText(500),
  photo: photoField("Photo"),
  inspectedAt: z.iso.datetime("Invalid inspection time").transform((value) => new Date(value)),
});

export type InspectionOutcome = "saved" | "already_saved" | "already_inspected";

/**
 * Safe to send repeatedly: the phone's queue resends until it gets an answer.
 * The date comes from when the supervisor inspected, not when signal returned.
 */
export async function recordInspection(
  ctx: Ctx,
  raw: unknown,
): Promise<{ outcome: InspectionOutcome }> {
  requirePermission(ctx, "inspection.record");
  const input = parseInput(inspectionSchema, raw);

  const now = ctx.clock().getTime();
  if (input.inspectedAt.getTime() > now + FIVE_MINUTES) {
    throw new DomainError("This phone's clock is ahead. Correct the time and inspect again.");
  }
  if (now - input.inspectedAt.getTime() > THREE_DAYS) {
    throw new DomainError("This inspection is more than 3 days old and can no longer be sent.");
  }
  if ((!input.washed || !input.stickerIntact) && !input.photo) {
    throw fieldError("photo", "Take a photo of the problem");
  }
  const date = businessDate(input.inspectedAt);

  return db.transaction(async (tx) => {
    // Locking the tricycle puts two phones inspecting it at once in a queue.
    const [tricycle] = await tx
      .select({ status: tricycles.status })
      .from(tricycles)
      .where(eq(tricycles.id, input.tricycleId))
      .for("update");
    if (!tricycle) throw new DomainError("Tricycle not found.");

    const [sameSubmission] = await tx
      .select({ id: inspections.id })
      .from(inspections)
      .where(eq(inspections.clientId, input.clientId))
      .limit(1);
    if (sameSubmission) return { outcome: "already_saved" as const };

    const [sameDay] = await tx
      .select({ id: inspections.id })
      .from(inspections)
      .where(and(eq(inspections.tricycleId, input.tricycleId), eq(inspections.businessDate, date)))
      .limit(1);
    if (sameDay) return { outcome: "already_inspected" as const };

    if (await offRoadOn(tx, input.tricycleId, date)) {
      throw new DomainError("This tricycle is off the road, so it is not inspected.");
    }
    const operatorId = await holderOn(tx, input.tricycleId, date);
    if (!operatorId) throw new DomainError("No operator held this tricycle on that day.");

    const photoId = input.photo ? await savePhoto(tx, ctx, input.photo) : null;
    await tx.insert(inspections).values({
      tricycleId: input.tricycleId,
      operatorId,
      inspectedBy: ctx.actor.userId,
      businessDate: date,
      washed: input.washed,
      stickerIntact: input.stickerIntact,
      note: input.note ?? null,
      photoId,
      clientId: input.clientId,
      inspectedAt: input.inspectedAt,
      recordedAt: ctx.clock(),
    });
    await auditFrom(ctx, tx, {
      action: "inspection.record",
      entityType: "tricycle",
      entityId: input.tricycleId,
      after: { date, washed: input.washed, stickerIntact: input.stickerIntact },
    });

    const shared = { operatorId, tricycleId: input.tricycleId, occurredOn: date, photoId, note: input.note ?? null };
    if (!input.washed) {
      await proposeViolation(tx, ctx, {
        ...shared,
        ruleCode: "R2",
        occurrenceKey: `R2:${input.tricycleId}:${date}`,
      });
    }
    if (input.stickerIntact) {
      await stickerSeen(tx, input.tricycleId, date);
    } else {
      await stickerMissing(tx, ctx, shared);
    }
    return { outcome: "saved" as const };
  });
}

/**
 * A sticker back in place ends the removal. Offline phones can deliver out of
 * order, so an older good report must not end a removal seen more recently.
 */
async function stickerSeen(tx: Tx, tricycleId: string, date: string) {
  const [open] = await tx
    .select()
    .from(stickerIncidents)
    .where(and(eq(stickerIncidents.tricycleId, tricycleId), isNull(stickerIncidents.closedOn)))
    .limit(1);
  if (!open || open.openedOn >= date) return;
  const [laterFailure] = await tx
    .select({ id: inspections.id })
    .from(inspections)
    .where(
      and(
        eq(inspections.tricycleId, tricycleId),
        gt(inspections.businessDate, date),
        eq(inspections.stickerIntact, false),
      ),
    )
    .limit(1);
  if (laterFailure) return;
  await tx.update(stickerIncidents).set({ closedOn: date }).where(eq(stickerIncidents.id, open.id));
}

/** One fine per removal, however many days it stays missing (R4). */
async function stickerMissing(
  tx: Tx,
  ctx: Ctx,
  input: {
    operatorId: string;
    tricycleId: string;
    occurredOn: string;
    photoId: string | null;
    note: string | null;
  },
) {
  const { tricycleId, occurredOn: date } = input;
  const [covering] = await tx
    .select({ id: stickerIncidents.id })
    .from(stickerIncidents)
    .where(
      and(
        eq(stickerIncidents.tricycleId, tricycleId),
        lte(stickerIncidents.openedOn, date),
        or(isNull(stickerIncidents.closedOn), gt(stickerIncidents.closedOn, date)),
      ),
    )
    .limit(1);
  if (covering) return;

  // A report that arrives late may belong to a removal already on record.
  const [{ nextGood } = { nextGood: null }] = await tx
    .select({ nextGood: min(inspections.businessDate) })
    .from(inspections)
    .where(
      and(
        eq(inspections.tricycleId, tricycleId),
        gt(inspections.businessDate, date),
        eq(inspections.stickerIntact, true),
      ),
    );
  const [later] = await tx
    .select({ id: stickerIncidents.id, openedOn: stickerIncidents.openedOn })
    .from(stickerIncidents)
    .where(and(eq(stickerIncidents.tricycleId, tricycleId), gt(stickerIncidents.openedOn, date)))
    .orderBy(asc(stickerIncidents.openedOn))
    .limit(1);
  if (later && (!nextGood || later.openedOn <= nextGood)) {
    await tx
      .update(stickerIncidents)
      .set({ openedOn: date })
      .where(eq(stickerIncidents.id, later.id));
    return;
  }

  const [incident] = await tx
    .insert(stickerIncidents)
    .values({ tricycleId, openedOn: date, closedOn: nextGood })
    .returning({ id: stickerIncidents.id });
  const violation = await proposeViolation(tx, ctx, {
    ...input,
    ruleCode: "R4",
    occurrenceKey: `R4:${incident!.id}`,
  });
  await tx
    .update(stickerIncidents)
    .set({ violationId: violation?.id ?? null })
    .where(eq(stickerIncidents.id, incident!.id));
}

/** Every tricycle out with an operator today, inspected or not. */
export async function inspectionToday(ctx: Ctx) {
  requirePermission(ctx, "inspection.record");
  const date = businessDate(ctx.clock());
  const items = await db
    .select({
      tricycleId: tricycles.id,
      code: tricycles.codeNumber,
      registration: tricycles.registrationNumber,
      operatorName: operators.name,
      washed: inspections.washed,
      stickerIntact: inspections.stickerIntact,
    })
    .from(assignments)
    .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
    .innerJoin(operators, eq(operators.id, assignments.operatorId))
    .leftJoin(
      inspections,
      and(eq(inspections.tricycleId, tricycles.id), eq(inspections.businessDate, date)),
    )
    .where(and(isNull(assignments.returnedOn), eq(tricycles.status, "issued")))
    .orderBy(asc(tricycles.codeNumber));
  return { date, items };
}

const coverageSchema = z.object({ date: dateField("Date") });

/** Who was inspected on a date, who was missed, and how much each supervisor did. */
export async function inspectionCoverage(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "inspection.report");
  const { date } = parseInput(coverageSchema, raw);
  const [rows, bySupervisor] = await Promise.all([
    db
      .select({
        tricycleId: tricycles.id,
        code: tricycles.codeNumber,
        operatorName: operators.name,
        inspectionId: inspections.id,
      })
      .from(assignments)
      .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
      .innerJoin(operators, eq(operators.id, assignments.operatorId))
      .leftJoin(
        inspections,
        and(eq(inspections.tricycleId, tricycles.id), eq(inspections.businessDate, date)),
      )
      .where(
        and(
          lte(assignments.issuedOn, date),
          or(isNull(assignments.returnedOn), gte(assignments.returnedOn, date)),
          sql`NOT EXISTS (
            SELECT 1 FROM off_road_periods p
            WHERE p.tricycle_id = ${tricycles.id} AND p.starts_on <= ${date}
              AND (p.ends_on IS NULL OR p.ends_on > ${date}))`,
        ),
      )
      .orderBy(asc(tricycles.codeNumber)),
    db
      .select({
        name: users.name,
        total: count(),
        problems: sql<number>`count(*) filter (where not ${inspections.washed} or not ${inspections.stickerIntact})::int`,
      })
      .from(inspections)
      .innerJoin(users, eq(users.id, inspections.inspectedBy))
      .where(eq(inspections.businessDate, date))
      .groupBy(users.name)
      .orderBy(desc(count())),
  ]);
  const unique = [...new Map(rows.map((row) => [row.tricycleId, row])).values()];
  return {
    date,
    expected: unique.length,
    inspected: unique.filter((row) => row.inspectionId).length,
    missed: unique.filter((row) => !row.inspectionId),
    bySupervisor,
  };
}

/** Staff can open evidence. An operator can open only a decided case of their own. */
export async function getPhoto(ctx: Ctx, id: string) {
  if (!can(ctx.actor.role, "violation.view")) {
    requirePermission(ctx, "portal.viewOwn");
    if (!ctx.actor.operatorId) return null;
    const [own] = await db
      .select({ id: violations.id })
      .from(violations)
      .where(
        and(
          eq(violations.photoId, id),
          eq(violations.operatorId, ctx.actor.operatorId),
          or(eq(violations.status, "confirmed"), eq(violations.status, "waived")),
        ),
      )
      .limit(1);
    if (!own) return null;
  }
  const [photo] = await db.select({ data: photos.data }).from(photos).where(eq(photos.id, id)).limit(1);
  return photo?.data ?? null;
}
