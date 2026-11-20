import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cashMovements, charges, payments } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import { annualBalance } from "@/services/annual-balance";
import { expectedCash } from "@/services/cash-book";
import type { Ctx } from "@/services/context";
import {
  depositPosition,
  depositsToSettle,
  getMySettlements,
  notSavingThisMonth,
  refundAllDue,
  settleDeposit,
  undoSettlement,
} from "@/services/deposit-settlements";
import { issueTricycle } from "@/services/assignments";
import { listDeposits, operatorDepositsFor, recordDeposit, reverseDeposit } from "@/services/deposits";
import { openCharges } from "@/services/ledger";
import { markOperatorLeft } from "@/services/operators";
import { reversePayment } from "@/services/payments";
import { makeOperator, makeTricycle, makeUser, noticesFor } from "./helpers";

const wat = (date: string, time = "12:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: () => wat(date, time) });

const DAY = "2038-03-10";

let manager: Ctx;
let assistant: Ctx;
beforeAll(async () => {
  manager = on((await makeUser("manager")).ctx, DAY);
  assistant = on((await makeUser("assistant_manager")).ctx, DAY);
});

/** An operator who left, with a cash deposit held by the Manager and the given debts. */
async function leaver(depositNaira: string, debts: { type: "daily_balance" | "penalty"; kobo: number; date: string }[]) {
  const operator = await makeOperator(manager);
  await recordDeposit(on(manager, "2038-01-05"), {
    operatorId: operator.id,
    clientId: randomUUID(),
    amount: depositNaira,
    method: "cash",
  });
  for (const debt of debts) {
    await db.insert(charges).values({
      type: debt.type,
      operatorId: operator.id,
      amountKobo: debt.kobo,
      businessDate: debt.date,
      dueOn: debt.type === "daily_balance" ? debt.date : null,
    });
  }
  await markOperatorLeft(manager, operator.id, { reason: "Moved away" });
  return operator;
}

const owedOf = async (operatorId: string, type: "daily_balance" | "penalty") =>
  (await openCharges(db, operatorId, type)).reduce((sum, c) => sum + c.outstandingKobo, 0);

describe("settling a deposit", () => {
  it("clears what is owed, gives the rest back from the chosen cash and stops counting it as held", async () => {
    const operator = await leaver("50,000", [
      { type: "daily_balance", kobo: 1_200_000, date: "2038-03-01" },
      { type: "daily_balance", kobo: 1_200_000, date: "2038-03-02" },
      { type: "penalty", kobo: 300_000, date: "2038-03-02" },
    ]);
    const heldBefore = (await listDeposits(manager)).heldKobo;
    const cashBefore = await expectedCash(db, manager.actor.userId, DAY);
    const position = await depositPosition(manager, operator.id);
    expect(position).toMatchObject({ heldKobo: 5_000_000, notYet: null, canSettle: true });
    expect(position!.owed.daily_balance).toEqual({ kobo: 2_400_000, count: 2 });
    expect((await depositsToSettle()).map((row) => row.operator_id)).toContain(operator.id);

    const result = await settleDeposit(manager, {
      operatorId: operator.id,
      clear: ["daily_balance", "penalty"],
      source: manager.actor.userId,
    });
    expect(result).toMatchObject({ heldKobo: 5_000_000, clearedKobo: 2_700_000, givenBackKobo: 2_300_000, keptKobo: 0 });

    expect(await owedOf(operator.id, "daily_balance")).toBe(0);
    expect(await owedOf(operator.id, "penalty")).toBe(0);
    expect(await expectedCash(db, manager.actor.userId, DAY)).toBe(cashBefore - 2_300_000);
    expect((await listDeposits(manager)).heldKobo).toBe(heldBefore - 5_000_000);
    expect((await operatorDepositsFor(manager, operator.id)).heldKobo).toBe(0);
    expect((await depositsToSettle()).map((row) => row.operator_id)).not.toContain(operator.id);

    // The receipt clears the debts but adds no money: the deposit already did.
    const [receipt] = await db.select().from(payments).where(eq(payments.operatorId, operator.id));
    expect(receipt).toMatchObject({ method: "deposit", amountKobo: 2_700_000 });
    expect(await db.select().from(cashMovements).where(eq(cashMovements.sourceId, receipt!.id))).toEqual([]);
    expect((await noticesFor(operator.id, "receipt")).some((n) => n.body.includes("₦23,000 given back"))).toBe(true);

    const year = await annualBalance(manager, 2038);
    expect(year.total.fromDepositKobo).toBeGreaterThanOrEqual(2_700_000);
    expect(year.total.depositsReturnedKobo).toBeGreaterThanOrEqual(2_300_000);

    const mine = await getMySettlements({
      actor: { userId: randomUUID(), name: "Operator", role: "operator", operatorId: operator.id },
      clock: () => wat(DAY),
    });
    expect(mine).toMatchObject([{ clearedKobo: 2_700_000, givenBackKobo: 2_300_000 }]);
  });

  it("leaves an unticked fine owed and gives its amount back instead", async () => {
    const operator = await leaver("20,000", [
      { type: "daily_balance", kobo: 1_000_000, date: "2038-03-01" },
      { type: "penalty", kobo: 300_000, date: "2038-03-01" },
    ]);
    const result = await settleDeposit(manager, { operatorId: operator.id, clear: ["daily_balance"], source: "bank" });
    expect(result).toMatchObject({ clearedKobo: 1_000_000, givenBackKobo: 1_000_000 });
    expect(await owedOf(operator.id, "penalty")).toBe(300_000);
  });

  it("clears the oldest debts first when the deposit is smaller, and gives nothing back", async () => {
    const operator = await leaver("15,000", [
      { type: "daily_balance", kobo: 1_000_000, date: "2038-03-03" },
      { type: "daily_balance", kobo: 1_000_000, date: "2038-03-01" },
    ]);
    const result = await settleDeposit(manager, { operatorId: operator.id, clear: ["daily_balance"] });
    expect(result).toMatchObject({ clearedKobo: 1_500_000, givenBackKobo: 0, keptKobo: 0 });
    const open = await openCharges(db, operator.id, "daily_balance");
    expect(open.map((c) => [c.businessDate, c.outstandingKobo])).toEqual([["2038-03-03", 500_000]]);
  });

  it("takes damage off what is left, and needs to say what was damaged", async () => {
    const operator = await leaver("50,000", [{ type: "daily_balance", kobo: 1_200_000, date: "2038-03-01" }]);
    const base = { operatorId: operator.id, clear: ["daily_balance"], damage: "8,000", source: "bank" };
    await expect(settleDeposit(manager, base)).rejects.toMatchObject({ fieldErrors: { damageWhat: expect.anything() } });
    const result = await settleDeposit(manager, { ...base, damageWhat: "Broken windscreen", damageOnPurpose: "on" });
    expect(result).toMatchObject({ clearedKobo: 1_200_000, keptKobo: 800_000, givenBackKobo: 3_000_000, owedFineKobo: 0 });
    const position = await depositPosition(manager, operator.id);
    expect(position!.settlements[0]).toMatchObject({ keptKobo: 800_000, keptReason: "Broken windscreen", damageOnPurpose: true });
    expect((await noticesFor(operator.id, "receipt")).some((n) => n.body.includes("₦8,000 for damage: Broken windscreen"))).toBe(true);
  });

  it("owes damage beyond the savings as a fine, which undo removes", async () => {
    const operator = await leaver("30,000", []);
    const result = await settleDeposit(manager, {
      operatorId: operator.id,
      damage: "50,000",
      damageWhat: "Engine burnt",
    });
    expect(result).toMatchObject({ keptKobo: 3_000_000, givenBackKobo: 0, owedFineKobo: 2_000_000 });
    expect(await owedOf(operator.id, "penalty")).toBe(2_000_000);
    await undoSettlement(manager, result.id);
    expect(await owedOf(operator.id, "penalty")).toBe(0);
    expect((await operatorDepositsFor(manager, operator.id)).heldKobo).toBe(3_000_000);
  });

  it("asks where the money given back comes from", async () => {
    const operator = await leaver("10,000", []);
    await expect(settleDeposit(manager, { operatorId: operator.id })).rejects.toMatchObject({
      fieldErrors: { source: expect.anything() },
    });
  });

  it("is refused for anyone but the Manager, and while a leaver still holds the tricycle", async () => {
    const operator = await leaver("10,000", []);
    await expect(settleDeposit(assistant, { operatorId: operator.id, source: "bank" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("monthly savings", () => {
  /** A working operator who saved ₦1,000 on each given day. */
  async function saver(days: string[]) {
    const operator = await makeOperator(manager);
    for (const day of days) {
      await recordDeposit(on(manager, day), { operatorId: operator.id, clientId: randomUUID(), amount: "1,000", method: "cash" });
    }
    return operator;
  }

  it("gives back a working operator's month of savings on the month end, not before", async () => {
    const operator = await saver(["2038-04-03", "2038-04-04", "2038-04-05"]);
    const before = await depositPosition(on(manager, "2038-04-29"), operator.id);
    expect(before).toMatchObject({ heldKobo: 300_000, dueKobo: 0, savedThisMonthKobo: 300_000 });
    expect(before!.notYet).toMatch(/30 Apr 2038/);
    await expect(
      settleDeposit(on(manager, "2038-04-29"), { operatorId: operator.id, source: "bank" }),
    ).rejects.toThrow(/given back on 30 Apr 2038/);
    expect((await depositsToSettle(db, "2038-04-29")).map((r) => r.operator_id)).not.toContain(operator.id);

    const monthEnd = on(manager, "2038-04-30", "09:00");
    expect((await depositsToSettle(db, "2038-04-30")).map((r) => r.operator_id)).toContain(operator.id);
    const result = await settleDeposit(monthEnd, { operatorId: operator.id, source: "bank" });
    expect(result).toMatchObject({ heldKobo: 300_000, givenBackKobo: 300_000 });
    expect((await noticesFor(operator.id, "receipt")).some((n) => n.body.includes("Start saving for May"))).toBe(true);

    // Saved later on refund day: held for May.
    await recordDeposit(on(manager, "2038-04-30", "15:00"), {
      operatorId: operator.id,
      clientId: randomUUID(),
      amount: "1,000",
      method: "cash",
    });
    const after = await depositPosition(on(manager, "2038-04-30", "16:00"), operator.id);
    expect(after).toMatchObject({ heldKobo: 100_000, dueKobo: 0 });
    expect((await depositsToSettle(db, "2038-04-30")).map((r) => r.operator_id)).not.toContain(operator.id);
  });

  it("keeps savings from a month that was never given back due on any later day", async () => {
    const operator = await saver(["2038-05-10"]);
    await recordDeposit(on(manager, "2038-06-02"), { operatorId: operator.id, clientId: randomUUID(), amount: "1,000", method: "cash" });
    const position = await depositPosition(on(manager, "2038-06-03"), operator.id);
    expect(position).toMatchObject({ heldKobo: 200_000, dueKobo: 100_000 });
    const result = await settleDeposit(on(manager, "2038-06-03"), { operatorId: operator.id, source: "bank" });
    expect(result.heldKobo).toBe(100_000);
  });

  it("gives back all ticked operators at once, clearing their debts, from one source", async () => {
    const one = await saver(["2038-07-01", "2038-07-02"]);
    const two = await saver(["2038-07-03"]);
    await db.insert(charges).values({ type: "daily_balance", operatorId: two.id, amountKobo: 50_000, businessDate: "2038-07-05", dueOn: "2038-07-05" });
    const day = on(manager, "2038-07-31");
    await expect(refundAllDue(assistant, { operatorIds: [one.id], source: "bank" })).rejects.toBeInstanceOf(ForbiddenError);
    const done = await refundAllDue(day, { operatorIds: [one.id, two.id], source: "bank" });
    expect(done).toMatchObject({ count: 2, clearedKobo: 50_000, givenBackKobo: 250_000 });
    expect(await owedOf(two.id, "daily_balance")).toBe(0);
    await expect(refundAllDue(day, { operatorIds: [one.id], source: "bank" })).rejects.toThrow(/Refunded today/);
  });

  it("refuses all at once when the chosen cash is too small, saving nothing", async () => {
    const poor = (await makeUser("assistant_manager")).ctx;
    const one = await saver(["2038-08-01"]);
    await expect(
      refundAllDue(on(manager, "2038-08-31"), { operatorIds: [one.id], source: poor.actor.userId }),
    ).rejects.toMatchObject({ fieldErrors: { source: expect.anything() } });
    expect((await depositPosition(on(manager, "2038-08-31"), one.id))!.dueKobo).toBe(100_000);
  });

  it("lists working operators with nothing saved this month", async () => {
    const idle = await makeOperator(manager);
    const t = await makeTricycle(manager);
    await issueTricycle(on(manager, "2038-09-01"), { tricycleId: t.id, operatorId: idle.id, issuedOn: "2038-09-01" });
    expect((await notSavingThisMonth(db, "2038-09-10")).map((r) => r.operator_id)).toContain(idle.id);
  });
});

describe("undoing a settlement", () => {
  it("opens the debts again, puts the money back and holds the deposit again, on the same day only", async () => {
    const operator = await leaver("30,000", [{ type: "daily_balance", kobo: 1_000_000, date: "2038-03-01" }]);
    const cashBefore = await expectedCash(db, manager.actor.userId, DAY);
    const { id } = await settleDeposit(manager, {
      operatorId: operator.id,
      clear: ["daily_balance"],
      source: manager.actor.userId,
    });
    const [receipt] = await db.select().from(payments).where(eq(payments.operatorId, operator.id));
    await expect(reversePayment(manager, receipt!.id, { reason: "Mistake" })).rejects.toThrow(/deposit settlement/);
    const [deposit] = (await operatorDepositsFor(manager, operator.id)).items;
    await expect(reverseDeposit(manager, deposit!.id, { reason: "Mistake" })).rejects.toThrow(/given back/);

    await expect(undoSettlement(on(manager, "2038-03-11"), id)).rejects.toThrow(/day it was saved/);
    await undoSettlement(manager, id);
    expect(await owedOf(operator.id, "daily_balance")).toBe(1_000_000);
    expect(await expectedCash(db, manager.actor.userId, DAY)).toBe(cashBefore);
    expect((await operatorDepositsFor(manager, operator.id)).heldKobo).toBe(3_000_000);
    await expect(undoSettlement(manager, id)).rejects.toThrow(/already been undone/);

    // It can be settled again afterwards.
    const again = await settleDeposit(manager, { operatorId: operator.id, clear: ["daily_balance"], source: "bank" });
    expect(again).toMatchObject({ clearedKobo: 1_000_000, givenBackKobo: 2_000_000 });
  });
});
