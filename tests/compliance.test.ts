import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { assignments, charges, inspections, operators, violations } from "@/db/schema";
import { DomainError, ForbiddenError } from "@/lib/errors";
import { issueTricycle, returnTricycle } from "@/services/assignments";
import type { Ctx } from "@/services/context";
import { getPhoto, inspectionCoverage, inspectionToday, recordInspection } from "@/services/inspections";
import {
  cancelMeeting,
  closeMeeting,
  getMeeting,
  markRemainingAbsent,
  recordAttendance,
  scheduleMeeting,
} from "@/services/meetings";
import { changeRuleAmount, listRules } from "@/services/rules";
import {
  confirmViolation,
  getMyCompliance,
  raiseLateWork,
  rejectViolation,
  waiveViolation,
} from "@/services/violations";
import { reportFault } from "@/services/workshop";
import { makeOperator, makeTricycle, makeUser, noticesFor, TODAY } from "./helpers";

const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

let manager: Ctx;
let assistant: Ctx;
let supervisor: Ctx;
let owner: Ctx;

beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  assistant = (await makeUser("assistant_manager")).ctx;
  supervisor = (await makeUser("supervisor")).ctx;
  owner = (await makeUser("owner")).ctx;
});

const wat = (date: string, time = "09:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time = "09:00"): Ctx => ({ ...ctx, clock: () => wat(date, time) });

async function held() {
  const tricycle = await makeTricycle(manager);
  const operator = await makeOperator(manager);
  await issueTricycle(manager, {
    tricycleId: tricycle.id,
    operatorId: operator.id,
    issuedOn: "2026-11-01",
  });
  return { tricycle, operator };
}

const inspect = (
  ctx: Ctx,
  tricycleId: string,
  date: string,
  result: { washed?: boolean; stickerIntact?: boolean; clientId?: string; photo?: string | null; syncedOn?: string },
) => {
  const washed = result.washed ?? true;
  const stickerIntact = result.stickerIntact ?? true;
  return recordInspection(on(ctx, result.syncedOn ?? date, "12:00"), {
    clientId: result.clientId ?? randomUUID(),
    tricycleId,
    washed,
    stickerIntact,
    photo: result.photo === null ? undefined : !washed || !stickerIntact ? PHOTO : undefined,
    inspectedAt: wat(date).toISOString(),
  });
};

const offences = (operatorId: string, ruleCode: string) =>
  db
    .select()
    .from(violations)
    .where(and(eq(violations.operatorId, operatorId), eq(violations.ruleCode, ruleCode)));

const offRoad = (id: string) => reportFault(on(manager, "2026-11-01"), { tricycleId: id, fault: "Engine trouble" });

describe("R2 not washed and polished", () => {
  it("proposes ₦3,000, and only someone else's confirmation adds the fine", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, TODAY, { washed: false });
    const [v] = await offences(operator.id, "R2");
    expect(v).toMatchObject({ status: "proposed", amountKobo: 300_000, occurredOn: TODAY, chargeId: null });
    expect(v!.photoId).not.toBeNull();

    await confirmViolation(assistant, v!.id);
    const [charge] = await db.select().from(charges).where(eq(charges.operatorId, operator.id));
    expect(charge).toMatchObject({ type: "penalty", amountKobo: 300_000, businessDate: TODAY });
  });

  it("does not let the person who raised it confirm it", async () => {
    const { tricycle, operator } = await held();
    await inspect(assistant, tricycle.id, TODAY, { washed: false });
    const [v] = await offences(operator.id, "R2");
    await expect(confirmViolation(assistant, v!.id)).rejects.toThrow(/someone else/i);
  });

  it("records nothing against a clean tricycle", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, TODAY, {});
    expect(await offences(operator.id, "R2")).toHaveLength(0);
  });

  it("treats the same offline submission sent twice as one", async () => {
    const { tricycle, operator } = await held();
    const clientId = randomUUID();
    expect(await inspect(supervisor, tricycle.id, TODAY, { washed: false, clientId })).toEqual({ outcome: "saved" });
    expect(await inspect(supervisor, tricycle.id, TODAY, { washed: false, clientId })).toEqual({ outcome: "already_saved" });
    expect(await offences(operator.id, "R2")).toHaveLength(1);
  });

  it("survives both copies arriving at the same moment", async () => {
    const { tricycle, operator } = await held();
    const clientId = randomUUID();
    const results = await Promise.all([
      inspect(supervisor, tricycle.id, TODAY, { washed: false, clientId }),
      inspect(supervisor, tricycle.id, TODAY, { washed: false, clientId }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_saved", "saved"]);
    expect(await offences(operator.id, "R2")).toHaveLength(1);
  });

  it("allows one per tricycle per day when two supervisors inspect", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, TODAY, { washed: false });
    expect(await inspect(assistant, tricycle.id, TODAY, { washed: false })).toEqual({ outcome: "already_inspected" });
    expect(await offences(operator.id, "R2")).toHaveLength(1);
  });

  it("gives a new offence on a new day", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-09", { washed: false });
    await inspect(supervisor, tricycle.id, "2026-11-10", { washed: false });
    expect(await offences(operator.id, "R2")).toHaveLength(2);
  });

  it("dates an offline inspection when it happened, not when it synced", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-09", { washed: false, syncedOn: "2026-11-10" });
    const [v] = await offences(operator.id, "R2");
    expect(v!.occurredOn).toBe("2026-11-09");
  });

  it("does not inspect or fine an off-road tricycle", async () => {
    const { tricycle, operator } = await held();
    await offRoad(tricycle.id);
    await expect(inspect(supervisor, tricycle.id, TODAY, { washed: false })).rejects.toThrow(/off the road/);
    expect(await offences(operator.id, "R2")).toHaveLength(0);
  });

  it("refuses a tricycle nobody held", async () => {
    const tricycle = await makeTricycle(manager);
    await expect(inspect(supervisor, tricycle.id, TODAY, {})).rejects.toThrow(/No operator/);
  });

  it("needs a photo only when something fails", async () => {
    const { tricycle } = await held();
    await expect(inspect(supervisor, tricycle.id, TODAY, { washed: false, photo: null })).rejects.toBeInstanceOf(DomainError);
    expect(await inspect(supervisor, tricycle.id, TODAY, {})).toEqual({ outcome: "saved" });
  });

  it("refuses files that are not JPEG photos", async () => {
    const { tricycle } = await held();
    const notAPhoto = `data:image/jpeg;base64,${Buffer.from("<script>").toString("base64")}`;
    await expect(
      recordInspection(on(supervisor, TODAY), {
        clientId: randomUUID(),
        tricycleId: tricycle.id,
        washed: false,
        stickerIntact: true,
        photo: notAPhoto,
        inspectedAt: wat(TODAY).toISOString(),
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses inspections from the future or too long ago", async () => {
    const { tricycle } = await held();
    await expect(inspect(supervisor, tricycle.id, "2026-11-11", { syncedOn: "2026-11-10" })).rejects.toThrow(/clock/);
    await expect(inspect(supervisor, tricycle.id, "2026-11-05", { syncedOn: "2026-11-10" })).rejects.toThrow(/3 days/);
  });

  it("can never be edited or deleted afterwards", async () => {
    const { tricycle } = await held();
    await inspect(supervisor, tricycle.id, TODAY, {});
    await expect(db.update(inspections).set({ washed: false }).where(eq(inspections.tricycleId, tricycle.id))).rejects.toThrow();
    await expect(db.delete(inspections).where(eq(inspections.tricycleId, tricycle.id))).rejects.toThrow();
  });

  it("is limited to field staff", async () => {
    const { tricycle } = await held();
    await expect(inspect(owner, tricycle.id, TODAY, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("R4 company sticker removed", () => {
  it("fines once while it stays missing", async () => {
    const { tricycle, operator } = await held();
    for (const date of ["2026-11-08", "2026-11-09", "2026-11-10"]) {
      await inspect(supervisor, tricycle.id, date, { stickerIntact: false });
    }
    const rows = await offences(operator.id, "R4");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountKobo: 300_000, occurredOn: "2026-11-08" });
  });

  it("fines again only after it was replaced and removed again", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-08", { stickerIntact: false });
    await inspect(supervisor, tricycle.id, "2026-11-09", {});
    await inspect(supervisor, tricycle.id, "2026-11-10", { stickerIntact: false });
    expect(await offences(operator.id, "R4")).toHaveLength(2);
  });

  it("does not fine a late report that falls inside a known removal", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-08", { stickerIntact: false });
    await inspect(supervisor, tricycle.id, "2026-11-10", {});
    await inspect(supervisor, tricycle.id, "2026-11-09", { stickerIntact: false, syncedOn: "2026-11-10" });
    expect(await offences(operator.id, "R4")).toHaveLength(1);
  });

  it("joins a late report to the removal it belongs to", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-10", { stickerIntact: false });
    await inspect(supervisor, tricycle.id, "2026-11-09", { stickerIntact: false, syncedOn: "2026-11-10" });
    expect(await offences(operator.id, "R4")).toHaveLength(1);
  });

  it("does not let an older good report end a newer removal", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-09", { stickerIntact: false });
    await inspect(supervisor, tricycle.id, "2026-11-08", { syncedOn: "2026-11-09" });
    await inspect(supervisor, tricycle.id, "2026-11-10", { stickerIntact: false });
    expect(await offences(operator.id, "R4")).toHaveLength(1);
  });

  it("treats the next failure as new after a wrong report is rejected", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-09", { stickerIntact: false });
    const [v] = await offences(operator.id, "R4");
    await rejectViolation(assistant, v!.id, { reason: "Sticker was there" });
    await inspect(supervisor, tricycle.id, "2026-11-10", { stickerIntact: false });
    expect(await offences(operator.id, "R4")).toHaveLength(2);
  });

  it("stays one incident after the fine is waived", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-09", { stickerIntact: false });
    const [v] = await offences(operator.id, "R4");
    await confirmViolation(assistant, v!.id);
    await waiveViolation(manager, v!.id, { reason: "First time" });
    await inspect(supervisor, tricycle.id, "2026-11-10", { stickerIntact: false });
    expect(await offences(operator.id, "R4")).toHaveLength(1);
  });

  it("does not raise R2 for a sticker failure, or R4 for a dirty tricycle", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-09", { stickerIntact: false });
    await inspect(supervisor, tricycle.id, "2026-11-10", { washed: false });
    expect(await offences(operator.id, "R2")).toHaveLength(1);
    expect(await offences(operator.id, "R4")).toHaveLength(1);
  });

  it("does not fine an off-road tricycle", async () => {
    const { tricycle, operator } = await held();
    await offRoad(tricycle.id);
    await expect(inspect(supervisor, tricycle.id, TODAY, { stickerIntact: false })).rejects.toThrow(/off the road/);
    expect(await offences(operator.id, "R4")).toHaveLength(0);
  });
});

describe("meetings, R5 and R6", () => {
  const meetingToday = () =>
    scheduleMeeting(on(manager, TODAY), { title: "General meeting", scheduledFor: `${TODAY}T16:00` });
  const during = () => on(supervisor, TODAY, "16:30");
  const mark = (ctx: Ctx, meetingId: string, operatorId: string, status: string, reason?: string) =>
    recordAttendance(ctx, meetingId, { operatorId, status, reason });
  const finish = async (id: string, by = during()) => {
    await markRemainingAbsent(by, id);
    return closeMeeting(by, id);
  };

  it("fines ₦3,000 for attending without the tricycle (R5)", async () => {
    const { operator } = await held();
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "present_without_tricycle");
    await finish(meeting.id);
    expect(await offences(operator.id, "R5")).toMatchObject([{ amountKobo: 300_000, status: "proposed", occurredOn: TODAY }]);
    expect(await offences(operator.id, "R6")).toHaveLength(0);
  });

  it("fines ₦6,000 as one offence for absence (R6)", async () => {
    const { operator } = await held();
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "absent");
    await finish(meeting.id);
    expect(await offences(operator.id, "R6")).toMatchObject([{ amountKobo: 600_000 }]);
    expect(await offences(operator.id, "R5")).toHaveLength(0);
  });

  it("does not fine someone who came with the tricycle", async () => {
    const { operator } = await held();
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "present_with_tricycle");
    await finish(meeting.id);
    expect(await offences(operator.id, "R5")).toHaveLength(0);
    expect(await offences(operator.id, "R6")).toHaveLength(0);
  });

  it("exempts R5 when the tricycle is off-road", async () => {
    const { tricycle, operator } = await held();
    await offRoad(tricycle.id);
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "present_without_tricycle");
    await finish(meeting.id);
    expect(await offences(operator.id, "R5")).toHaveLength(0);
  });

  it("still applies R6 when the tricycle is off-road", async () => {
    const { tricycle, operator } = await held();
    await offRoad(tricycle.id);
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "absent");
    await finish(meeting.id);
    expect(await offences(operator.id, "R6")).toHaveLength(1);
  });

  it("lets only the Manager excuse, with a reason, and carries no fine", async () => {
    const { operator } = await held();
    const meeting = await meetingToday();
    await expect(mark(during(), meeting.id, operator.id, "excused", "Sick")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(mark(on(manager, TODAY), meeting.id, operator.id, "excused")).rejects.toBeInstanceOf(DomainError);
    await mark(on(manager, TODAY), meeting.id, operator.id, "excused", "Sick");
    await expect(mark(during(), meeting.id, operator.id, "absent")).rejects.toBeInstanceOf(ForbiddenError);
    await finish(meeting.id);
    expect(await offences(operator.id, "R6")).toHaveLength(0);
  });

  it("uses the final mark, so R5 and R6 can never both apply", async () => {
    const { operator } = await held();
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "absent");
    await mark(during(), meeting.id, operator.id, "present_without_tricycle");
    await finish(meeting.id);
    expect(await offences(operator.id, "R5")).toHaveLength(1);
    expect(await offences(operator.id, "R6")).toHaveLength(0);
  });

  it("cannot be closed twice", async () => {
    const { operator } = await held();
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "absent");
    await finish(meeting.id);
    await expect(closeMeeting(during(), meeting.id)).rejects.toThrow(/finished/);
    expect(await offences(operator.id, "R6")).toHaveLength(1);
  });

  it("gives one offence per meeting even when two close at once", async () => {
    const { operator } = await held();
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "absent");
    await markRemainingAbsent(during(), meeting.id);
    const results = await Promise.allSettled([closeMeeting(during(), meeting.id), closeMeeting(during(), meeting.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await offences(operator.id, "R6")).toHaveLength(1);
  });

  it("does not close while anyone is unmarked", async () => {
    await held();
    const meeting = await meetingToday();
    await expect(closeMeeting(during(), meeting.id)).rejects.toThrow(/no attendance/);
    await markRemainingAbsent(during(), meeting.id);
    await expect(closeMeeting(during(), meeting.id)).resolves.toBeDefined();
  });

  it("marking the rest absent never overwrites a mark", async () => {
    const { operator } = await held();
    const meeting = await meetingToday();
    await mark(during(), meeting.id, operator.id, "present_with_tricycle");
    await markRemainingAbsent(during(), meeting.id);
    const detail = await getMeeting(during(), meeting.id);
    expect(detail!.roster.find((p) => p.operatorId === operator.id)!.status).toBe("present_with_tricycle");
  });

  it("does not take attendance before the day, or for operators not expected", async () => {
    const { operator } = await held();
    const later = await scheduleMeeting(on(manager, TODAY), { title: "Later", scheduledFor: "2026-11-12T10:00" });
    await expect(mark(during(), later.id, operator.id, "absent")).rejects.toThrow(/day of the meeting/);
    const meeting = await meetingToday();
    const noTricycle = await makeOperator(manager);
    await expect(mark(during(), meeting.id, noTricycle.id, "absent")).rejects.toThrow(/not expected/);
  });

  it("lets only the Manager schedule or cancel, and queues a notice", async () => {
    const { operator } = await held();
    await expect(
      scheduleMeeting(on(assistant, TODAY), { title: "X", scheduledFor: `${TODAY}T16:00` }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      scheduleMeeting(on(manager, TODAY), { title: "X", scheduledFor: `${TODAY}T08:00` }),
    ).rejects.toBeInstanceOf(DomainError);
    const meeting = await meetingToday();
    const sent = await noticesFor(operator.id, "meeting_notice");
    expect(sent.length).toBeGreaterThan(0);
    await expect(cancelMeeting(on(assistant, TODAY), meeting.id, { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await cancelMeeting(on(manager, TODAY), meeting.id, { reason: "Rain" });
    await expect(closeMeeting(during(), meeting.id)).rejects.toThrow(/finished/);
  });
});

describe("R7 working after 10:00 pm", () => {
  const late = (ctx: Ctx, tricycleId: string, trackerAt: string, photo: string | undefined = PHOTO) =>
    raiseLateWork(on(ctx, "2026-11-10", "09:00"), { tricycleId, trackerAt, photo });

  it("proposes ₦3,000 dated to the evening, with the screenshot", async () => {
    const { tricycle, operator } = await held();
    await late(supervisor, tricycle.id, "2026-11-08T22:30");
    expect(await offences(operator.id, "R7")).toMatchObject([
      { amountKobo: 300_000, occurredOn: "2026-11-08", status: "proposed" },
    ]);
  });

  it("treats 10:30 pm and 1:00 am as one night", async () => {
    const { tricycle, operator } = await held();
    await late(supervisor, tricycle.id, "2026-11-08T22:30");
    await expect(late(assistant, tricycle.id, "2026-11-09T01:00")).rejects.toThrow(/already/);
    expect(await offences(operator.id, "R7")).toHaveLength(1);
  });

  it("gives a new offence on the next night", async () => {
    const { tricycle, operator } = await held();
    await late(supervisor, tricycle.id, "2026-11-08T22:30");
    await late(supervisor, tricycle.id, "2026-11-09T23:00");
    expect(await offences(operator.id, "R7")).toHaveLength(2);
  });

  it("applies only between 10:00 pm and 5:00 am", async () => {
    const { tricycle, operator } = await held();
    for (const time of ["21:59", "22:00", "05:00", "12:00"]) {
      await expect(late(supervisor, tricycle.id, `2026-11-08T${time}`)).rejects.toBeInstanceOf(DomainError);
    }
    await late(supervisor, tricycle.id, "2026-11-08T22:01");
    await late(supervisor, tricycle.id, "2026-11-08T04:59");
    expect((await offences(operator.id, "R7")).map((v) => v.occurredOn).sort()).toEqual(["2026-11-07", "2026-11-08"]);
  });

  it("requires a screenshot and a past time", async () => {
    const { tricycle } = await held();
    await expect(
      raiseLateWork(on(supervisor, "2026-11-10"), { tricycleId: tricycle.id, trackerAt: "2026-11-08T22:30" }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(late(supervisor, tricycle.id, "2026-11-10T22:30")).rejects.toThrow();
  });

  it("exempts off-road tricycles and tricycles nobody held", async () => {
    const { tricycle } = await held();
    await offRoad(tricycle.id);
    await expect(late(supervisor, tricycle.id, "2026-11-08T22:30")).rejects.toBeInstanceOf(DomainError);
    const spare = await makeTricycle(manager);
    await expect(late(supervisor, spare.id, "2026-11-08T22:30")).rejects.toBeInstanceOf(DomainError);
  });

  it("charges whoever held the tricycle that night", async () => {
    const { tricycle, operator } = await held();
    const [assignment] = await db.select().from(assignments).where(eq(assignments.tricycleId, tricycle.id));
    await returnTricycle(on(manager, "2026-11-09"), assignment!.id, { returnedOn: "2026-11-09", reason: "reassigned" });
    const next = await makeOperator(manager);
    await issueTricycle(on(manager, "2026-11-10"), {
      tricycleId: tricycle.id,
      operatorId: next.id,
      issuedOn: "2026-11-10",
    });
    await late(supervisor, tricycle.id, "2026-11-08T22:30");
    expect(await offences(operator.id, "R7")).toHaveLength(1);
    expect(await offences(next.id, "R7")).toHaveLength(0);
  });

  it("is limited to field staff", async () => {
    const { tricycle } = await held();
    await expect(late(owner, tricycle.id, "2026-11-08T23:00")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("rule catalogue", () => {
  it("applies a new fine from its date and leaves earlier offences alone", async () => {
    const code = "R2";
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, "2026-11-20", { washed: false, syncedOn: "2026-11-20" });
    await changeRuleAmount(on(manager, "2026-11-20"), { code, amount: "4,000", effectiveFrom: "2026-11-21" });
    await inspect(supervisor, tricycle.id, "2026-11-21", { washed: false, syncedOn: "2026-11-21" });
    expect((await offences(operator.id, "R2")).map((v) => v.amountKobo).sort()).toEqual([300_000, 400_000]);

    const [row] = (await listRules(on(manager, "2026-11-20"))).filter((r) => r.code === code);
    expect(row!.amountKobo).toBe(300_000);
    expect(row!.upcoming[0]!.amountKobo).toBe(400_000);
  });

  it("refuses past dates, and anyone but the Manager", async () => {
    await expect(changeRuleAmount(on(manager, TODAY), { code: "R4", amount: "4,000", effectiveFrom: "2026-11-01" })).rejects.toBeInstanceOf(DomainError);
    await expect(changeRuleAmount(on(assistant, TODAY), { code: "R4", amount: "4,000", effectiveFrom: TODAY })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("portal and evidence", () => {
  const portal = (operatorId: string): Ctx => ({
    actor: { userId: randomUUID(), name: "Op", role: "operator", operatorId },
    clock: () => wat(TODAY),
  });

  it("shows an operator only their decided offences", async () => {
    const { tricycle, operator } = await held();
    await inspect(supervisor, tricycle.id, TODAY, { washed: false });
    expect((await getMyCompliance(portal(operator.id))).offences).toHaveLength(0);
    const [v] = await offences(operator.id, "R2");
    await confirmViolation(assistant, v!.id);
    expect((await getMyCompliance(portal(operator.id))).offences).toMatchObject([{ ruleCode: "R2", status: "confirmed" }]);
  });

  it("keeps photos private to staff and the operator concerned", async () => {
    const { tricycle, operator } = await held();
    const other = await held();
    await inspect(supervisor, tricycle.id, TODAY, { washed: false });
    const [v] = await offences(operator.id, "R2");
    expect(await getPhoto(portal(operator.id), v!.photoId!)).toBeNull();
    await confirmViolation(assistant, v!.id);
    expect(await getPhoto(portal(operator.id), v!.photoId!)).not.toBeNull();
    expect(await getPhoto(portal(other.operator.id), v!.photoId!)).toBeNull();
    expect(await getPhoto(on(supervisor, TODAY), v!.photoId!)).not.toBeNull();
  });
});

describe("today list and coverage", () => {
  it("lists issued tricycles and leaves out off-road ones", async () => {
    const a = await held();
    const b = await held();
    await offRoad(b.tricycle.id);
    await inspect(supervisor, a.tricycle.id, TODAY, {});
    const { items } = await inspectionToday(on(supervisor, TODAY));
    expect(items.find((i) => i.tricycleId === a.tricycle.id)!.washed).toBe(true);
    expect(items.some((i) => i.tricycleId === b.tricycle.id)).toBe(false);
  });

  it("counts coverage by supervisor, and hides the report from supervisors", async () => {
    const a = await held();
    const b = await held();
    const date = "2026-11-02";
    await recordInspection(on(supervisor, date, "12:00"), {
      clientId: randomUUID(),
      tricycleId: a.tricycle.id,
      washed: true,
      stickerIntact: true,
      inspectedAt: wat(date).toISOString(),
    });
    const report = await inspectionCoverage(on(manager, TODAY), { date });
    expect(report.missed.some((m) => m.tricycleId === b.tricycle.id)).toBe(true);
    expect(report.missed.some((m) => m.tricycleId === a.tricycle.id)).toBe(false);
    expect(report.bySupervisor.some((s) => s.name === supervisor.actor.name && s.total >= 1)).toBe(true);
    await expect(inspectionCoverage(on(supervisor, TODAY), { date })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
