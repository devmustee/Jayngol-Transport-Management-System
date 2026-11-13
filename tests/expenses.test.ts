import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { expenseLines, jobRuns, loans, violations } from "@/db/schema";
import { addDays } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import { issueTricycle } from "@/services/assignments";
import { cashBook, expectedCash } from "@/services/cash-book";
import type { Ctx } from "@/services/context";
import { runDailyJob } from "@/services/daily-job";
import {
  addExpenseLine,
  cancelAdvance,
  correctExpense,
  countersignAdvance,
  createAdvance,
  getAdvance,
  listAdvances,
  recordExpense,
  removeExpense,
  sendBackAdvance,
  submitAdvance,
  voidExpenseLine,
} from "@/services/expenses";
import { financeOverview, getStatement } from "@/services/finance";
import { cancelLoan, getLoan, grantLoan, listLoans } from "@/services/loans";
import { recordPayment, reversePayment } from "@/services/payments";
import { defaultFrom, runReport } from "@/services/reports";
import { makeOperator, makeTricycle, makeUser, nextReference } from "./helpers";

const wat = (date: string, time = "12:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: () => wat(date, time) });

let manager: Ctx;
let assistant: Ctx;
let owner: Ctx;
let supervisor: Ctx;

beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  assistant = (await makeUser("assistant_manager")).ctx;
  owner = (await makeUser("owner")).ctx;
  supervisor = (await makeUser("supervisor")).ctx;
});

const DAY = "2027-02-10";
const pay = (ctx: Ctx, operatorId: string, amount: string, extra: Record<string, unknown> = {}) =>
  recordPayment(ctx, { operatorId, amount, method: "transfer", reference: nextReference(), clientId: randomUUID(), ...extra });
/** Puts cash in the Manager's hands on the day. */
async function cashIn(ctx: Ctx, amount: string) {
  const operator = await makeOperator(manager);
  await pay(ctx, operator.id, amount, { method: "cash" });
}
const bankAdvance = (amount = "10,000") =>
  createAdvance(on(manager, DAY), { purpose: "Workshop costs", amount, source: "bank" }).then((a) => a!);
const spend = (id: string, amount: string, ctx = on(manager, DAY)) =>
  addExpenseLine(ctx, id, { kind: "spent", category: "workshop_labour", description: "Mechanic", amount, spentOn: DAY });
const change = (id: string, amount: string, ctx = on(manager, DAY)) =>
  addExpenseLine(ctx, id, { kind: "change", amount });

describe("expense funds", () => {
  it("lets only the Manager and Assistant Manager record them", async () => {
    await expect(createAdvance(supervisor, { purpose: "x", amount: "1", source: "bank" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAdvance(owner, { purpose: "x", amount: "1", source: "bank" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps them from Supervisors and open to the owner", async () => {
    await expect(listAdvances(supervisor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAdvances(owner)).resolves.toBeDefined();
  });

  it("takes cash out of the person's day, and only what they hold", async () => {
    const date = "2027-02-11";
    const ctx = on(manager, date);
    await cashIn(ctx, "20,000");
    const before = await expectedCash(db, manager.actor.userId, date);
    await expect(createAdvance(ctx, { purpose: "x", amount: String(before / 100 + 1), source: manager.actor.userId })).rejects.toThrow();
    await createAdvance(ctx, { purpose: "Fuel", amount: "15,000", source: manager.actor.userId });
    expect(await expectedCash(db, manager.actor.userId, date)).toBe(before - 1_500_000);
  });

  it("does not touch anyone's cash when it comes from the bank", async () => {
    const before = await expectedCash(db, manager.actor.userId, DAY);
    await bankAdvance();
    expect(await expectedCash(db, manager.actor.userId, DAY)).toBe(before);
  });

  it("refuses more than the advance, and a countersign request until it adds up", async () => {
    const { id } = await bankAdvance();
    await spend(id, "6,000");
    await expect(spend(id, "4,001")).rejects.toThrow();
    await expect(submitAdvance(on(manager, DAY), id)).rejects.toThrow(/₦4,000 is still/);
    await change(id, "4,000");
    await submitAdvance(on(manager, DAY), id);
    expect((await getAdvance(manager, id))!.advance.status).toBe("countersigned");
  });

  it("shows an unaccounted advance as outstanding until it is dealt with", async () => {
    const { id } = await bankAdvance("7,000");
    await spend(id, "2,000");
    const row = (await listAdvances(manager)).open.find((a) => a.id === id)!;
    expect(row.amountKobo - row.accountedKobo).toBe(500_000);
  });

  it("puts returned change back with the person it came from", async () => {
    const date = "2027-02-12";
    const ctx = on(manager, date);
    await cashIn(ctx, "10,000");
    const { id } = (await createAdvance(ctx, { purpose: "Parts", amount: "8,000", source: manager.actor.userId }))!;
    const after = await expectedCash(db, manager.actor.userId, date);
    await change(id, "3,000", ctx);
    expect(await expectedCash(db, manager.actor.userId, date)).toBe(after + 300_000);
  });

  it("is final once the Manager submits their own, with no approver", async () => {
    const { id } = await bankAdvance();
    await spend(id, "10,000");
    await submitAdvance(on(manager, DAY), id);
    const data = (await getAdvance(manager, id))!;
    expect(data.advance).toMatchObject({ status: "countersigned", countersignedBy: null });
    expect(data.noApprovalNeeded).toBe(true);
    await expect(spend(id, "1")).rejects.toThrow(/no longer/);
  });

  it("needs the Manager's approval when the Assistant Manager submits", async () => {
    const { id } = (await createAdvance(on(assistant, DAY), { purpose: "Tyres", amount: "10,000", source: "bank" }))!;
    await spend(id, "10,000", on(assistant, DAY));
    await expect(countersignAdvance(manager, id)).rejects.toThrow(/not waiting/);
    await submitAdvance(on(assistant, DAY), id);
    await expect(countersignAdvance(assistant, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(countersignAdvance(owner, id)).rejects.toBeInstanceOf(ForbiddenError);
    await countersignAdvance(manager, id);
    expect((await getAdvance(manager, id))!.advance).toMatchObject({ status: "countersigned", countersignedBy: manager.actor.userId });
  });

  it("can be sent back with a reason and corrected", async () => {
    const { id } = (await createAdvance(on(assistant, DAY), { purpose: "Tyres", amount: "10,000", source: "bank" }))!;
    const line = (await spend(id, "10,000", on(assistant, DAY)))!;
    await submitAdvance(on(assistant, DAY), id);
    await sendBackAdvance(manager, id, { reason: "No receipt" });
    expect((await getAdvance(manager, id))!.advance).toMatchObject({ status: "open", returnNote: "No receipt" });
    await voidExpenseLine(on(assistant, DAY), line.id, { reason: "Wrong amount" });
    const data = (await getAdvance(manager, id))!;
    expect(data.leftKobo).toBe(1_000_000);
    expect(data.lines).toHaveLength(1);
  });

  it("reverses the cash when a change entry is removed", async () => {
    const date = "2027-02-13";
    const ctx = on(manager, date);
    await cashIn(ctx, "10,000");
    const { id } = (await createAdvance(ctx, { purpose: "Parts", amount: "5,000", source: manager.actor.userId }))!;
    const before = await expectedCash(db, manager.actor.userId, date);
    const line = (await change(id, "2,000", ctx))!;
    await voidExpenseLine(ctx, line.id, { reason: "Entered twice" });
    expect(await expectedCash(db, manager.actor.userId, date)).toBe(before);
  });

  it("can be cancelled only with nothing recorded, and puts the money back", async () => {
    const date = "2027-02-14";
    const ctx = on(manager, date);
    await cashIn(ctx, "10,000");
    const before = await expectedCash(db, manager.actor.userId, date);
    const { id } = (await createAdvance(ctx, { purpose: "Mistake", amount: "5,000", source: manager.actor.userId }))!;
    const line = (await spend(id, "1,000", ctx))!;
    await expect(cancelAdvance(ctx, id, { reason: "x" })).rejects.toThrow(/Remove the entries/);
    await voidExpenseLine(ctx, line.id, { reason: "x" });
    await cancelAdvance(ctx, id, { reason: "Entered by mistake" });
    expect(await expectedCash(db, manager.actor.userId, date)).toBe(before);
  });

  it("does not let the database change an entry", async () => {
    const { id } = await bankAdvance();
    await spend(id, "1,000");
    await expect(db.update(expenseLines).set({ amountKobo: 1 }).where(eq(expenseLines.advanceId, id))).rejects.toThrow();
    await expect(db.delete(expenseLines).where(eq(expenseLines.advanceId, id))).rejects.toThrow();
  });

  it("does not let the database accept a countersign by the person who collected", async () => {
    const { id } = await bankAdvance();
    await expect(
      db.execute(sql`UPDATE expense_advances SET countersigned_by = collected_by WHERE id = ${id}`),
    ).rejects.toThrow();
  });
});

describe("loans", () => {
  const give = async (amount = "50,000", ctx = on(manager, DAY)) => {
    const operator = await makeOperator(manager);
    const loan = (await grantLoan(ctx, { operatorId: operator.id, amount, source: "bank" }))!;
    return { operatorId: operator.id, loanId: loan.id };
  };
  const status = async (id: string) => (await db.select().from(loans).where(eq(loans.id, id)))[0]!.status;

  it("lets only the Manager approve one", async () => {
    const operator = await makeOperator(manager);
    const input = { operatorId: operator.id, amount: "1,000", source: "bank" };
    await expect(grantLoan(assistant, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(grantLoan(supervisor, input)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("charges exactly what was given, with no interest", async () => {
    const { operatorId } = await give("50,000");
    expect((await getStatement(manager, operatorId)).loanOwedKobo).toBe(5_000_000);
  });

  it("allows one active loan per operator", async () => {
    const { operatorId } = await give();
    await expect(grantLoan(on(manager, DAY), { operatorId, amount: "1,000", source: "bank" })).rejects.toMatchObject({
      fieldErrors: { operatorId: expect.stringMatching(/already has a loan/) },
    });
  });

  it("gets money only when the cashier selects it", async () => {
    const { operatorId, loanId } = await give("5,000");
    await pay(on(assistant, DAY), operatorId, "2,000");
    expect((await getLoan(manager, loanId))!.owedKobo).toBe(500_000);
    await pay(on(assistant, DAY), operatorId, "1,500", { loanAmount: "1,500" });
    expect((await getLoan(manager, loanId))!.owedKobo).toBe(350_000);
  });

  it("clears after any number of part payments, and a new loan can follow", async () => {
    const { operatorId, loanId } = await give("3,000");
    await pay(on(assistant, DAY), operatorId, "1,000", { loanAmount: "1,000" });
    expect(await status(loanId)).toBe("active");
    await pay(on(assistant, "2027-02-20"), operatorId, "2,000", { loanAmount: "2,000" });
    expect(await status(loanId)).toBe("cleared");
    await expect(grantLoan(on(manager, "2027-02-21"), { operatorId, amount: "1,000", source: "bank" })).resolves.toBeDefined();
  });

  it("refuses more than is owed, or more than was received", async () => {
    const { operatorId } = await give("1,000");
    await expect(pay(assistant, operatorId, "2,000", { loanAmount: "2,000" })).rejects.toMatchObject({
      fieldErrors: { loanAmount: expect.stringMatching(/only ₦1,000/) },
    });
    await expect(pay(assistant, operatorId, "500", { loanAmount: "600" })).rejects.toMatchObject({
      fieldErrors: { loanAmount: expect.stringMatching(/more than the amount/) },
    });
  });

  it("becomes active again when the clearing payment is reversed", async () => {
    const { operatorId, loanId } = await give("1,000");
    const payment = (await pay(on(assistant, DAY), operatorId, "1,000", { loanAmount: "1,000" }))!;
    expect(await status(loanId)).toBe("cleared");
    await reversePayment(on(manager, DAY), payment.id, { reason: "Bounced" });
    expect(await status(loanId)).toBe("active");
    expect((await getLoan(manager, loanId))!.owedKobo).toBe(100_000);
  });

  it("refuses a reversal that would leave two active loans", async () => {
    const { operatorId } = await give("1,000");
    const payment = (await pay(on(assistant, DAY), operatorId, "1,000", { loanAmount: "1,000" }))!;
    await grantLoan(on(manager, DAY), { operatorId, amount: "2,000", source: "bank" });
    await expect(reversePayment(on(manager, DAY), payment.id, { reason: "x" })).rejects.toThrow(/new one/);
  });

  it("has no schedule: it raises no fines and no unpaid days", async () => {
    const t = await makeTricycle(manager);
    const o = await makeOperator(manager);
    await issueTricycle(on(manager, "2027-01-01"), { tricycleId: t.id, operatorId: o.id, issuedOn: "2027-01-01" });
    await grantLoan(on(manager, "2027-01-01"), { operatorId: o.id, amount: "20,000", source: "bank" });
    await db.delete(jobRuns);
    await db.insert(jobRuns).values({ job: "daily", businessDate: "2027-01-01", finishedAt: wat("2027-01-01") });
    for (let date = "2027-01-02"; date <= "2027-01-04"; date = addDays(date, 1)) {
      await pay(on(assistant, date, "10:00"), o.id, "10,000");
      await runDailyJob(() => wat(date, "23:00"));
    }
    await runDailyJob(() => wat("2027-01-05", "00:05"));
    await pay(on(assistant, "2027-01-05", "10:00"), o.id, "10,000");
    await runDailyJob(() => wat("2027-01-06", "00:05"));
    const fines = await db.select().from(violations).where(eq(violations.operatorId, o.id));
    expect(fines.filter((v) => v.ruleCode === "R1")).toHaveLength(0);
    expect((await getStatement(manager, o.id)).unpaidDays).toBeLessThanOrEqual(1);
  });

  it("can be cancelled only before anything is repaid", async () => {
    const { operatorId, loanId } = await give("1,000");
    await cancelLoan(on(manager, DAY), loanId, { reason: "Entered twice" });
    expect(await status(loanId)).toBe("cancelled");
    expect((await getStatement(manager, operatorId)).loanOwedKobo).toBe(0);

    const second = await give("1,000");
    await pay(on(assistant, DAY), second.operatorId, "100", { loanAmount: "100" });
    await expect(cancelLoan(on(manager, DAY), second.loanId, { reason: "x" })).rejects.toThrow(/repaid/);
  });

  it("adds up what operators still owe", async () => {
    const { loanId } = await give("4,000");
    const data = await listLoans(manager);
    expect(data.active.find((row) => row.id === loanId)).toMatchObject({ principalKobo: 400_000, repaidKobo: 0 });
    expect(data.outstandingKobo).toBeGreaterThanOrEqual(400_000);
  });
});

describe("the cash book, for a test month", () => {
  it("agrees with all payments, expenses and loans", async () => {
    const first = "2027-03-01";
    const last = "2027-03-31";
    const at = (ctx: Ctx, day: string, time = "12:00") => on(ctx, `2027-03-${day}`, time);
    const a = await makeOperator(manager);
    const b = await makeOperator(manager);

    // In: ₦30,000 cash, ₦20,000 transfer, ₦5,000 POS.
    await pay(at(manager, "02"), a.id, "30,000", { method: "cash" });
    await pay(at(assistant, "03"), b.id, "20,000", { method: "transfer", reference: nextReference() });
    await pay(at(assistant, "04"), b.id, "5,000", { method: "pos", reference: nextReference() });
    // A cash payment and a transfer later reversed: both directions must show.
    const wrongCash = (await pay(at(manager, "05"), a.id, "2,000", { method: "cash" }))!;
    const wrongBank = (await pay(at(assistant, "05"), b.id, "3,000", { method: "transfer", reference: nextReference() }))!;
    await reversePayment(at(manager, "06"), wrongCash.id, { reason: "Duplicate" });
    await reversePayment(at(manager, "06"), wrongBank.id, { reason: "Duplicate" });

    // Out: ₦10,000 cash advance with ₦1,000 change; ₦40,000 bank advance fully spent.
    await pay(at(manager, "10"), a.id, "12,000", { method: "cash" });
    const cashAdvance = (await createAdvance(at(manager, "10"), { purpose: "Parts", amount: "10,000", source: manager.actor.userId }))!;
    await addExpenseLine(at(manager, "11"), cashAdvance.id, { kind: "spent", category: "other", description: "Parts", amount: "9,000", spentOn: "2027-03-11" });
    await addExpenseLine(at(manager, "11"), cashAdvance.id, { kind: "change", amount: "1,000" });
    const bank = (await createAdvance(at(manager, "12"), { purpose: "Stock", amount: "40,000", source: "bank" }))!;
    await addExpenseLine(at(manager, "12"), bank.id, { kind: "spent", category: "store_purchase", description: "Oil", amount: "40,000", spentOn: "2027-03-12" });
    // A cancelled advance leaves both sides in the book and nets to nothing.
    const mistake = (await createAdvance(at(manager, "13"), { purpose: "Mistake", amount: "6,000", source: "bank" }))!;
    await cancelAdvance(at(manager, "13"), mistake.id, { reason: "Wrong" });

    // Loan: ₦15,000 from the bank, ₦4,000 repaid by transfer as part of a payment.
    await grantLoan(at(manager, "15"), { operatorId: b.id, amount: "15,000", source: "bank" });
    await pay(at(assistant, "16"), b.id, "4,000", { method: "transfer", reference: nextReference(), loanAmount: "4,000" });

    const book = await cashBook(manager, { from: first, to: last });
    expect(book.cash).toEqual({
      moneyIn: 3_000_000 + 200_000 + 1_200_000 + 100_000,
      moneyOut: 200_000 + 1_000_000,
      net: 3_300_000,
    });
    expect(book.bank).toEqual({
      moneyIn: 2_000_000 + 500_000 + 300_000 + 400_000 + 600_000,
      moneyOut: 300_000 + 4_000_000 + 600_000 + 1_500_000,
      net: 3_800_000 - 6_400_000,
    });
    expect(book.rows).toHaveLength(15);
    expect(book.rows.every((row) => row.operator || row.purpose)).toBe(true);
    await expect(cashBook(supervisor, { from: first, to: last })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("money given out on the Money card", () => {
  const day = "2033-04-05";
  const loanFor = async (ctx: Ctx, amount: string, source: string) => {
    const operator = await makeOperator(manager);
    return grantLoan(ctx, { operatorId: operator.id, amount, source });
  };

  it("deducts what came from collected cash, and adds back change and cancellations", async () => {
    const ctx = on(manager, day);
    const payer = await makeOperator(manager);
    await pay(ctx, payer.id, "100,000", { method: "cash" });

    await loanFor(ctx, "25,000", manager.actor.userId);
    const cancelled = await loanFor(ctx, "4,000", manager.actor.userId);
    await cancelLoan(ctx, cancelled!.id, { reason: "Entered in error" });
    const advance = await createAdvance(ctx, { purpose: "Workshop", amount: "10,000", source: manager.actor.userId });
    await change(advance!.id, "2,000", ctx);

    // Money from the bank or owner never came off the card.
    await loanFor(ctx, "7,000", "bank");
    const fromBank = await createAdvance(ctx, { purpose: "Tyres", amount: "6,000", source: "bank" });
    await change(fromBank!.id, "1,000", ctx);

    const money = await financeOverview(ctx);
    expect(money.collectedKobo).toBe(10_000_000);
    expect(money.loansKobo).toBe(2_500_000);
    expect(money.expensesKobo).toBe(800_000);
  });

  it("does not deduct another day's money", async () => {
    const money = await financeOverview(on(manager, addDays(day, 1)));
    expect(money).toMatchObject({ loansKobo: 0, expensesKobo: 0 });
  });
});


describe("the expense report by day, week, month and year", () => {
  // A year no other test uses, so the totals are this test's alone.
  const D1 = "2039-02-07";
  const D2 = "2039-02-09";
  const feb = { from: "2039-02-01", to: "2039-02-28" };

  async function spendFebruary() {
    const advance = (await createAdvance(on(manager, D1), { purpose: "Parts and fuel", amount: "30,000", source: "bank" }))!;
    await addExpenseLine(on(manager, D1), advance.id, { kind: "spent", category: "store_purchase", description: "Oil", amount: "10,000", spentOn: D1 });
    await addExpenseLine(on(manager, D2), advance.id, { kind: "spent", category: "transport", description: "Fuel", amount: "5,000", spentOn: D2 });
    const wrong = (await addExpenseLine(on(manager, D2), advance.id, { kind: "spent", category: "office", description: "Typo", amount: "1,000", spentOn: D2 }))!;
    await voidExpenseLine(on(manager, D2), wrong.id, { reason: "Entered twice" });
    await addExpenseLine(on(manager, D2), advance.id, { kind: "change", amount: "2,000" });
  }
  beforeAll(spendFebruary);

  it("shows each day with money, split by category, leaving out voided lines", async () => {
    const report = await runReport(manager, "expenses", feb, "day");
    expect(report.title).toBe("Daily expenses");
    expect(report.rows.map((row) => row.day)).toEqual([D2, D1]);
    expect(report.rows[1]).toMatchObject({ collected: 3_000_000, spent: 1_000_000, store_purchase: 1_000_000, transport: 0, change: 0 });
    expect(report.rows[0]).toMatchObject({ collected: 0, spent: 500_000, transport: 500_000, office: 0, change: 200_000 });
    expect(report.totals).toMatchObject({ collected: 3_000_000, spent: 1_500_000, change: 200_000 });
  });

  it("adds up by week, month and year", async () => {
    const weeks = await runReport(manager, "expenses", feb, "week");
    expect(weeks.rows.length).toBeGreaterThanOrEqual(4);
    expect(weeks.rows.find((row) => row.day === "2039-02-07")).toMatchObject({ to: "2039-02-13", spent: 1_500_000 });
    const months = await runReport(manager, "expenses", { from: "2039-01-01", to: "2039-03-31" }, "month");
    expect(months.title).toBe("Monthly expenses");
    expect(months.rows.map((row) => [row.day, row.spent])).toEqual([
      ["2039-03-01", 0],
      ["2039-02-01", 1_500_000],
      ["2039-01-01", 0],
    ]);
    const years = await runReport(manager, "expenses", { from: "2039-01-01", to: "2039-12-31" }, "year");
    expect(years.rows).toEqual([expect.objectContaining({ day: "2039-01-01", to: "2039-12-31", spent: 1_500_000, collected: 3_000_000 })]);
  });

  it("starts each grouping from a useful date", () => {
    expect(defaultFrom("2026-11-13", "day")).toBe("2026-11-01");
    expect(defaultFrom("2026-11-13", "week")).toBe("2026-09-01");
    expect(defaultFrom("2026-02-13", "week")).toBe("2025-12-01");
    expect(defaultFrom("2026-11-13", "month")).toBe("2026-01-01");
    expect(defaultFrom("2026-11-13", "year")).toBe("2022-01-01");
  });

  it("is not for the Supervisor", async () => {
    const supervisor = (await makeUser("supervisor")).ctx;
    await expect(runReport(supervisor, "expenses", feb, "day")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("expenses recorded in one step", () => {
  const SPENT = "2039-05-14";
  const by = (who: Ctx, date = SPENT, time?: string) => on(who, date, time);
  const expense = (amount = "4,800", extra: Record<string, unknown> = {}, ctx = by(assistant)) =>
    recordExpense(ctx, {
      description: "Engine oil",
      category: "store_purchase",
      amount,
      spentOn: SPENT,
      ...extra,
    }).then((e) => e!);
  const bankOut = async (id: string) => {
    const rows = (await db.execute(sql`
      SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS total FROM bank_movements WHERE source_id = ${id}
    `)) as unknown as { total: number }[];
    return rows[0]!.total;
  };
  const fix = (amount: string, extra: Record<string, unknown> = {}) => ({
    description: "Engine oil",
    category: "store_purchase",
    amount,
    spentOn: SPENT,
    ...extra,
  });

  it("from the Assistant Manager: off the balance once, waiting for the Manager", async () => {
    const { id } = await expense();
    const data = (await getAdvance(manager, id))!;
    expect(data.advance.status).toBe("submitted");
    expect(data.single).toBe(true);
    expect(data.noApprovalNeeded).toBe(false);
    expect(data.spentKobo).toBe(480_000);
    expect(await bankOut(id)).toBe(-480_000);
    await expect(countersignAdvance(assistant, id)).rejects.toBeInstanceOf(ForbiddenError);
    await countersignAdvance(manager, id);
    expect((await getAdvance(manager, id))!.advance.countersignedBy).toBe(manager.actor.userId);
  });

  it("from the Manager: approved and final on saving, with no approver", async () => {
    const { id } = await expense("2,000", {}, by(manager));
    const data = (await getAdvance(manager, id))!;
    expect(data.advance).toMatchObject({ status: "countersigned", countersignedBy: null });
    expect(data.noApprovalNeeded).toBe(true);
    await expect(countersignAdvance(manager, id)).rejects.toThrow(/not waiting/);
    expect(await bankOut(id)).toBe(-200_000);
  });

  it("comes off the company balance, never out of anyone's cash in hand", async () => {
    const date = "2039-05-15";
    const day = by(manager, date);
    await cashIn(day, "5,000");
    const before = await expectedCash(db, manager.actor.userId, date);
    const { id } = (await recordExpense(day, {
      description: "Fuel",
      category: "transport",
      spentOn: date,
      amount: "2,000",
      source: manager.actor.userId,
    }))!;
    expect(await expectedCash(db, manager.actor.userId, date)).toBe(before);
    expect(await bankOut(id)).toBe(-200_000);
    expect((await getAdvance(manager, id))!.advance).toMatchObject({ custodianId: null, account: "bank" });
  });

  it("refuses a future date, and anyone but the Manager or Assistant Manager", async () => {
    await expect(expense("100", { spentOn: addDays(SPENT, 1) })).rejects.toMatchObject({
      fieldErrors: { spentOn: expect.stringContaining("future") },
    });
    for (const who of [supervisor, owner]) {
      await expect(recordExpense(by(who), fix("1"))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("lets the Manager correct their own only on the day it was saved", async () => {
    const { id } = await expense("3,000", {}, by(manager, SPENT, "09:00"));
    await correctExpense(by(manager, SPENT, "18:00"), id, fix("2,500", { category: "office" }));
    const data = (await getAdvance(manager, id))!;
    expect(data.advance).toMatchObject({ status: "countersigned", countersignedBy: null, amountKobo: 250_000 });
    expect(await bankOut(id)).toBe(-250_000);
    const tomorrow = by(manager, addDays(SPENT, 1));
    await expect(correctExpense(tomorrow, id, fix("2,000"))).rejects.toThrow(/approved and final/);
    await expect(removeExpense(tomorrow, id, { reason: "x" })).rejects.toThrow(/approved and final/);
    expect((await getAdvance(tomorrow, id))!.correctable).toBeNull();
  });

  it("lets the Manager remove their own on the same day, putting the money back", async () => {
    const { id } = await expense("1,200", {}, by(manager));
    await removeExpense(by(manager), id, { reason: "Entered twice" });
    expect((await getAdvance(manager, id))!.advance.status).toBe("cancelled");
    expect(await bankOut(id)).toBe(0);
  });

  it("is final once the Manager approves: no correction, removal or old-style change", async () => {
    const { id } = await expense();
    await countersignAdvance(manager, id);
    await expect(correctExpense(by(assistant), id, fix("1,000"))).rejects.toThrow(/approved and final/);
    await expect(removeExpense(by(assistant), id, { reason: "x" })).rejects.toThrow(/approved and final/);
    await expect(correctExpense(by(manager), id, fix("1,000"))).rejects.toThrow(/approved and final/);
    await expect(cancelAdvance(by(assistant), id, { reason: "x" })).rejects.toThrow();
    await expect(change(id, "100", by(assistant))).rejects.toThrow();
    expect(await bankOut(id)).toBe(-480_000);
  });

  it("is corrected only by the Assistant Manager who recorded it, after it is sent back", async () => {
    const { id } = await expense();
    await expect(correctExpense(by(assistant), id, fix("4,000"))).rejects.toThrow(/sent back/);
    await sendBackAdvance(manager, id, { reason: "The receipt says ₦4,000" });
    await expect(correctExpense(by(manager), id, fix("4,000"))).rejects.toThrow(/person who recorded/);
    await correctExpense(by(assistant), id, fix("4,000", { description: "Engine oil, 4 litres" }));
    const data = (await getAdvance(manager, id))!;
    expect(data.advance).toMatchObject({ status: "submitted", amountKobo: 400_000, returnNote: null });
    expect(data.spentKobo).toBe(400_000);
    expect(await bankOut(id)).toBe(-400_000);
  });

  it("moves only the difference when corrected upwards, and changes the date", async () => {
    const { id } = await expense("1,000");
    await sendBackAdvance(manager, id, { reason: "Wrong amount" });
    const earlier = addDays(SPENT, -2);
    await correctExpense(by(assistant), id, fix("1,500", { category: "office", spentOn: earlier }));
    const data = (await getAdvance(manager, id))!;
    expect(await bankOut(id)).toBe(-150_000);
    expect(data.advance.collectedOn).toBe(earlier);
    const line = data.lines.find((row) => row.voidReason === null)!.line;
    expect(line).toMatchObject({ category: "office", spentOn: earlier });
  });

  it("can be removed while sent back, putting the money back", async () => {
    const { id } = await expense("2,500");
    await expect(removeExpense(by(assistant), id, { reason: "Entered twice" })).rejects.toThrow(/sent back/);
    await sendBackAdvance(manager, id, { reason: "Entered twice" });
    await removeExpense(by(assistant), id, { reason: "Entered twice" });
    const data = (await getAdvance(manager, id))!;
    expect(data.advance.status).toBe("cancelled");
    expect(data.spentKobo).toBe(0);
    expect(await bankOut(id)).toBe(0);
    await expect(removeExpense(by(assistant), id, { reason: "again" })).rejects.toThrow();
  });

  it("tells the owner about a Manager expense over ₦50,000, and only then", async () => {
    const notices = async (id: string) => {
      const rows = (await db.execute(sql`
        SELECT r.user_id FROM notifications n JOIN notification_recipients r ON r.notification_id = n.id
        WHERE n.kind = 'large_expense' AND n.entity_id = ${id}
      `)) as unknown as { user_id: string }[];
      return rows.map((row) => row.user_id);
    };
    const big = await expense("50,001", {}, by(manager));
    expect(await notices(big.id)).toContain(owner.actor.userId);
    expect(await notices(big.id)).not.toContain(manager.actor.userId);
    const exact = await expense("50,000", {}, by(manager));
    expect(await notices(exact.id)).toEqual([]);
    const assistants = await expense("80,000");
    expect(await notices(assistants.id)).toEqual([]);
  });

  it("counts in the expense report on the day it was spent", async () => {
    const day = "2039-05-09";
    await expense("3,000", { spentOn: day, category: "office" });
    const report = await runReport(manager, "expenses", { from: day, to: day }, "day");
    expect(report.totals).toMatchObject({ spent: 300_000, office: 300_000, collected: 300_000, change: 0 });
  });

  it("leaves older advances to be corrected line by line", async () => {
    const { id } = await bankAdvance("3,000");
    await spend(id, "1,000");
    await expect(correctExpense(on(manager, DAY), id, fix("1,000", { spentOn: DAY }))).rejects.toThrow(/line by line/);
    expect((await getAdvance(manager, id))!.single).toBe(false);
  });
});
