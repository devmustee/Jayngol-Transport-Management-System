import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, awardCandidates, awards, jobRuns, operators, photos, smsOutbox, violations } from "@/db/schema";
import { addDays, addMonths } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import { issueTricycle } from "@/services/assignments";
import {
  approveAward,
  awardBlockers,
  awardFacts,
  getMyAwardProgress,
  listAwards,
  proposeAwards,
  rejectAward,
  type AwardFacts,
} from "@/services/awards";
import type { Ctx } from "@/services/context";
import { processDay } from "@/services/daily-job";
import { getPhoto } from "@/services/inspections";
import { recordPayment, reversePayment } from "@/services/payments";
import { getMyRecords } from "@/services/portal";
import { reportCsv, REPORTS, runReport, type ReportKey } from "@/services/reports";
import { makeOperator, makeTricycle, makeUser } from "./helpers";

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

async function phoneOf(operatorId: string) {
  const [row] = await db.select({ phone: operators.phone }).from(operators).where(eq(operators.id, operatorId));
  return row!.phone;
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
    await approveAward(on(manager, "2029-01-03"), candidate.id, { given: "Smartphone", cost: "150,000" });

    const [award] = await db.select().from(awards).where(eq(awards.candidateId, candidate.id));
    expect(award).toMatchObject({ given: "Smartphone", costKobo: 15_000_000, givenOn: "2029-01-03" });
    expect((await candidatesOf(operator.id)).find((row) => row.id === candidate.id)!.status).toBe("approved");
    const sms = await db.select().from(smsOutbox).where(and(eq(smsOutbox.toPhone, await phoneOf(operator.id)), eq(smsOutbox.kind, "award")));
    expect(sms).toHaveLength(1);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.action, "award.approve"), eq(auditLog.entityId, operator.id)));
    expect(audit).toHaveLength(1);
    await expect(db.update(awards).set({ given: "x" }).where(eq(awards.id, award!.id))).rejects.toThrow();
    await expect(approveAward(manager, candidate.id, { given: "Again", cost: "1" })).rejects.toThrow(/already been decided/);
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
    await expect(approveAward(manager, candidate.id, { given: "Cash", cost: "50,000" })).rejects.toThrow(/must be decided first/);
  });

  it("blocks approval if an offence was confirmed after the proposal", async () => {
    const { operator, tricycle } = await operatorWith();
    await propose();
    await offence(operator.id, tricycle.id, "R3", "confirmed", "2028-12-20");
    const candidate = (await candidatesOf(operator.id)).find((row) => row.type === "law_abiding")!;
    await expect(approveAward(manager, candidate.id, { given: "Cash", cost: "50,000" })).rejects.toThrow(/no longer qualifies/);
  });

  it("requires a cost and a rejection reason", async () => {
    const { operator } = await operatorWith();
    await propose();
    const [candidate] = await candidatesOf(operator.id);
    await expect(approveAward(manager, candidate!.id, { given: "Phone", cost: "" })).rejects.toMatchObject({ fieldErrors: { cost: expect.anything() } });
    await expect(rejectAward(manager, candidate!.id, { reason: "" })).rejects.toMatchObject({ fieldErrors: { reason: expect.anything() } });
  });

  it("lets only the Manager decide and the owner watch", async () => {
    const { operator } = await operatorWith();
    await propose();
    const [candidate] = await candidatesOf(operator.id);
    await expect(approveAward(owner, candidate!.id, { given: "x", cost: "1" })).rejects.toBeInstanceOf(ForbiddenError);
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

  it("shows only the logged-in operator's own records, without award costs", async () => {
    const mine = await operatorWith();
    const other = await operatorWith({ latePayments: 2 });
    await propose();
    const candidate = (await candidatesOf(mine.operator.id)).find((row) => row.type === "consistency")!;
    await approveAward(on(manager, "2029-01-02"), candidate.id, { given: "Smartphone", cost: "150,000" });

    const records = await getMyRecords(portalFor(mine.operator.id));
    expect(records.current?.assignmentId).toBe(mine.assignmentId);
    expect(records.statement.awards).toHaveLength(1);
    expect(JSON.stringify(records.statement.awards)).not.toMatch(/cost/i);
    expect(JSON.stringify(records)).not.toContain(other.assignmentId);
  });

  it("explains what is holding an award back", async () => {
    const { operator } = await operatorWith({ issuedOn: "2028-12-01" });
    const progress = await getMyAwardProgress(portalFor(operator.id));
    expect(progress.find((row) => row.type === "consistency")!.blockers.join(" ")).toMatch(/6 months/);
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

describe("notices", () => {
  const smsOf = async (operatorId: string, kind: string) =>
    db.select().from(smsOutbox).where(and(eq(smsOutbox.toPhone, await phoneOf(operatorId)), eq(smsOutbox.kind, kind)));

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
      recordPayment(ctx, { operatorId: operator.id, amount, method, clientId: randomUUID() });
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
      title: "t",
      ranged: false,
      totals: {},
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
