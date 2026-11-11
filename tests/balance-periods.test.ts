import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { charges, jobRuns } from "@/db/schema";
import { addDays } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import { monthEnd, parsePulse, parseRange, periodOf, weekStart } from "@/lib/periods";
import { changeRate, issueTricycle } from "@/services/assignments";
import {
  balanceStillToCome,
  balanceTotals,
  collectionsByCashier,
  fleetPeriod,
  moneyReceived,
  myBalancePeriods,
  myCollections,
  operatorBalancePeriods,
} from "@/services/balance-periods";
import type { Ctx } from "@/services/context";
import { runDailyJob } from "@/services/daily-job";
import { addNonCollectionDay } from "@/services/finance";
import { voidCharge } from "@/services/ledger";
import { recordPayment, reversePayment } from "@/services/payments";
import { runReport } from "@/services/reports";
import { makeOperator, makeTricycle, makeUser, nextReference } from "./helpers";

const at = (date: string, time = "00:05") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time = "12:00"): Ctx => ({ ...ctx, clock: () => at(date, time) });
const job = (date: string) => runDailyJob(() => at(date));

describe("week and month boundaries", () => {
  it("runs the week from Monday to Sunday", () => {
    expect(weekStart("2028-02-07")).toBe("2028-02-07"); // Monday
    expect(weekStart("2028-02-13")).toBe("2028-02-07"); // Sunday belongs to the week before Monday
    expect(weekStart("2028-02-14")).toBe("2028-02-14");
    expect(weekStart("2028-01-01")).toBe("2027-12-27"); // crosses the year
  });

  it("knows the last day of 28, 29, 30 and 31 day months", () => {
    expect(monthEnd("2027-02-10")).toBe("2027-02-28");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
    expect(monthEnd("2028-04-30")).toBe("2028-04-30");
    expect(monthEnd("2028-01-01")).toBe("2028-01-31");
  });

  it("compares with the same point in the period before", () => {
    expect(periodOf("week", "2028-02-09")).toEqual({
      kind: "week",
      soFar: { from: "2028-02-07", to: "2028-02-09" },
      full: { from: "2028-02-07", to: "2028-02-13" },
      previous: { from: "2028-01-31", to: "2028-02-02" },
    });
    // 31 March cannot compare with 31 February, so it stops at the end of February.
    expect(periodOf("month", "2028-03-31").previous).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(periodOf("month", "2028-03-31").full).toEqual({ from: "2028-03-01", to: "2028-03-31" });
  });

  it("ignores date ranges from the page address that are not real", () => {
    expect(parseRange({ from: "2026-11-09", to: "2026-11-15" })).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(parseRange({ from: "2026-13-40", to: "2026-11-15" })).toBeNull();
    expect(parseRange({ from: "2026-02-30", to: "2026-03-02" })).toBeNull();
    expect(parseRange({ from: "2026-11-15", to: "2026-11-09" })).toBeNull();
    expect(parseRange({ from: "nonsense", to: "2026-11-15" })).toBeNull();
    expect(parseRange({ to: "2026-11-15" })).toBeNull();
    expect(parsePulse("week")).toBe("week");
    expect(parsePulse("year")).toBe("today");
    expect(parsePulse(undefined)).toBe("today");
  });
});

/**
 * Hand-checked fortnight in February 2028. Week one is Mon 7 to Sun 13 Feb,
 * and Sat 12 Feb is a non-collection day.
 *
 * Operator A, ₦10,000 a day, is charged 7, 8, 9, 10, 11 and 13 Feb: ₦60,000.
 *   Mon 7:  pays ₦10,000 by transfer, clearing the 7th.
 *   Wed 9:  pays ₦15,000 in cash to the Assistant Manager: the 8th and half the 9th.
 *   Mon 14: pays ₦20,000: the rest of the 9th, the 10th, and half the 11th.
 * Week one for A: due ₦60,000, paid ₦45,000, owed ₦15,000, 4 of 6 days in full.
 */
describe("weekly and monthly balances", () => {
  const WEEK1 = { from: "2028-02-07", to: "2028-02-13" };
  const WEEK2 = { from: "2028-02-14", to: "2028-02-20" };
  let manager: Ctx;
  let assistant: Ctx;
  let supervisor: Ctx;
  let a: string;
  let b: string;
  let c: string;
  let d: string;
  let lateCatchUp: string;

  async function operatorFrom(firstChargeDay: string, balance = "10000") {
    const t = await makeTricycle(manager);
    const o = await makeOperator(manager);
    const issued = addDays(firstChargeDay, -1);
    const assignment = (await issueTricycle(on(manager, issued), {
      tricycleId: t.id,
      operatorId: o.id,
      issuedOn: issued,
      dailyBalance: balance,
    }))!;
    return { operatorId: o.id, assignmentId: assignment.id };
  }

  const pay = (ctx: Ctx, operatorId: string, amount: string, extra: Record<string, unknown> = {}) =>
    recordPayment(ctx, {
      operatorId,
      amount,
      method: "transfer",
      reference: nextReference(),
      clientId: randomUUID(),
      ...extra,
    });

  beforeAll(async () => {
    manager = (await makeUser("manager")).ctx;
    assistant = (await makeUser("assistant_manager")).ctx;
    supervisor = (await makeUser("supervisor")).ctx;

    await db.delete(jobRuns);
    await db.insert(jobRuns).values({ job: "daily", businessDate: "2028-02-06", finishedAt: at("2028-02-06") });
    await addNonCollectionDay(on(manager, "2028-02-01"), { businessDate: "2028-02-12", reason: "Test holiday" });

    a = (await operatorFrom("2028-02-07")).operatorId;
    const second = await operatorFrom("2028-02-07");
    b = second.operatorId;
    await changeRate(on(manager, "2028-02-07"), second.assignmentId, { dailyBalance: "15000", effectiveFrom: "2028-02-10" });
    c = (await operatorFrom("2028-02-07")).operatorId;
    d = (await operatorFrom("2028-02-07")).operatorId;

    await job("2028-02-07");
    await pay(on(manager, "2028-02-07"), a, "10000");
    await pay(on(manager, "2028-02-07"), d, "100000"); // far more than owed: the rest waits as credit
    await job("2028-02-08");
    await job("2028-02-09");
    await pay(on(assistant, "2028-02-09"), a, "15000", { method: "cash", tricyclePresent: "yes", reference: undefined });
    for (const day of ["2028-02-10", "2028-02-11", "2028-02-12", "2028-02-13"]) await job(day);
    await pay(on(manager, "2028-02-13", "23:59"), c, "1000");
    await pay(on(manager, "2028-02-14", "00:00"), c, "1000");
    await job("2028-02-14");
    lateCatchUp = (await pay(on(manager, "2028-02-14"), a, "20000"))!.id;
  }, 120_000); // The night job also charges every operator other test files leave behind.

  it("adds up a hand-checked week to the kobo", async () => {
    expect(await balanceTotals(db, WEEK1, a)).toEqual({
      dueKobo: 6_000_000,
      paidKobo: 4_500_000,
      owedKobo: 1_500_000,
      daysCharged: 6, // the non-collection day adds nothing
      daysPaidInFull: 4,
      oldestUnpaid: "2028-02-11",
    });
  });

  it("counts a late payment as Paid for the week owed and Received for the week paid", async () => {
    const week1 = await moneyReceived(db, WEEK1, { operatorId: a });
    expect(week1.totalKobo).toBe(2_500_000);
    expect(week1.byMethod).toEqual({ cash: 1_500_000, pos: 0, transfer: 1_000_000 });
    expect(week1.forBalancesKobo).toBe(2_500_000);

    const week2 = await moneyReceived(db, WEEK2, { operatorId: a });
    expect(week2.totalKobo).toBe(2_000_000);
    expect(week2.forBalancesKobo).toBe(2_000_000);
  });

  it("uses the rate in force each day when it changes mid-week", async () => {
    // 7, 8, 9 Feb at ₦10,000 and 10, 11, 13 Feb at ₦15,000.
    expect((await balanceTotals(db, WEEK1, b)).dueKobo).toBe(7_500_000);
  });

  it("splits Sunday 23:59 and Monday 00:00 into different weeks", async () => {
    expect((await moneyReceived(db, WEEK1, { operatorId: c })).totalKobo).toBe(100_000);
    expect((await moneyReceived(db, WEEK2, { operatorId: c })).totalKobo).toBe(100_000);
  });

  it("shows unused money as credit until balances use it", async () => {
    const totals = await balanceTotals(db, WEEK1, d);
    expect(totals).toMatchObject({ dueKobo: 6_000_000, paidKobo: 6_000_000, owedKobo: 0, oldestUnpaid: null });
    const received = await moneyReceived(db, WEEK1, { operatorId: d });
    expect(received.totalKobo).toBe(10_000_000);
    // Seven balances (7 to 14 Feb, without the 12th) have used ₦70,000 of it so far.
    expect(received.forBalancesKobo).toBe(7_000_000);
    expect(received.creditKobo).toBe(3_000_000);
  });

  it("gives each cashier only the money they recorded", async () => {
    const onWednesday = await myCollections(on(assistant, "2028-02-09", "18:00"));
    expect(onWednesday.day.totalKobo).toBe(1_500_000);
    expect(onWednesday.week.byMethod.cash).toBe(1_500_000);

    const nextMonday = await myCollections(on(assistant, "2028-02-14", "18:00"));
    expect(nextMonday.day.totalKobo).toBe(0);
    expect(nextMonday.week.totalKobo).toBe(0);
    expect(nextMonday.month.totalKobo).toBe(1_500_000);
  });

  it("lists what each cashier took today, this week and this month", async () => {
    const rows = await collectionsByCashier(on(manager, "2028-02-14", "18:00"));
    const mine = (ctx: Ctx) => rows.find((row) => row.userId === ctx.actor.userId);
    // Manager: ₦10,000 + ₦100,000 + ₦1,000 last week, and ₦1,000 + ₦20,000 on Monday 14th.
    expect(mine(manager)).toMatchObject({ dayKobo: 2_100_000, weekKobo: 2_100_000, monthKobo: 13_200_000 });
    expect(mine(assistant)).toMatchObject({ dayKobo: 0, weekKobo: 0, monthKobo: 1_500_000 });
    await expect(collectionsByCashier(supervisor)).rejects.toThrow(ForbiddenError);
  });

  it("adds every operator into the fleet total", async () => {
    const fleet = await fleetPeriod(on(manager, "2028-02-13", "18:00"), "week");
    expect(fleet.period.soFar).toEqual(WEEK1);
    expect(fleet.period.previous).toEqual({ from: "2028-01-31", to: "2028-02-06" });

    const charged = (await db.execute(sql`
      SELECT DISTINCT operator_id::text AS id FROM charges
      WHERE type = 'daily_balance' AND business_date BETWEEN '2028-02-07' AND '2028-02-13'
    `)) as unknown as { id: string }[];
    let due = 0;
    let paid = 0;
    for (const { id } of charged) {
      const one = await balanceTotals(db, WEEK1, id);
      due += one.dueKobo;
      paid += one.paidKobo;
    }
    expect(fleet.balances.dueKobo).toBe(due);
    expect(fleet.balances.paidKobo).toBe(paid);
    expect(charged.map((row) => row.id)).toEqual(expect.arrayContaining([a, b, c, d]));
  });

  it("gives the same totals in the collections report as on the screens", async () => {
    const MONTH = { from: "2028-02-01", to: "2028-02-29" };
    for (const [range, group] of [
      [WEEK1, "week"],
      [MONTH, "month"],
    ] as const) {
      const report = await runReport(manager, "collections", range, group);
      expect(report.title).toBe(group === "week" ? "Weekly collections" : "Monthly collections");
      expect(report.rows).toHaveLength(1);
      const row = report.rows[0]!;
      const balances = await balanceTotals(db, range);
      const received = await moneyReceived(db, range);
      expect(row).toMatchObject({ day: range.from, to: range.to });
      expect(row.due).toBe(balances.dueKobo);
      expect(row.paid).toBe(balances.paidKobo);
      expect(row.owed).toBe(balances.owedKobo);
      expect(row.collected).toBe(received.totalKobo);
      expect(row.cash).toBe(received.byMethod.cash);
    }
  });

  it("cuts a week that runs past the chosen dates", async () => {
    const report = await runReport(manager, "collections", { from: "2028-02-09", to: "2028-02-20" }, "week");
    expect(report.rows.map((row) => [row.day, row.to])).toEqual([
      ["2028-02-14", "2028-02-20"],
      ["2028-02-09", "2028-02-13"],
    ]);
    const daily = await runReport(manager, "collections", { from: "2028-02-09", to: "2028-02-20" }, "day");
    expect(daily.rows).toHaveLength(12);
    expect(report.totals.due).toBe(daily.totals.due);
    expect(report.totals.collected).toBe(daily.totals.collected);
  });

  it("raises Owed again when a payment is reversed", async () => {
    await reversePayment(on(manager, "2028-02-15"), lateCatchUp, { reason: "Transfer bounced" });
    expect(await balanceTotals(db, WEEK1, a)).toMatchObject({
      paidKobo: 2_500_000,
      owedKobo: 3_500_000,
      daysPaidInFull: 2,
      oldestUnpaid: "2028-02-09", // part-paid, so not paid in full
    });
    expect((await moneyReceived(db, WEEK2, { operatorId: a })).totalKobo).toBe(0);
  });

  it("lowers Due when a charge is voided", async () => {
    const [sunday] = await db
      .select({ id: charges.id })
      .from(charges)
      .where(and(eq(charges.operatorId, a), eq(charges.businessDate, "2028-02-13"), eq(charges.type, "daily_balance")));
    await db.transaction((tx) => voidCharge(tx, sunday!.id, { userId: null, at: at("2028-02-15") }, "Test"));
    expect(await balanceTotals(db, WEEK1, a)).toMatchObject({ dueKobo: 5_000_000, daysCharged: 5 });
  });

  it("shows money paid towards fines apart from balances", async () => {
    // A left the 9th part-paid past its two days, so the night job fined them.
    await pay(on(manager, "2028-02-15"), a, "3000", { penaltyAmount: "3000" });
    const week2 = await moneyReceived(db, WEEK2, { operatorId: a });
    expect(week2).toMatchObject({ totalKobo: 300_000, forFinesKobo: 300_000, forBalancesKobo: 0, creditKobo: 0 });
  });

  it("works out the rest of the week by the night job's rules", async () => {
    // From Wed 9 Feb: the 10th, 11th and 13th are still to come; the 12th is a holiday.
    expect(await balanceStillToCome(db, a, "2028-02-09", "2028-02-13")).toEqual({ days: 3, kobo: 3_000_000 });
    // B's rate goes up to ₦15,000 from the 10th, so every day still to come uses it.
    expect(await balanceStillToCome(db, b, "2028-02-09", "2028-02-13")).toEqual({ days: 3, kobo: 4_500_000 });
    // On Sunday nothing is left in the week.
    expect(await balanceStillToCome(db, a, "2028-02-13", "2028-02-13")).toEqual({ days: 0, kobo: 0 });

    const operatorLogin: Ctx = {
      actor: { userId: manager.actor.userId, name: "Operator", role: "operator", operatorId: a },
      clock: () => at("2028-02-09", "18:00"),
    };
    const [week, month] = await myBalancePeriods(operatorLogin);
    expect(week!.stillToCome).toEqual({ days: 3, kobo: 3_000_000 });
    // 10 to 29 Feb is 20 days, less the holiday on the 12th.
    expect(month!.stillToCome).toEqual({ days: 19, kobo: 19_000_000 });
  });

  it("shows an operator only their own week and month", async () => {
    const operatorLogin: Ctx = {
      actor: { userId: manager.actor.userId, name: "Operator", role: "operator", operatorId: a },
      clock: () => at("2028-02-13", "18:00"),
    };
    const [week, month] = await myBalancePeriods(operatorLogin);
    expect(week!.period.soFar).toEqual(WEEK1);
    expect(week!.balances).toEqual(await balanceTotals(db, WEEK1, a));
    expect(month!.period.soFar).toEqual({ from: "2028-02-01", to: "2028-02-13" });

    const staffView = await operatorBalancePeriods(on(manager, "2028-02-13", "18:00"), a);
    expect(staffView[0]!.balances).toEqual(week!.balances);

    await expect(
      myBalancePeriods({ ...operatorLogin, actor: { ...operatorLogin.actor, operatorId: null } }),
    ).rejects.toThrow(/not linked/);
  });

  it("keeps money away from people who may not see it", async () => {
    await expect(fleetPeriod(supervisor, "week")).rejects.toThrow(ForbiddenError);
    await expect(operatorBalancePeriods(supervisor, a)).rejects.toThrow(ForbiddenError);
    await expect(myCollections(supervisor)).rejects.toThrow(ForbiddenError);
    await expect(myBalancePeriods(manager)).rejects.toThrow(ForbiddenError);
  });
});
