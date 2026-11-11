import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { charges, expenseAdvances, expenseLines, expenseLineVoids, operatorDeposits, operatorDepositReversals } from "@/db/schema";
import { closeDueBy, coverageLabel } from "@/lib/cash-rhythm";
import { ForbiddenError } from "@/lib/errors";
import { balanceTotals, moneyReceived } from "@/services/balance-periods";
import { annualBalance, annualRows, buildAnnualBalance, weekParts, type YearFigures } from "@/services/annual-balance";
import { cashAlerts } from "@/services/cash-book";
import type { Ctx } from "@/services/context";
import { cashDay, checkCashClose, closeCash, uncheckedCloses } from "@/services/finance";
import { voidCharge } from "@/services/ledger";
import { grantLoan } from "@/services/loans";
import { recordPayment, reversePayment } from "@/services/payments";
import { makeOperator, makeUser, nextSerial } from "./helpers";

const wat = (date: string, time = "12:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: () => wat(date, time) });

let manager: Ctx;
let owner: Ctx;
beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  owner = (await makeUser("owner")).ctx;
});

const KEYS: (keyof YearFigures)[] = [
  "dueKobo",
  "paidKobo",
  "owedKobo",
  "receivedKobo",
  "cashKobo",
  "forBalancesKobo",
  "forLoansKobo",
  "creditKobo",
  "expensesKobo",
  "loansGivenKobo",
  "netKobo",
  "depositsKobo",
];

const add = (rows: YearFigures[], key: keyof YearFigures) => rows.reduce((sum, row) => sum + row[key], 0);

describe("splitting weeks at month ends", () => {
  it("cuts a week that crosses into the next month", () => {
    expect(weekParts({ from: "2026-09-01", to: "2026-09-30" })).toEqual([
      { from: "2026-09-01", to: "2026-09-06" },
      { from: "2026-09-07", to: "2026-09-13" },
      { from: "2026-09-14", to: "2026-09-20" },
      { from: "2026-09-21", to: "2026-09-27" },
      { from: "2026-09-28", to: "2026-09-30" },
    ]);
    expect(weekParts({ from: "2026-10-01", to: "2026-10-31" })[0]).toEqual({ from: "2026-10-01", to: "2026-10-04" });
  });
});

describe("annual balance", () => {
  // 2047 is used by no other test, so every figure here is known exactly.
  const YEAR = 2047;

  beforeAll(async () => {
    const op = await makeOperator(manager);
    // Mon 30 Sep 2047 to Sun 6 Oct 2047 crosses the month end.
    for (const day of ["2047-09-29", "2047-09-30", "2047-10-01"]) {
      await db.insert(charges).values({ type: "daily_balance", operatorId: op.id, amountKobo: 1_000_000, businessDate: day });
    }
    const [voided] = await db
      .insert(charges)
      .values({ type: "daily_balance", operatorId: op.id, amountKobo: 1_000_000, businessDate: "2047-10-02" })
      .returning({ id: charges.id });
    await db.transaction((tx) => voidCharge(tx, voided!.id, { userId: null, at: wat("2047-10-02") }, "Entered twice"));

    await grantLoan(on(manager, "2047-09-30"), { operatorId: op.id, amount: "20,000", source: "owner" });
    const pay = (date: string, amount: string, extra: Record<string, unknown> = {}) =>
      recordPayment(on(manager, date), { operatorId: op.id, amount, method: "cash", clientId: randomUUID(), ...extra });
    await pay("2047-10-01", "25,000");
    await pay("2047-10-01", "8,000", { loanAmount: "8,000" });
    const mistake = (await pay("2047-10-02", "1,000"))!;
    await reversePayment(on(manager, "2047-10-02"), mistake.id, { reason: "Wrong operator" });

    const [advance] = await db
      .insert(expenseAdvances)
      .values({
        purpose: "Engine oil",
        amountKobo: 1_000_000,
        account: "owner",
        collectedOn: "2047-10-03",
        collectedBy: manager.actor.userId,
        createdAt: wat("2047-10-03"),
      })
      .returning({ id: expenseAdvances.id });
    const line = (kind: "spent" | "change", amountKobo: number) => ({
      advanceId: advance!.id,
      kind,
      category: kind === "spent" ? ("office" as const) : null,
      description: "Oil",
      amountKobo,
      spentOn: "2047-10-03",
      createdBy: manager.actor.userId,
      createdAt: wat("2047-10-03"),
    });
    await db.insert(expenseLines).values([line("spent", 700_000), line("change", 50_000)]);
    const [wrong] = await db.insert(expenseLines).values(line("spent", 200_000)).returning({ id: expenseLines.id });
    await db.insert(expenseLineVoids).values({ lineId: wrong!.id, voidedBy: manager.actor.userId, reason: "Typo", voidedAt: wat("2047-10-03") });

    const deposit = (amountKobo: number) => ({
      clientId: randomUUID(),
      operatorId: op.id,
      amountKobo,
      method: "cash" as const,
      receiptNumber: `TEST-DEP-${nextSerial()}`,
      receivedBy: manager.actor.userId,
      receivedAt: wat("2047-10-02"),
      businessDate: "2047-10-02",
    });
    await db.insert(operatorDeposits).values(deposit(1_500_000));
    await db.transaction(async (tx) => {
      const [gone] = await tx.insert(operatorDeposits).values(deposit(400_000)).returning({ id: operatorDeposits.id });
      await tx.insert(operatorDepositReversals).values({
        depositId: gone!.id,
        reversedBy: manager.actor.userId,
        reason: "Typo",
        reversedAt: wat("2047-10-02"),
      });
    });
  });

  it("adds weeks up to months and months up to the year, to the kobo", async () => {
    const report = await buildAnnualBalance(db, YEAR, "2047-12-31");
    for (const month of report.months) {
      for (const key of KEYS) expect(add(month.weeks.map((w) => w.figures), key), `${month.month} ${key}`).toBe(month.figures[key]);
    }
    for (const key of KEYS) expect(add(report.months.map((m) => m.figures), key), key).toBe(report.total[key]);
  });

  it("counts each figure once, leaving out voids and reversals", async () => {
    const { total, months } = await buildAnnualBalance(db, YEAR, "2047-12-31");
    expect(total).toMatchObject({
      dueKobo: 3_000_000,
      paidKobo: 2_500_000,
      owedKobo: 500_000,
      receivedKobo: 3_300_000,
      cashKobo: 3_300_000,
      forBalancesKobo: 2_500_000,
      forLoansKobo: 800_000,
      creditKobo: 0,
      expensesKobo: 700_000,
      loansGivenKobo: 2_000_000,
      netKobo: 600_000,
      depositsKobo: 1_500_000,
    });
    expect(months[8]!.figures).toMatchObject({ dueKobo: 2_000_000, paidKobo: 2_000_000, netKobo: -2_000_000 });
    expect(months[9]!.figures).toMatchObject({ dueKobo: 1_000_000, receivedKobo: 3_300_000, netKobo: 2_600_000 });
  });

  it("puts each part of a split week in its own month", async () => {
    const { months } = await buildAnnualBalance(db, YEAR, "2047-12-31");
    const lastOfSeptember = months[8]!.weeks.at(-1)!;
    const firstOfOctober = months[9]!.weeks[0]!;
    expect(lastOfSeptember.range).toEqual({ from: "2047-09-30", to: "2047-09-30" });
    expect(lastOfSeptember.figures).toMatchObject({ dueKobo: 1_000_000, loansGivenKobo: 2_000_000 });
    expect(firstOfOctober.range).toEqual({ from: "2047-10-01", to: "2047-10-06" });
    expect(firstOfOctober.figures).toMatchObject({ dueKobo: 1_000_000, paidKobo: 500_000, expensesKobo: 700_000 });
  });

  it("agrees with the figures every other screen uses", async () => {
    const range = { from: "2047-01-01", to: "2047-12-31" };
    const [{ total }, balances, received] = await Promise.all([
      buildAnnualBalance(db, YEAR, "2047-12-31"),
      balanceTotals(db, range),
      moneyReceived(db, range),
    ]);
    expect(total).toMatchObject({ dueKobo: balances.dueKobo, paidKobo: balances.paidKobo, receivedKobo: received.totalKobo });
    expect(total.forLoansKobo).toBe(received.forLoansKobo);
  });

  it("runs the current year only to today and leaves later months empty", async () => {
    const report = await buildAnnualBalance(db, YEAR, "2047-10-01");
    expect(report.upTo).toBe("2047-10-01");
    expect(report.months[9]!.weeks).toEqual([{ range: { from: "2047-10-01", to: "2047-10-01" }, figures: expect.any(Object) }]);
    expect(report.months.slice(10).every((m) => m.future && m.weeks.length === 0)).toBe(true);
    expect(report.total.expensesKobo).toBe(0);
  });

  it("gives the CSV the same totals as the page", async () => {
    const report = await buildAnnualBalance(db, YEAR, "2047-12-31");
    const rows = annualRows(report);
    const last = rows.at(-1)!;
    expect(last).toMatchObject({ line: "2047 total", due: report.total.dueKobo, net: report.total.netKobo });
    const weeks = rows.filter((row) => String(row.line).startsWith("Week"));
    expect(weeks.reduce((sum, row) => sum + Number(row.received), 0)).toBe(report.total.receivedKobo);
    expect(rows.filter((row) => String(row.line).endsWith("subtotal"))).toHaveLength(12);
  });

  it("is for the Owner, Manager and Assistant Manager only", async () => {
    const supervisor = (await makeUser("supervisor")).ctx;
    await expect(annualBalance(supervisor, YEAR)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(annualBalance(owner, 2026)).resolves.toBeTruthy();
  });
});

describe("cash close rhythm", () => {
  it("expects the Assistant Manager daily and the Manager weekly, with Monday as grace", () => {
    expect(closeDueBy("day", "2026-11-10")).toBe("2026-11-09");
    // Monday 9 Nov: last week (2 to 8 Nov) may still be closed today.
    expect(closeDueBy("week", "2026-11-09")).toBe("2026-11-01");
    // Tuesday 10 Nov: last week must be closed.
    expect(closeDueBy("week", "2026-11-10")).toBe("2026-11-08");
    expect(coverageLabel("2026-11-03", "2026-11-09", "week")).toBe("Week close, 3 Nov 2026 to 9 Nov 2026");
    expect(coverageLabel("2026-11-09", "2026-11-09", "day")).toBe("Day close, 9 Nov 2026");
  });

  const collect = async (ctx: Ctx, amount: string) => {
    const operator = await makeOperator(manager);
    return recordPayment(ctx, { operatorId: operator.id, amount, method: "cash", clientId: randomUUID() });
  };
  const alertFor = async (name: string, today: string) =>
    (await cashAlerts(db, today)).cashNotClosed.find((row) => row.name === name);

  it("alerts a Manager who missed last week from Tuesday, not Monday", async () => {
    const boss = (await makeUser("manager")).ctx;
    await collect(on(boss, "2036-03-05"), "10,000"); // Wednesday
    expect(await alertFor(boss.actor.name, "2036-03-07")).toBeUndefined();
    expect(await alertFor(boss.actor.name, "2036-03-10")).toBeUndefined(); // Monday
    expect(await alertFor(boss.actor.name, "2036-03-11")).toMatchObject({
      rhythm: "week",
      week: { from: "2036-03-03", to: "2036-03-09" },
    });
  });

  it("covers the whole week in a Sunday close, which the Owner can check", async () => {
    const boss = (await makeUser("manager")).ctx;
    const id = boss.actor.userId;
    await collect(on(boss, "2036-03-04"), "10,000"); // Tuesday
    await collect(on(boss, "2036-03-09"), "5,000"); // Sunday
    const [person] = (await cashDay(on(boss, "2036-03-09"), "2036-03-09")).filter((row) => row.id === id);
    expect(person).toMatchObject({ rhythm: "week", expectedKobo: 1_500_000, covers: { from: "2036-03-04" } });
    expect(person!.covers.days.map((day) => day.date)).toEqual(["2036-03-04", "2036-03-09"]);

    await closeCash(on(boss, "2036-03-09", "20:00"), { custodianId: id, businessDate: "2036-03-09", counted: "15,000" });
    expect(await alertFor(boss.actor.name, "2036-03-11")).toBeUndefined();
    const waiting = (await uncheckedCloses(owner)).find((row) => row.name === boss.actor.name);
    expect(waiting?.label).toBe("Week close, 4 Mar 2036 to 9 Mar 2036");

    const closeId = (await cashDay(boss, "2036-03-09")).find((row) => row.id === id)!.close!.id;
    await expect(checkCashClose(boss, closeId, { recounted: "15,000" })).rejects.toThrow(/different person/);
    await checkCashClose(owner, closeId, { recounted: "15,000" });
  });

  it("alerts an Assistant Manager the morning after a day not closed", async () => {
    const assistant = (await makeUser("assistant_manager")).ctx;
    await collect(on(assistant, "2036-03-09"), "2,000");
    expect(await alertFor(assistant.actor.name, "2036-03-09")).toBeUndefined();
    expect(await alertFor(assistant.actor.name, "2036-03-10")).toMatchObject({ rhythm: "day", since: "2036-03-09", week: null });
  });
});
