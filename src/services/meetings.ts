import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import {
  assignments,
  attendanceStatus,
  meetingAttendance,
  meetings,
  operators,
  smsOutbox,
  tricycles,
} from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput } from "@/lib/errors";
import { idField, optionalText, requiredText } from "@/lib/fields";
import { formatDateTime } from "@/lib/format";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { proposeViolation } from "./violations";

const scheduleSchema = z.object({
  title: requiredText("Title", 120),
  scheduledFor: z
    .string("Enter the date and time")
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Enter the date and time"),
});

/** Active operators holding a tricycle on the date are expected to attend. */
async function rosterOn(exec: Executor, date: string) {
  const rows = await exec
    .select({
      operatorId: operators.id,
      name: operators.name,
      phone: operators.phone,
      tricycleId: tricycles.id,
      code: tricycles.codeNumber,
      tricycleStatus: tricycles.status,
    })
    .from(assignments)
    .innerJoin(operators, eq(operators.id, assignments.operatorId))
    .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
    .where(
      and(
        eq(operators.status, "active"),
        lte(assignments.issuedOn, date),
        or(isNull(assignments.returnedOn), gte(assignments.returnedOn, date)),
      ),
    )
    .orderBy(asc(assignments.issuedOn));
  const latest = new Map(rows.map((row) => [row.operatorId, row]));
  return [...latest.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export async function scheduleMeeting(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "meeting.schedule");
  const input = parseInput(scheduleSchema, raw);
  const at = new Date(`${input.scheduledFor}:00+01:00`);
  if (Number.isNaN(at.getTime())) throw fieldError("scheduledFor", "Enter a real date and time");
  if (at <= ctx.clock()) throw fieldError("scheduledFor", "Choose a time in the future");
  const date = input.scheduledFor.slice(0, 10);

  return db.transaction(async (tx) => {
    const [meeting] = await tx
      .insert(meetings)
      .values({
        title: input.title,
        scheduledFor: at,
        businessDate: date,
        createdBy: ctx.actor.userId,
        createdAt: ctx.clock(),
      })
      .returning({ id: meetings.id });
    const roster = await rosterOn(tx, businessDate(ctx.clock()));
    if (roster.length > 0) {
      await tx.insert(smsOutbox).values(
        roster.map((person) => ({
          toPhone: person.phone,
          kind: "meeting_notice",
          createdAt: ctx.clock(),
          body: `Jayngol: General meeting "${input.title}" on ${formatDateTime(at)}. Attend with your tricycle. Absence is a fine.`,
        })),
      );
    }
    await auditFrom(ctx, tx, {
      action: "meeting.schedule",
      entityType: "meeting",
      entityId: meeting!.id,
      after: { title: input.title, date },
    });
    return meeting!;
  });
}

async function lockMeeting(tx: Tx, id: string) {
  const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, id)).for("update");
  if (!meeting) throw new DomainError("Meeting not found.");
  if (meeting.status !== "scheduled") throw new DomainError("This meeting is already finished.");
  return meeting;
}

function requireMeetingDay(ctx: Ctx, date: string) {
  if (businessDate(ctx.clock()) < date) {
    throw new DomainError("Attendance opens on the day of the meeting.");
  }
}

const reasonSchema = z.object({ reason: requiredText("Reason", 500) });

export async function cancelMeeting(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "meeting.schedule");
  const id = parseInput(idField("meeting"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  await db.transaction(async (tx) => {
    await lockMeeting(tx, id);
    await tx
      .update(meetings)
      .set({ status: "cancelled", closedBy: ctx.actor.userId, closedAt: ctx.clock() })
      .where(eq(meetings.id, id));
    await auditFrom(ctx, tx, { action: "meeting.cancel", entityType: "meeting", entityId: id, reason });
  });
}

const attendanceSchema = z.object({
  operatorId: idField("operator"),
  status: z.enum(attendanceStatus.enumValues, "Choose attendance"),
  reason: optionalText(500),
});

export async function recordAttendance(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "meeting.attendance");
  const meetingId = parseInput(idField("meeting"), rawId);
  const input = parseInput(attendanceSchema, raw);
  if (input.status === "excused") {
    requirePermission(ctx, "meeting.excuse");
    if (!input.reason) throw fieldError("reason", "Reason is required");
  }

  await db.transaction(async (tx) => {
    const meeting = await lockMeeting(tx, meetingId);
    if (input.status !== "excused") requireMeetingDay(ctx, meeting.businessDate);

    const [existing] = await tx
      .select({ status: meetingAttendance.status })
      .from(meetingAttendance)
      .where(
        and(
          eq(meetingAttendance.meetingId, meetingId),
          eq(meetingAttendance.operatorId, input.operatorId),
        ),
      )
      .limit(1);
    if (existing?.status === "excused" && input.status !== "excused") {
      requirePermission(ctx, "meeting.excuse");
    }

    const roster = await rosterOn(tx, meeting.businessDate);
    const person = roster.find((row) => row.operatorId === input.operatorId);
    if (!person) throw new DomainError("This operator is not expected at this meeting.");

    const values = {
      status: input.status,
      reason: input.status === "excused" ? input.reason! : null,
      tricycleId: person.tricycleId,
      tricycleOffRoad: person.tricycleStatus === "off_road",
      recordedBy: ctx.actor.userId,
      recordedAt: ctx.clock(),
    };
    await tx
      .insert(meetingAttendance)
      .values({ meetingId, operatorId: input.operatorId, ...values })
      .onConflictDoUpdate({
        target: [meetingAttendance.meetingId, meetingAttendance.operatorId],
        set: values,
      });
    await auditFrom(ctx, tx, {
      action: input.status === "excused" ? "meeting.excuse" : "meeting.attendance",
      entityType: "meeting",
      entityId: meetingId,
      before: existing ? { status: existing.status } : undefined,
      after: { operatorId: input.operatorId, status: input.status },
      reason: input.status === "excused" ? input.reason : undefined,
    });
  });
}

/** Only ever fills gaps. An explicit mark is never overwritten. */
export async function markRemainingAbsent(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "meeting.attendance");
  const meetingId = parseInput(idField("meeting"), rawId);
  await db.transaction(async (tx) => {
    const meeting = await lockMeeting(tx, meetingId);
    requireMeetingDay(ctx, meeting.businessDate);
    const roster = await rosterOn(tx, meeting.businessDate);
    if (roster.length === 0) return;
    const inserted = await tx
      .insert(meetingAttendance)
      .values(
        roster.map((person) => ({
          meetingId,
          operatorId: person.operatorId,
          status: "absent" as const,
          tricycleId: person.tricycleId,
          tricycleOffRoad: person.tricycleStatus === "off_road",
          recordedBy: ctx.actor.userId,
          recordedAt: ctx.clock(),
        })),
      )
      .onConflictDoNothing()
      .returning({ operatorId: meetingAttendance.operatorId });
    await auditFrom(ctx, tx, {
      action: "meeting.mark_absent",
      entityType: "meeting",
      entityId: meetingId,
      after: { count: inserted.length },
    });
  });
}

/**
 * Closing turns attendance into offences. Each operator has one attendance row
 * per meeting, so R5 and R6 cannot both be raised for the same meeting.
 */
export async function closeMeeting(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "meeting.attendance");
  const meetingId = parseInput(idField("meeting"), rawId);
  return db.transaction(async (tx) => {
    const meeting = await lockMeeting(tx, meetingId);
    requireMeetingDay(ctx, meeting.businessDate);

    const roster = await rosterOn(tx, meeting.businessDate);
    const marked = await tx
      .select()
      .from(meetingAttendance)
      .where(eq(meetingAttendance.meetingId, meetingId));
    const done = new Set(marked.map((row) => row.operatorId));
    const missing = roster.filter((person) => !done.has(person.operatorId)).length;
    if (missing > 0) {
      throw new DomainError(`${missing} operator(s) still have no attendance marked.`);
    }

    let raised = 0;
    for (const row of marked) {
      const ruleCode =
        row.status === "absent"
          ? "R6"
          : row.status === "present_without_tricycle" && !row.tricycleOffRoad
            ? "R5"
            : null;
      if (!ruleCode) continue;
      const violation = await proposeViolation(tx, ctx, {
        ruleCode,
        operatorId: row.operatorId,
        tricycleId: row.tricycleId,
        occurredOn: meeting.businessDate,
        occurrenceKey: `MEETING:${meetingId}:${row.operatorId}`,
        note: meeting.title,
      });
      if (violation) raised++;
    }

    await tx
      .update(meetings)
      .set({ status: "closed", closedBy: ctx.actor.userId, closedAt: ctx.clock() })
      .where(eq(meetings.id, meetingId));
    await auditFrom(ctx, tx, {
      action: "meeting.close",
      entityType: "meeting",
      entityId: meetingId,
      after: { attended: marked.length, offences: raised },
    });
    return { raised };
  });
}

export async function listMeetings(ctx: Ctx) {
  requirePermission(ctx, "meeting.view");
  return db.select().from(meetings).orderBy(desc(meetings.scheduledFor)).limit(100);
}

export async function getMeeting(ctx: Ctx, id: string) {
  requirePermission(ctx, "meeting.view");
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, id)).limit(1);
  if (!meeting) return null;
  const [roster, marked] = await Promise.all([
    rosterOn(db, meeting.businessDate),
    db.select().from(meetingAttendance).where(eq(meetingAttendance.meetingId, id)),
  ]);
  const byOperator = new Map(marked.map((row) => [row.operatorId, row]));
  return {
    meeting,
    canTakeAttendance: businessDate(ctx.clock()) >= meeting.businessDate,
    roster: roster.map((person) => ({
      operatorId: person.operatorId,
      name: person.name,
      code: person.code,
      offRoad: person.tricycleStatus === "off_road",
      status: byOperator.get(person.operatorId)?.status ?? null,
      reason: byOperator.get(person.operatorId)?.reason ?? null,
    })),
  };
}
