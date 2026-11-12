import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assignments, auditLog, awardCandidates, awardMilestones, awards, jobRuns, photos, violations } from "@/db/schema";
import { addDays, addMonths } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import type { AwardType } from "@/lib/award-progress";
import { getAwardRace, getHonourBoard, getMyAwardJourney, getMyRunAtRisk, getOperatorJourney } from "@/services/award-tracker";
import { issueTricycle } from "@/services/assignments";
import {
  approveAward,
  awardBlockers,
  awardFacts,
  listAwards,
  proposeAwards,
  rejectAward,
  type AwardFacts,
} from "@/services/awards";
import type { Ctx } from "@/services/context";
import { processDay } from "@/services/daily-job";
import { getPhoto } from "@/services/inspections";
import { recordPayment, reversePayment } from "@/services/payments";
import { notifyOperators } from "@/services/notices";
import { getMyRecords } from "@/services/portal";
import { reportCsv, REPORTS, runReport, type ReportKey } from "@/services/reports";
import { makeOperator, makeTricycle, makeUser, nextReference, noticesFor } from "./helpers";

const wat = (date: string, time = "12:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: () => wat(date, time) });

let manager: Ctx;
let owner: Ctx;
let supervisor: Ctx;
let managerId: string;

beforeAll(async () => {
  const made = await makeUser("manager");
  manager = made.ctx;
  managerId = made.user.id;
  owner = (await makeUser("owner")).ctx;
  supervisor = (await makeUser("supervisor")).ctx;
});

// 1 Jul to 31 Dec 2028: 184 days.
const RUN = "2029-01-01";
const FROM = "2028-07-01";
const TO = "2028-12-31";
const DAYS = 184;

type Seed = {
  issuedOn?: string;
  /** Days at the start of the period with no inspection. */
  uninspected?: number;
  /** Balances paid a day after their deadline. */
  latePayments?: number;
};

/** A hand-built operator record: every balance and inspection known exactly. */
async function operatorWith({ issuedOn = FROM, uninspected = 0, latePayments = 0 }: Seed = {}) {
  const operator = await makeOperator(manager);
  const tricycle = await makeTricycle(manager);
  const assignment = (await issueTricycle(on(manager, issuedOn), {
    tricycleId: tricycle.id,
    operatorId: operator.id,
    issuedOn,
    dailyBalance: "10000",
  }))!;
  await db.execute(sql`
    INSERT INTO charges (type, operator_id, tricycle_id, assignment_id, amount_kobo, business_date, due_on, created_at)
    SELECT 'daily_balance', ${operator.id}, ${tricycle.id}, ${assignment.id}, 1000000, d::date, d::date + 1, now()
    FROM generate_series(${issuedOn}::date, ${TO}::date, interval '1 day') d
  `);
  await db.execute(sql`
    WITH paid AS (
      INSERT INTO payments (operator_id, amount_kobo, method, received_at, business_date, received_by, receipt_number, client_id, created_at)
      SELECT c.operator_id, c.amount_kobo, 'transfer',
        ((c.due_on + extra.days)::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Lagos',
        c.due_on + extra.days, ${managerId}, 'T-' || c.id, c.id, now()
      FROM charges c
      CROSS JOIN LATERAL (SELECT CASE WHEN c.business_date < ${issuedOn}::date + ${latePayments}::int THEN 1 ELSE 0 END AS days) extra
      WHERE c.operator_id = ${operator.id}
      RETURNING id, client_id, amount_kobo
    )
    INSERT INTO payment_allocations (payment_id, charge_id, amount_kobo)
    SELECT id, client_id, amount_kobo FROM paid
  `);
  await db.execute(sql`
    INSERT INTO inspections (tricycle_id, operator_id, inspected_by, business_date, washed, sticker_intact, client_id, inspected_at, recorded_at)
    SELECT ${tricycle.id}, ${operator.id}, ${managerId}, d::date, true, true, gen_random_uuid(), now(), now()
    FROM generate_series(${issuedOn}::date + ${uninspected}::int, ${TO}::date, interval '1 day') d
  `);
  return { operator, tricycle, assignmentId: assignment.id };
}

async function offence(operatorId: string, tricycleId: string, ruleCode: string, status: string, occurredOn: string) {
  await db.insert(violations).values({
    ruleCode,
    operatorId,
    tricycleId,
    occurredOn,
    amountKobo: 500000,
    status: status as "confirmed",
    occurrenceKey: `TEST:${randomUUID()}`,
    createdAt: new Date(),
  });
}

const qualifies = (facts: AwardFacts) => ({
  consistency: awardBlockers("consistency", facts).length === 0,
  clean_vehicle: awardBlockers("clean_vehicle", facts).length === 0,
  law_abiding: awardBlockers("law_abiding", facts).length === 0,
});
const judged = async (operatorId: string) => qualifies(await awardFacts(db, operatorId, RUN));
const ALL = { consistency: true, clean_vehicle: true, law_abiding: true };
const NONE = { consistency: false, clean_vehicle: false, law_abiding: false };
const propose = (run = RUN) => db.transaction((tx) => proposeAwards(tx, run, wat(run, "01:00")));
const candidatesOf = (operatorId: string) =>
  db.select().from(awardCandidates).where(eq(awardCandidates.operatorId, operatorId));

describe("addMonths", () => {
  it("clamps to the end of a shorter month", () => {
    expect(addMonths("2029-08-31", -6)).toBe("2029-02-28");
    expect(addMonths("2029-01-01", -6)).toBe("2028-07-01");
    expect(addMonths("2028-11-30", 3)).toBe("2029-02-28");
  });
});

describe("hand-checked operators", () => {
  it("gives a spotless operator with exactly 6 months all three", async () => {
    const { operator } = await operatorWith();
    const facts = await awardFacts(db, operator.id, RUN);
    expect(facts).toMatchObject({ workingDays: DAYS, inspectedDays: DAYS, lateBalances: 0, firstIssuedOn: FROM });
    expect(qualifies(facts)).toEqual(ALL);
  });

  it("refuses one day short of 6 months", async () => {
    const { operator } = await operatorWith({ issuedOn: addDays(FROM, 1) });
    expect(await judged(operator.id)).toEqual(NONE);
  });

  it("accepts exactly 80% inspection coverage and refuses just below", async () => {
    // 148 of 184 is 80.4%, the lowest whole count at or above 80%.
    const above = await operatorWith({ uninspected: 36 });
    expect(await awardFacts(db, above.operator.id, RUN)).toMatchObject({ inspectedDays: 148, coveragePercent: 80 });
    expect(await judged(above.operator.id)).toEqual(ALL);
    // 147 of 184 is 79.9%.
    const below = await operatorWith({ uninspected: 37 });
    expect(await judged(below.operator.id)).toEqual(NONE);
  });

  it("ignores a waived or rejected offence", async () => {
    const { operator, tricycle } = await operatorWith();
    await offence(operator.id, tricycle.id, "R2", "waived", "2028-09-01");
    await offence(operator.id, tricycle.id, "R3", "rejected", "2028-09-02");
    expect(await judged(operator.id)).toEqual(ALL);
  });

  it("counts an old washing offence against clean vehicle and law-abiding only", async () => {
    const { operator, tricycle } = await operatorWith();
    await offence(operator.id, tricycle.id, "R2", "confirmed", "2027-03-01");
    expect(await judged(operator.id)).toEqual({ consistency: true, clean_vehicle: false, law_abiding: false });
  });

  it("counts a recent non-washing offence against consistency and law-abiding only", async () => {
    const { operator, tricycle } = await operatorWith();
    await offence(operator.id, tricycle.id, "R3", "confirmed", "2028-10-05");
    expect(await judged(operator.id)).toEqual({ consistency: false, clean_vehicle: true, law_abiding: false });
  });

  it("counts a late balance against consistency only", async () => {
    const { operator } = await operatorWith({ latePayments: 1 });
    expect(await awardFacts(db, operator.id, RUN)).toMatchObject({ lateBalances: 1 });
    expect(await judged(operator.id)).toEqual({ consistency: false, clean_vehicle: true, law_abiding: true });
  });

  it("counts money that was later reversed as never paid", async () => {
    const { operator } = await operatorWith();
    const [payment] = (await db.execute(sql`
      SELECT id FROM payments WHERE operator_id = ${operator.id} ORDER BY business_date LIMIT 1
    `)) as unknown as { id: string }[];
    await reversePayment(on(manager, "2028-08-01"), payment!.id, { reason: "Bounced transfer" });
    expect(await awardFacts(db, operator.id, RUN)).toMatchObject({ lateBalances: 1 });
  });
});

describe("proposing and deciding", () => {
  it("runs once per operator and period", async () => {
    const { operator } = await operatorWith();
    await propose();
    await propose();
    const rows = await candidatesOf(operator.id);
    expect(rows.map((row) => row.type).sort()).toEqual(["clean_vehicle", "consistency", "law_abiding"]);
    expect(rows[0]).toMatchObject({ periodFrom: FROM, periodTo: TO, status: "proposed" });
    expect(rows[0]!.evidence).toMatchObject({ workingDays: DAYS, inspectedDays: DAYS });
  });

  it("proposes through the nightly job only on the 1st", async () => {
    const { operator } = await operatorWith();
    await processDay("2028-12-15", () => wat("2029-06-01"));
    expect(await candidatesOf(operator.id)).toHaveLength(0);
    await db.delete(jobRuns).where(eq(jobRuns.businessDate, RUN));
    await processDay(RUN, () => wat("2029-06-01"));
    expect(await candidatesOf(operator.id)).toHaveLength(3);
  });

  it("records the award, tells the operator and audits it", async () => {
    const { operator } = await operatorWith();
    await propose();
    const candidate = (await candidatesOf(operator.id)).find((row) => row.type === "consistency")!;
    await approveAward(on(manager, "2029-01-03"), candidate.id, { given: "Smartphone" });

    const [award] = await db.select().from(awards).where(eq(awards.candidateId, candidate.id));
    expect(award).toMatchObject({ given: "Smartphone", givenOn: "2029-01-03" });
    expect((await candidatesOf(operator.id)).find((row) => row.id === candidate.id)!.status).toBe("approved");
    const sms = await noticesFor(operator.id, "award");
    expect(sms).toHaveLength(1);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.action, "award.approve"), eq(auditLog.entityId, operator.id)));
    expect(audit).toHaveLength(1);
    await expect(db.update(awards).set({ given: "x" }).where(eq(awards.id, award!.id))).rejects.toThrow();
    await expect(approveAward(manager, candidate.id, { given: "Again" })).rejects.toThrow(/already been decided/);
  });

  it("does not propose the same period again after a decision", async () => {
    const { operator } = await operatorWith();
    await propose();
    const candidate = (await candidatesOf(operator.id)).find((row) => row.type === "law_abiding")!;
    await rejectAward(manager, candidate.id, { reason: "Spoke to him about conduct" });
    await propose("2029-02-01");
    const rows = (await candidatesOf(operator.id)).filter((row) => row.type === "law_abiding");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "rejected", rejectReason: "Spoke to him about conduct" });
  });

  it("blocks approval while an offence is undecided", async () => {
    const { operator, tricycle } = await operatorWith();
    await propose();
    await offence(operator.id, tricycle.id, "R3", "proposed", "2028-12-20");
    const candidate = (await candidatesOf(operator.id)).find((row) => row.type === "law_abiding")!;
    await expect(approveAward(manager, candidate.id, { given: "Cash" })).rejects.toThrow(/must be decided first/);
  });

  it("blocks approval if an offence was confirmed after the proposal", async () => {
    const { operator, tricycle } = await operatorWith();
    await propose();
    await offence(operator.id, tricycle.id, "R3", "confirmed", "2028-12-20");
    const candidate = (await candidatesOf(operator.id)).find((row) => row.type === "law_abiding")!;
    await expect(approveAward(manager, candidate.id, { given: "Cash" })).rejects.toThrow(/no longer qualifies/);
  });

  it("shows who waived offences in the period being decided", async () => {
    const { operator, tricycle } = await operatorWith();
    await propose();
    await db.insert(violations).values({
      ruleCode: "R3",
      operatorId: operator.id,
      tricycleId: tricycle.id,
      occurredOn: "2028-10-05",
      amountKobo: 500000,
      status: "waived",
      decidedBy: managerId,
      decidedAt: new Date(),
      occurrenceKey: `TEST:${randomUUID()}`,
      createdAt: new Date(),
    });
    const row = (await listAwards(manager)).waiting.find((item) => item.candidate.operatorId === operator.id)!;
    expect(row.waived.total).toBe(1);
    expect(row.waived.names).toBeTruthy();
  });

  it("requires what was given and a rejection reason", async () => {
    const { operator } = await operatorWith();
    await propose();
    const [candidate] = await candidatesOf(operator.id);
    await expect(approveAward(manager, candidate!.id, { given: "" })).rejects.toMatchObject({ fieldErrors: { given: expect.anything() } });
    await expect(rejectAward(manager, candidate!.id, { reason: "" })).rejects.toMatchObject({ fieldErrors: { reason: expect.anything() } });
  });

  it("lets only the Manager decide and the owner watch", async () => {
    const { operator } = await operatorWith();
    await propose();
    const [candidate] = await candidatesOf(operator.id);
    await expect(approveAward(owner, candidate!.id, { given: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(rejectAward(supervisor, candidate!.id, { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAwards(supervisor)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listAwards(owner)).canApprove).toBe(false);
  });
});

describe("operator portal", () => {
  const portalFor = (operatorId: string, date = "2029-01-02"): Ctx => ({
    actor: { userId: managerId, name: "Operator", role: "operator", operatorId },
    clock: () => wat(date),
  });

  it("shows only the logged-in operator's own records", async () => {
    const mine = await operatorWith();
    const other = await operatorWith({ latePayments: 2 });
    await propose();
    const candidate = (await candidatesOf(mine.operator.id)).find((row) => row.type === "consistency")!;
    await approveAward(on(manager, "2029-01-02"), candidate.id, { given: "Smartphone" });

    const records = await getMyRecords(portalFor(mine.operator.id));
    expect(records.current?.assignmentId).toBe(mine.assignmentId);
    expect(records.statement.awards).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(other.assignmentId);
  });

  it("refuses staff, and logins with no operator", async () => {
    await expect(getMyRecords(manager)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMyRecords({ ...manager, actor: { ...manager.actor, role: "operator" } })).rejects.toThrow(/not linked/);
  });

  it("will not open another operator's evidence photo", async () => {
    const mine = await operatorWith();
    const other = await operatorWith();
    const [photo] = await db
      .insert(photos)
      .values({ data: Buffer.from([0xff, 0xd8, 0xff]), uploadedBy: managerId, createdAt: new Date() })
      .returning({ id: photos.id });
    await db.insert(violations).values({
      ruleCode: "R2",
      operatorId: other.operator.id,
      tricycleId: other.tricycle.id,
      occurredOn: "2028-11-01",
      amountKobo: 500000,
      status: "confirmed",
      occurrenceKey: `TEST:${randomUUID()}`,
      photoId: photo!.id,
      createdAt: new Date(),
    });
    expect(await getPhoto(portalFor(mine.operator.id), photo!.id)).toBeNull();
    expect(await getPhoto(portalFor(other.operator.id), photo!.id)).not.toBeNull();
  });
});

describe("award tracker", () => {
  const TODAY = "2028-11-15";
  const portal = (operatorId: string, date = TODAY): Ctx => ({
    actor: { userId: managerId, name: "Operator", role: "operator", operatorId },
    clock: () => wat(date),
  });
  const trackOf = async (operatorId: string, type: AwardType = "consistency", date = TODAY) =>
    (await getMyAwardJourney(portal(operatorId, date))).awards.find((row) => row.type === type)!;

  /** The real award engine must pass the projected date and fail the one before. */
  async function expectAgreement(operatorId: string, type: AwardType, expected: string, date = TODAY) {
    const { nextAwardOn } = await trackOf(operatorId, type, date);
    expect(nextAwardOn).toBe(expected);
    expect(awardBlockers(type, await awardFacts(db, operatorId, expected))).toEqual([]);
    expect(awardBlockers(type, await awardFacts(db, operatorId, addMonths(expected, -1))).length).toBeGreaterThan(0);
  }

  it("agrees with the real award for a spotless operator", async () => {
    const { operator } = await operatorWith();
    await expectAgreement(operator.id, "consistency", RUN);
    await expectAgreement(operator.id, "clean_vehicle", RUN);
    await expectAgreement(operator.id, "law_abiding", RUN);
  });

  it("agrees after a late balance", async () => {
    const { operator } = await operatorWith({ latePayments: 1 });
    await expectAgreement(operator.id, "consistency", "2029-02-01");
    await expectAgreement(operator.id, "law_abiding", RUN);
  });

  it("agrees after a confirmed offence", async () => {
    const { operator, tricycle } = await operatorWith();
    await offence(operator.id, tricycle.id, "R3", "confirmed", "2028-09-10");
    await expectAgreement(operator.id, "consistency", "2029-04-01");
    await expectAgreement(operator.id, "clean_vehicle", RUN);
    expect(await trackOf(operator.id, "law_abiding")).toMatchObject({ stage: "closed", nextAwardOn: null });
  });

  it("restores the run when an offence is waived", async () => {
    const { operator, tricycle } = await operatorWith();
    await offence(operator.id, tricycle.id, "R3", "waived", "2028-09-10");
    await expectAgreement(operator.id, "consistency", RUN);
    expect((await getMyAwardJourney(portal(operator.id))).lastBreak).toBeNull();
  });

  it("breaks the run when a payment is reversed", async () => {
    const { operator } = await operatorWith();
    const [payment] = (await db.execute(sql`
      SELECT id FROM payments WHERE operator_id = ${operator.id} ORDER BY business_date LIMIT 1
    `)) as unknown as { id: string }[];
    await reversePayment(on(manager, "2028-08-01"), payment!.id, { reason: "Bounced transfer" });
    await expectAgreement(operator.id, "consistency", "2029-02-01");
    expect((await getMyAwardJourney(portal(operator.id))).lastBreak).toEqual({ on: FROM, reason: "late_balance" });
  });

  it("still sees a payment reversed after the night job marked it on time", async () => {
    const day = "2033-05-10";
    const { id: operatorId } = await makeOperator(manager);
    const tricycle = await makeTricycle(manager);
    await issueTricycle(on(manager, "2033-05-01"), { tricycleId: tricycle.id, operatorId, issuedOn: "2033-05-01", dailyBalance: "10000" });
    await processDay(day, () => wat(addDays(day, 9)));
    const paid = (await recordPayment(on(manager, addDays(day, 1)), {
      operatorId,
      amount: "10,000",
      method: "transfer",
      reference: nextReference(),
      clientId: randomUUID(),
    })) as { id: string };
    await processDay(addDays(day, 2), () => wat(addDays(day, 9)));
    const [evaluation] = (await db.execute(sql`
      SELECT l.outcome FROM late_evaluations l JOIN charges c ON c.id = l.charge_id
      WHERE c.operator_id = ${operatorId} AND c.business_date = ${day}::date
    `)) as unknown as { outcome: string }[];
    expect(evaluation!.outcome).toBe("on_time");
    expect((await getMyAwardJourney(portal(operatorId, addDays(day, 3)))).breaks.map((row) => row.on)).not.toContain(day);

    await reversePayment(on(manager, addDays(day, 3)), paid.id, { reason: "Bounced transfer" });
    expect((await getMyAwardJourney(portal(operatorId, addDays(day, 3)))).breaks.map((row) => row.on)).toContain(day);
  });

  it("does not call a balance late while it is within its deadline", async () => {
    const operator = await makeOperator(manager);
    const tricycle = await makeTricycle(manager);
    await issueTricycle(on(manager, "2033-03-01"), { tricycleId: tricycle.id, operatorId: operator.id, issuedOn: "2033-03-01", dailyBalance: "10000" });
    await processDay("2033-03-02", () => wat("2033-03-02"));
    expect((await getMyAwardJourney(portal(operator.id, "2033-03-03"))).lastBreak).toBeNull();
    expect((await getMyAwardJourney(portal(operator.id, "2033-03-04"))).lastBreak).toEqual({ on: "2033-03-02", reason: "late_balance" });
  });

  it("agrees that a decision covers its period", async () => {
    const { operator } = await operatorWith();
    await propose();
    expect(await trackOf(operator.id, "consistency", "2029-01-02")).toMatchObject({ stage: "awaiting_decision" });
    const rows = await candidatesOf(operator.id);
    await approveAward(on(manager, "2029-01-02"), rows.find((row) => row.type === "consistency")!.id, { given: "Smartphone" });
    await rejectAward(manager, rows.find((row) => row.type === "law_abiding")!.id, { reason: "Spoke about conduct" });

    expect(await trackOf(operator.id, "consistency", "2029-01-02")).toMatchObject({ stage: "on_the_way", nextAwardOn: "2029-07-01" });
    expect(await trackOf(operator.id, "law_abiding", "2029-01-02")).toMatchObject({ nextAwardOn: "2029-07-01" });
    const { milestones } = await getMyAwardJourney(portal(operator.id, "2029-01-02"));
    expect(milestones.map((row) => row.label)).toContain("Consistency Winner");
  });

  describe("returning operators", () => {
    async function withEarlierStint(returnReason: "operator_left" | "reassigned") {
      const seeded = await operatorWith({ issuedOn: addDays(FROM, 1) });
      const earlier = await makeTricycle(manager);
      await db.insert(assignments).values({
        tricycleId: earlier.id,
        operatorId: seeded.operator.id,
        issuedOn: "2027-01-01",
        returnedOn: "2027-02-01",
        returnReason,
        issuedBy: managerId,
      });
      return seeded.operator;
    }

    it("restarts service for an operator who left and came back", async () => {
      const operator = await withEarlierStint("operator_left");
      expect(await awardFacts(db, operator.id, RUN)).toMatchObject({ firstIssuedOn: "2027-01-01", serviceStartedOn: addDays(FROM, 1) });
      expect(await judged(operator.id)).toEqual(NONE);
      await expectAgreement(operator.id, "consistency", "2029-02-01");
    });

    it("keeps service unbroken across a change of tricycle", async () => {
      const operator = await withEarlierStint("reassigned");
      expect(await judged(operator.id)).toEqual(ALL);
    });
  });

  describe("who can see it", () => {
    it("shows every active operator to all staff, without money", async () => {
      const { operator } = await operatorWith();
      for (const ctx of [owner, manager, supervisor]) {
        const race = await getAwardRace(on(ctx, TODAY));
        const row = race.operators.find((item) => item.operatorId === operator.id)!;
        expect(row).toMatchObject({ name: expect.stringMatching(/^Operator /), tricycleCode: expect.any(String) });
        expect(row.progress.awards).toHaveLength(3);
        expect(JSON.stringify(race)).not.toMatch(/kobo|cost|amount|owed/i);
      }
    });

    it("hides why a run ended from Supervisors, on the server", async () => {
      const { operator, tricycle } = await operatorWith({ latePayments: 1 });
      await offence(operator.id, tricycle.id, "R3", "confirmed", "2028-09-10");

      const staff = await getOperatorJourney(on(manager, TODAY), operator.id);
      expect(staff!.progress.lastBreak).toEqual({ on: "2028-09-10", reason: "offence" });
      expect(staff!.progress.breaks.map((row) => row.reason)).toEqual(["offence", "late_balance"]);
      expect(staff!.progress.breaks[0]!.ruleName).toBeTruthy();

      const field = await getOperatorJourney(on(supervisor, TODAY), operator.id);
      expect(field!.progress).toMatchObject({ lastBreak: null, breaks: [], recentDays: [] });
      expect(field!.progress.awards[0]!.nextAwardOn).toBe("2029-04-01");
      const race = await getAwardRace(on(supervisor, TODAY));
      expect(race.operators.find((row) => row.operatorId === operator.id)!.progress.breaks).toEqual([]);
    });

    it("finds nobody for an unknown operator, and refuses operators", async () => {
      const { operator } = await operatorWith();
      expect(await getOperatorJourney(manager, randomUUID())).toBeNull();
      await expect(getOperatorJourney(portal(operator.id), operator.id)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("refuses the race to operators and the journey to staff", async () => {
      const { operator } = await operatorWith();
      await expect(getAwardRace(portal(operator.id))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getMyAwardJourney(manager)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getMyAwardJourney({ ...manager, actor: { ...manager.actor, role: "operator" } })).rejects.toThrow(/not linked/);
    });

    it("puts the journey and Honour board on the portal", async () => {
      const { operator } = await operatorWith();
      const records = await getMyRecords(portal(operator.id));
      expect(records.journey.awards).toHaveLength(3);
      expect(records.honourBoard.rows.length).toBeLessThanOrEqual(5);
    });

    it("gives the Honour board only the permitted fields", async () => {
      const { operator } = await operatorWith();
      const board = await getHonourBoard(portal(operator.id));
      expect(board.rows.length).toBeGreaterThan(0);
      for (const row of board.rows) {
        expect(Object.keys(row).sort()).toEqual(["badges", "isYou", "name", "runDays", "tricycleCode"]);
      }
      expect(JSON.stringify(board)).not.toMatch(/phone|kobo|offence|late|break/i);
      await expect(getHonourBoard(manager)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("gives each operator only their own journey", async () => {
      const clean = await operatorWith();
      const late = await operatorWith({ latePayments: 1 });
      expect((await getMyAwardJourney(portal(clean.operator.id))).lastBreak).toBeNull();
      expect((await getMyAwardJourney(portal(late.operator.id))).lastBreak).not.toBeNull();
    });
  });
});

describe("notices", () => {
  const smsOf = (operatorId: string, kind: string) =>
    noticesFor(operatorId, kind);

  async function withUnpaid(day: string) {
    const operator = await makeOperator(manager);
    const tricycle = await makeTricycle(manager);
    const issuedOn = addDays(day, -2);
    await issueTricycle(on(manager, issuedOn), { tricycleId: tricycle.id, operatorId: operator.id, issuedOn, dailyBalance: "10000" });
    return operator;
  }

  it("reminds about a balance due today, once", async () => {
    const day = "2030-05-10";
    const operator = await withUnpaid(day);
    await processDay(addDays(day, -1), () => wat(addDays(day, 5))); // the charge, with no notice
    expect(await smsOf(operator.id, "balance_reminder")).toHaveLength(0);
    await processDay(day, () => wat(day, "06:00"));
    const sent = await smsOf(operator.id, "balance_reminder");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("₦10,000");
    await processDay(day, () => wat(day, "07:00"));
    expect(await smsOf(operator.id, "balance_reminder")).toHaveLength(1);
  });

  it("sends nothing when catching up on an old day", async () => {
    const day = "2030-06-10";
    const operator = await withUnpaid(day);
    await processDay(addDays(day, -1), () => wat(addDays(day, 5)));
    await processDay(day, () => wat(addDays(day, 5)));
    expect(await smsOf(operator.id, "balance_reminder")).toHaveLength(0);
  });
});

describe("celebrations", () => {
  const noticesOf = (operatorId: string, kind: string) =>
    noticesFor(operatorId, kind);
  const milestonesOf = (operatorId: string) => db.select().from(awardMilestones).where(eq(awardMilestones.operatorId, operatorId));
  const live = (rows: { voidedAt: Date | null; code: string }[]) => rows.filter((row) => !row.voidedAt).map((row) => row.code);
  const atNight = (day: string) => () => wat(day, "00:05");
  const rerun = async (day: string) => {
    await db.delete(jobRuns).where(eq(jobRuns.businessDate, day));
    await processDay(day, atNight(day));
  };

  async function issued(issuedOn: string) {
    const operator = await makeOperator(manager);
    const tricycle = await makeTricycle(manager);
    await issueTricycle(on(manager, issuedOn), { tricycleId: tricycle.id, operatorId: operator.id, issuedOn, dailyBalance: "10000" });
    return { operator, tricycle };
  }

  it("records a milestone and celebrates it once", async () => {
    const start = "2034-01-02";
    const day = addDays(start, 7);
    const { operator } = await issued(start);
    await processDay(day, atNight(day));
    await rerun(day);
    expect(live(await milestonesOf(operator.id))).toEqual(["first_week"]);
    const sent = await noticesOf(operator.id, "milestone");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("First Week! 7 days clean.");
  });

  it("records old milestones without announcing them, and is silent in a catch-up", async () => {
    const start = "2034-02-01";
    const { operator } = await issued(start);
    const later = addDays(start, 20);
    await processDay(later, atNight(later));
    expect(live(await milestonesOf(operator.id)).sort()).toEqual(["first_week", "steady_rider"]);
    expect(await noticesOf(operator.id, "milestone")).toHaveLength(0);

    const other = await issued("2034-03-01");
    const reached = addDays("2034-03-01", 7);
    await processDay(reached, () => wat(addDays(reached, 3)));
    expect(live(await milestonesOf(other.operator.id))).toEqual(["first_week"]);
    expect(await noticesOf(other.operator.id, "milestone")).toHaveLength(0);
  });

  it("voids a milestone when the record is corrected, and never celebrates twice", async () => {
    const start = "2034-04-03";
    const { operator, tricycle } = await issued(start);
    const reached = addDays(start, 7);
    await processDay(reached, atNight(reached));
    await offence(operator.id, tricycle.id, "R3", "confirmed", addDays(start, 3));

    const next = addDays(start, 8);
    await processDay(next, atNight(next));
    const rows = await milestonesOf(operator.id);
    expect(live(rows)).toEqual([]);
    expect(rows[0]!.voidReason).toMatch(/corrected/);

    // Waiving the offence restores it. The date has passed, so nothing is sent again.
    await db.update(violations).set({ status: "waived" }).where(eq(violations.operatorId, operator.id));
    const again = addDays(start, 9);
    await processDay(again, atNight(again));
    expect(live(await milestonesOf(operator.id))).toEqual(["first_week"]);
    expect(await noticesOf(operator.id, "milestone")).toHaveLength(1);
  });

  it("will not store the same once-only notice twice", async () => {
    const { operator } = await issued("2034-04-20");
    const row = { operatorId: operator.id, kind: "milestone" as const, body: "Once", dedupeKey: "milestone:test" };
    await db.transaction((tx) => notifyOperators(tx, new Date(), [row]));
    await db.transaction((tx) => notifyOperators(tx, new Date(), [row]));
    expect(await noticesOf(operator.id, "milestone")).toHaveLength(1);
  });

  it("protects milestone records in the database", async () => {
    const start = "2034-05-01";
    const { operator } = await issued(start);
    const day = addDays(start, 7);
    await processDay(day, atNight(day));
    const [row] = await milestonesOf(operator.id);
    await expect(db.delete(awardMilestones).where(eq(awardMilestones.id, row!.id))).rejects.toThrow();
    await expect(db.update(awardMilestones).set({ code: "other" }).where(eq(awardMilestones.id, row!.id))).rejects.toThrow();
    await expect(db.update(awardMilestones).set({ reachedOn: start, voidedAt: new Date(), voidReason: "x" }).where(eq(awardMilestones.id, row!.id))).rejects.toThrow();
    await expect(db.update(awardMilestones).set({ voidedAt: new Date() }).where(eq(awardMilestones.id, row!.id))).rejects.toThrow();
  });

  it("tells an operator once when a notable run ends, and not for a short one", async () => {
    const start = "2034-06-01";
    const long = await issued(start);
    const short = await issued(start);
    await offence(long.operator.id, long.tricycle.id, "R3", "confirmed", addDays(start, 8));
    await offence(short.operator.id, short.tricycle.id, "R3", "confirmed", addDays(start, 3));
    await offence(short.operator.id, short.tricycle.id, "R3", "confirmed", addDays(start, 9));
    const first = addDays(start, 9);
    const second = addDays(start, 10);
    await processDay(first, atNight(first));
    await processDay(second, atNight(second));
    const sent = await noticesOf(long.operator.id, "run_ended");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/^Your 8-day run has ended\. Your next award date is .+ You can do this\.$/);
    expect(await noticesOf(short.operator.id, "run_ended")).toHaveLength(0);
  });

  it("adds the run to the balance reminder only when it is worth protecting", async () => {
    const day = "2034-07-20";
    const longRun = await issued(addDays(day, -10));
    const shortRun = await issued(addDays(day, -2));
    await processDay(addDays(day, -1), () => wat(addDays(day, 5)));
    await processDay(day, atNight(day));
    expect((await noticesOf(longRun.operator.id, "balance_reminder"))[0]!.body).toContain("avoid a fine and keep your 10-day run.");
    expect((await noticesOf(shortRun.operator.id, "balance_reminder"))[0]!.body).toMatch(/avoid a fine\.$/);
  });

  it("says when an operator comes within reach of an award, on the 1st only", async () => {
    const close = await issued("2035-01-01");
    const ready = await issued("2034-12-01");
    await processDay("2035-05-01", atNight("2035-05-01"));
    await processDay("2035-05-02", atNight("2035-05-02"));
    const closeNotices = await noticesOf(close.operator.id, "award_near");
    expect(closeNotices.map((row) => row.body)).toEqual(["You are 61 days from the Consistency, Clean vehicle and Law-abiding awards. Keep it clean."]);
    expect((await noticesOf(ready.operator.id, "award_near")).map((row) => row.body)).toEqual([
      "You are 31 days from the Consistency, Clean vehicle and Law-abiding awards. Keep it clean.",
    ]);
  });

  it("shows what is due today on the portal, and nothing once paid", async () => {
    const day = "2035-08-10";
    const { operator } = await issued(addDays(day, -3));
    await processDay(addDays(day, -1), () => wat(addDays(day, 5)));
    const portal: Ctx = { actor: { userId: managerId, name: "Operator", role: "operator", operatorId: operator.id }, clock: () => wat(day) };
    expect((await getMyRecords(portal)).runAtRisk).toEqual({ owedKobo: 1_000_000 });
    await recordPayment(on(manager, day), { operatorId: operator.id, amount: "10,000", method: "transfer", reference: nextReference(), clientId: randomUUID() });
    expect((await getMyRecords(portal)).runAtRisk).toBeNull();
    await expect(getMyRunAtRisk(manager)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("reports", () => {
  const range = { from: "2028-07-01", to: "2029-01-31" };

  it.each(Object.keys(REPORTS) as ReportKey[])("%s runs", async (key) => {
    const report = await runReport(owner, key, range);
    expect(report.columns.length).toBeGreaterThan(0);
  });

  it("adds up a day's collections and leaves out reversed money", async () => {
    const day = "2031-03-03";
    const operator = await makeOperator(manager);
    const ctx = on(manager, day);
    const pay = (method: string, amount: string) =>
      recordPayment(ctx, { operatorId: operator.id, amount, method, reference: nextReference(), clientId: randomUUID() });
    await pay("transfer", "5,000");
    await pay("pos", "2,000");
    const reversed = (await pay("transfer", "9,000")) as { id: string };
    await reversePayment(ctx, reversed.id, { reason: "Entered twice" });

    const report = await runReport(owner, "collections", { from: day, to: day });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ day, cash: 0, transfer: 500_000, pos: 200_000, collected: 700_000 });
    expect(report.totals.collected).toBe(700_000);
  });

  it("counts offences by rule by decision", async () => {
    const { operator, tricycle } = await operatorWith();
    await offence(operator.id, tricycle.id, "R3", "confirmed", "2032-01-05");
    await offence(operator.id, tricycle.id, "R3", "waived", "2032-01-06");
    const report = await runReport(owner, "offences_by_rule", { from: "2032-01-01", to: "2032-01-31" });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ confirmed: 1, waived: 1, rejected: 0, fines: 500_000 });
  });

  it("keeps reports from Supervisors", async () => {
    await expect(runReport(supervisor, "arrears", range)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("writes a safe CSV", () => {
    const csv = reportCsv({
      columns: [
        { key: "name", label: "Name", kind: "text" },
        { key: "amount", label: "Amount", kind: "naira" },
      ],
      rows: [
        { name: "=HYPERLINK(1)", amount: 123_456 },
        { name: 'Musa, "Baba"', amount: 100 },
      ],
    });
    expect(csv.startsWith("﻿Name,Amount\r\n")).toBe(true);
    expect(csv).toContain("'=HYPERLINK(1),1234.56");
    expect(csv).toContain('"Musa, ""Baba""",1.00');
  });
});
