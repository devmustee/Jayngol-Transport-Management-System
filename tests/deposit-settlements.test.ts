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
  settleDeposit,
  undoSettlement,
} from "@/services/deposit-settlements";
import { listDeposits, operatorDepositsFor, recordDeposit, reverseDeposit } from "@/services/deposits";
import { openCharges } from "@/services/ledger";
import { markOperatorLeft } from "@/services/operators";
import { reversePayment } from "@/services/payments";
import { makeOperator, makeUser, noticesFor } from "./helpers";

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

  it("needs a reason to keep part, and records it as kept", async () => {
    const operator = await leaver("10,000", []);
    const keep = { operatorId: operator.id, clear: [], giveBack: "2,000", source: "bank" };
    await expect(settleDeposit(manager, keep)).rejects.toMatchObject({ fieldErrors: { keptReason: expect.anything() } });
    const result = await settleDeposit(manager, { ...keep, keptReason: "Broken windscreen" });
    expect(result).toMatchObject({ givenBackKobo: 200_000, keptKobo: 800_000 });
    const position = await depositPosition(manager, operator.id);
    expect(position!.settlements[0]).toMatchObject({ keptKobo: 800_000, keptReason: "Broken windscreen" });
  });

  it("asks where the money given back comes from", async () => {
    const operator = await leaver("10,000", []);
    await expect(settleDeposit(manager, { operatorId: operator.id })).rejects.toMatchObject({
      fieldErrors: { source: expect.anything() },
    });
  });

  it("is refused while the operator still works, and for anyone but the Manager", async () => {
    const working = await makeOperator(manager);
    await recordDeposit(manager, { operatorId: working.id, clientId: randomUUID(), amount: "10,000", method: "cash" });
    await expect(settleDeposit(manager, { operatorId: working.id, source: "bank" })).rejects.toThrow(/left or been sacked/);
    const operator = await leaver("10,000", []);
    await expect(settleDeposit(assistant, { operatorId: operator.id, source: "bank" })).rejects.toBeInstanceOf(ForbiddenError);
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
    await expect(reverseDeposit(manager, deposit!.id, { reason: "Mistake" })).rejects.toThrow(/settled/);

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
