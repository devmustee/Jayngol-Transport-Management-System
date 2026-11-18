import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, backEntryWindows, charges, jobRuns, lateEvaluations, nonCollectionDays, violations } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import { changeIssueDate, issueTricycle } from "@/services/assignments";
import { backEntryReason, finishBackEntries, openBackEntries } from "@/services/back-entries";
import type { Ctx } from "@/services/context";
import { processDay } from "@/services/daily-job";
import { recordPayment } from "@/services/payments";
import { makeOperator, makeTricycle, makeUser, nextReference } from "./helpers";

// Far from other files' dates, so their balances and fines never mix with these.
const D = (day: number) => `2041-11-${String(day).padStart(2, "0")}`;
const TODAY = D(20);

const wat = (date: string, time = "09:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date = TODAY, time?: string): Ctx => ({ ...ctx, clock: () => wat(date, time) });
const nightly = (date: string) => processDay(date, () => wat(date, "00:05"));

let manager: Ctx;
let assistant: Ctx;
beforeAll(async () => {
  manager = on((await makeUser("manager")).ctx);
  assistant = on((await makeUser("assistant_manager")).ctx);
});

// The nightly job has already done today, as on go-live day.
beforeEach(async () => {
  await db.delete(jobRuns);
  await db.insert(jobRuns).values({ job: "daily", businessDate: TODAY, finishedAt: wat(TODAY, "00:05") });
  await db.update(backEntryWindows).set({ closedAt: new Date() });
});

// Other files run the nightly job from their own dates.
afterAll(async () => {
  await db.delete(jobRuns);
  await db.update(backEntryWindows).set({ closedAt: new Date() });
});

async function issued(ctx: Ctx, issuedOn: string) {
  const tricycle = await makeTricycle(manager);
  const operator = await makeOperator(manager);
  const result = await issueTricycle(ctx, { tricycleId: tricycle.id, operatorId: operator.id, issuedOn });
  return { tricycle, operator, result: result! };
}

const balances = async (operatorId: string) =>
  (await db.select().from(charges).where(and(eq(charges.operatorId, operatorId), eq(charges.type, "daily_balance"))))
    .map((c) => [c.businessDate, c.amountKobo] as const)
    .sort();
const fines = (operatorId: string) =>
  db.select().from(violations).where(and(eq(violations.operatorId, operatorId), eq(violations.ruleCode, "R1")));

const payLate = (operatorId: string, day: string) =>
  recordPayment(manager, {
    operatorId,
    clientId: randomUUID(),
    amount: "10,000",
    method: "transfer",
    reference: nextReference(),
    purpose: "day",
    backdateTo: day,
    backdateReason: "Records start",
  });

describe("issuing with a past date", () => {
  it("adds every day the nightly job has already done, at the tricycle's amount", async () => {
    const { operator, result } = await issued(manager, D(17));
    expect(await balances(operator.id)).toEqual([
      [D(18), 1_000_000],
      [D(19), 1_000_000],
      [D(20), 1_000_000],
    ]);
    expect(result.raised).toEqual({ days: [D(18), D(19), D(20)], totalKobo: 3_000_000 });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "assignment.issue"), eq(auditLog.actorUserId, manager.actor.userId)))
      .orderBy(auditLog.occurredAt);
    expect(JSON.stringify(audit?.after)).toContain(D(18));
  });

  it("skips no-balance days, like the nightly job", async () => {
    await db
      .insert(nonCollectionDays)
      .values({ businessDate: D(19), reason: "Holiday", createdBy: manager.actor.userId })
      .onConflictDoNothing();
    const { operator } = await issued(manager, D(17));
    expect((await balances(operator.id)).map(([day]) => day)).toEqual([D(18), D(20)]);
    await db.delete(nonCollectionDays).where(eq(nonCollectionDays.businessDate, D(19)));
  });

  it("adds nothing when issued today, and the next night adds the next day once", async () => {
    const today = await issued(manager, TODAY);
    expect(today.result.raised.days).toEqual([]);
    const past = await issued(manager, D(18));
    await nightly(D(21));
    expect((await balances(past.operator.id)).map(([day]) => day)).toEqual([D(19), D(20), D(21)]);
    expect((await balances(today.operator.id)).map(([day]) => day)).toEqual([D(21)]);
  });

  it("works the same for the Assistant Manager", async () => {
    const { operator } = await issued(assistant, D(18));
    expect((await balances(operator.id)).map(([day]) => day)).toEqual([D(19), D(20)]);
  });

  it("adds the missing days when the issue date is moved earlier", async () => {
    const { operator, result } = await issued(manager, D(19));
    expect(result.raised.days).toEqual([D(20)]);
    const raised = await changeIssueDate(manager, result.id, { issuedOn: D(16), reason: "Records start earlier" });
    expect(raised).toEqual({ days: [D(17), D(18), D(19)], totalKobo: 3_000_000 });
    expect((await balances(operator.id)).map(([day]) => day)).toEqual([D(17), D(18), D(19), D(20)]);
  });
});

describe("holding fines while back entries are open", () => {
  const open = (ctx: Ctx = manager, stopOn = D(27)) =>
    openBackEntries(ctx, { fromDate: D(18), untilDate: D(20), stopOn });

  it("fines nobody until the Manager finishes, then only the days truly unpaid", async () => {
    await open();
    const { operator } = await issued(manager, D(17));
    await nightly(D(21));
    await nightly(D(22));
    expect(await fines(operator.id)).toEqual([]);

    await payLate(operator.id, D(18));
    await finishBackEntries(manager);
    await nightly(D(23));

    const outcomes = await db
      .select({ outcome: lateEvaluations.outcome, day: charges.businessDate })
      .from(lateEvaluations)
      .innerJoin(charges, eq(charges.id, lateEvaluations.chargeId))
      .where(eq(charges.operatorId, operator.id))
      .orderBy(charges.businessDate);
    expect(outcomes.slice(0, 3)).toEqual([
      { outcome: "on_time", day: D(18) },
      { outcome: "fined", day: D(19) },
      { outcome: "fined", day: D(20) },
    ]);
  });

  it("checks days after the window as normal", async () => {
    await open();
    const { operator } = await issued(manager, D(20));
    await nightly(D(21));
    await nightly(D(22));
    await nightly(D(23));
    // 21 Nov is after the window, due on the 22nd, so the run on the 23rd fines it.
    expect(await fines(operator.id)).toHaveLength(1);
  });

  it("ends by itself on its stop date", async () => {
    await open(manager, D(22));
    const { operator } = await issued(manager, D(18));
    await nightly(D(21));
    expect(await fines(operator.id)).toEqual([]);
    await nightly(D(22));
    expect(await fines(operator.id)).toHaveLength(2);
  });

  it("fills in the late reason only for days in the window", async () => {
    await open();
    expect(await backEntryReason(manager, D(19))).toBe("Records start 18 Nov 2041");
    expect(await backEntryReason(manager, D(17))).toBeUndefined();
    await finishBackEntries(manager);
    expect(await backEntryReason(manager, D(19))).toBeUndefined();
  });

  it("lets only the Manager open or finish, one window at a time, within limits", async () => {
    await expect(open(assistant)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openBackEntries(manager, { fromDate: D(18), untilDate: D(21), stopOn: D(27) })).rejects.toMatchObject({
      fieldErrors: { untilDate: expect.anything() },
    });
    await expect(open(manager, D(20))).rejects.toMatchObject({ fieldErrors: { stopOn: expect.anything() } });
    // More than 14 days ahead.
    await expect(open(manager, "2041-12-05")).rejects.toMatchObject({ fieldErrors: { stopOn: expect.anything() } });
    await open();
    await expect(open()).rejects.toThrow(/already open/);
    await expect(finishBackEntries(assistant)).rejects.toBeInstanceOf(ForbiddenError);
    await finishBackEntries(manager);
    await expect(finishBackEntries(manager)).rejects.toThrow(/not open/);
  });
});
