import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bankMovements, cashMovements, operators } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import { bankPosition, confirmBankDeposit } from "@/services/bank";
import { cashBook, expectedCash } from "@/services/cash-book";
import type { Ctx } from "@/services/context";
import { getDeposit, getMyDeposits, listDeposits, operatorDepositsFor, recordDeposit, reverseDeposit } from "@/services/deposits";
import { cashDay, closeCash, collectionsFor, getStatement } from "@/services/finance";
import { recordPayment } from "@/services/payments";
import { makeOperator, makeUser, nextReference } from "./helpers";

const wat = (date: string, time = "12:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: () => wat(date, time) });

const DAY = "2036-05-12";

let manager: Ctx;
let assistant: Ctx;
beforeAll(async () => {
  manager = on((await makeUser("manager")).ctx, DAY);
  assistant = on((await makeUser("assistant_manager")).ctx, DAY);
});

const form = (operatorId: string, method: string, reference?: string, amount = "20,000") => ({
  operatorId,
  clientId: randomUUID(),
  amount,
  method,
  reference,
});
const movements = (table: typeof cashMovements | typeof bankMovements, id: string) =>
  db.select().from(table).where(eq(table.sourceId, id));
const operatorCtx = (operatorId: string): Ctx => ({
  actor: { userId: randomUUID(), name: "Operator", role: "operator", operatorId },
  clock: () => wat(DAY),
});

describe("recording a deposit", () => {
  it("puts cash with the person who received it", async () => {
    const collector = on((await makeUser("assistant_manager")).ctx, DAY);
    const operator = await makeOperator(manager);
    const { id } = await recordDeposit(collector, form(operator.id, "cash"));
    expect(await movements(cashMovements, id)).toMatchObject([
      { custodianId: collector.actor.userId, amountKobo: 2_000_000, businessDate: DAY, sourceType: "deposit" },
    ]);
    expect(await movements(bankMovements, id)).toEqual([]);
    expect(await expectedCash(db, collector.actor.userId, DAY)).toBe(2_000_000);
    const receipt = await getDeposit(manager, id);
    expect(receipt!.deposit.receiptNumber).toMatch(/^DEP-\d{6}$/);
    expect(receipt!.reference).toBeNull();
  });

  it.each(["pos", "transfer"])("puts %s money in the bank with its reference", async (method) => {
    const operator = await makeOperator(manager);
    const reference = nextReference();
    const { id } = await recordDeposit(assistant, form(operator.id, method, reference));
    expect(await movements(bankMovements, id)).toMatchObject([
      { account: "bank", amountKobo: 2_000_000, businessDate: DAY, sourceType: "deposit" },
    ]);
    expect(await movements(cashMovements, id)).toEqual([]);
    expect((await getDeposit(manager, id))!.reference).toBe(reference);
  });

  it("requires a reference for POS and transfer", async () => {
    const operator = await makeOperator(manager);
    await expect(recordDeposit(manager, form(operator.id, "pos"))).rejects.toMatchObject({
      fieldErrors: { reference: expect.anything() },
    });
  });

  it("saves one deposit when the same form is sent twice", async () => {
    const operator = await makeOperator(manager);
    const input = form(operator.id, "cash");
    const [first, second] = await Promise.all([recordDeposit(manager, input), recordDeposit(manager, input)]);
    expect(second.id).toBe(first.id);
    expect((await operatorDepositsFor(manager, operator.id)).items).toHaveLength(1);
    expect(await movements(cashMovements, first.id)).toHaveLength(1);
  });

  it("refuses an operator who is no longer active", async () => {
    const operator = await makeOperator(manager);
    await db.update(operators).set({ status: "left" }).where(eq(operators.id, operator.id));
    await expect(recordDeposit(manager, form(operator.id, "cash"))).rejects.toThrow(/active operator/);
  });
});

describe("bank references", () => {
  const usedError = { fieldErrors: { reference: expect.stringMatching(/already been used/) } };

  it("cannot be used on two deposits", async () => {
    const reference = nextReference();
    await recordDeposit(manager, form((await makeOperator(manager)).id, "pos", reference));
    await expect(recordDeposit(manager, form((await makeOperator(manager)).id, "transfer", reference))).rejects.toMatchObject(usedError);
  });

  it("cannot be shared between a payment and a deposit, in either order", async () => {
    const first = nextReference();
    await recordPayment(manager, form((await makeOperator(manager)).id, "transfer", first));
    await expect(recordDeposit(manager, form((await makeOperator(manager)).id, "transfer", first))).rejects.toMatchObject(usedError);

    const second = nextReference();
    await recordDeposit(manager, form((await makeOperator(manager)).id, "transfer", second));
    await expect(recordPayment(manager, form((await makeOperator(manager)).id, "transfer", second))).rejects.toMatchObject(usedError);
  });

  it("is freed by a reversal", async () => {
    const reference = nextReference();
    const operator = await makeOperator(manager);
    const { id } = await recordDeposit(manager, form(operator.id, "pos", reference));
    await reverseDeposit(manager, id, { reason: "Wrong operator" });
    await expect(recordDeposit(manager, form(operator.id, "pos", reference))).resolves.toBeTruthy();
  });

  it("goes on the bank check and only another person can confirm it", async () => {
    const operator = await makeOperator(manager);
    // The list shows the oldest first, so this date keeps it inside the first page.
    const { id } = await recordDeposit(on(manager, "2020-01-02"), form(operator.id, "transfer", nextReference()));
    const waiting = (await bankPosition(manager)).toConfirm.find((row) => row.id === id);
    expect(waiting).toMatchObject({ kind: "deposit", amount: 2_000_000 });
    await expect(confirmBankDeposit(manager, id)).rejects.toThrow(/different person/);
    await confirmBankDeposit(assistant, id);
    expect((await getDeposit(manager, id))!.confirmedAt).not.toBeNull();
    await expect(confirmBankDeposit(assistant, id)).rejects.toThrow(/already been confirmed/);
  });
});

describe("reversing a deposit", () => {
  it("keeps the receipt, takes the cash back out and removes it from what is held", async () => {
    const collector = on((await makeUser("assistant_manager")).ctx, DAY);
    const operator = await makeOperator(manager);
    const { id } = await recordDeposit(collector, form(operator.id, "cash"));
    await reverseDeposit(manager, id, { reason: "Entered twice" });

    expect(await expectedCash(db, collector.actor.userId, DAY)).toBe(0);
    const receipt = await getDeposit(manager, id);
    expect(receipt).toMatchObject({ reversalReason: "Entered twice" });
    expect(receipt!.deposit.amountKobo).toBe(2_000_000);
    expect((await operatorDepositsFor(manager, operator.id)).heldKobo).toBe(0);
    await expect(reverseDeposit(manager, id, { reason: "Again" })).rejects.toThrow(/already been reversed/);
  });

  it("takes bank money back out", async () => {
    const operator = await makeOperator(manager);
    const { id } = await recordDeposit(manager, form(operator.id, "pos", nextReference()));
    await reverseDeposit(manager, id, { reason: "Slip was void" });
    const rows = await db
      .select()
      .from(bankMovements)
      .where(and(eq(bankMovements.sourceId, id), eq(bankMovements.sourceType, "deposit_reversal")));
    expect(rows).toMatchObject([{ amountKobo: -2_000_000 }]);
  });

  it("cannot be edited or deleted in the database", async () => {
    const operator = await makeOperator(manager);
    const { id } = await recordDeposit(manager, form(operator.id, "cash"));
    await expect(db.execute(sql`UPDATE operator_deposits SET amount_kobo = 1 WHERE id = ${id}`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM operator_deposits WHERE id = ${id}`)).rejects.toThrow();
  });
});

describe("where deposits count", () => {
  it("balances the cash close with the cash received", async () => {
    const date = "2036-05-14";
    const collector = on((await makeUser("assistant_manager")).ctx, date);
    const operator = await makeOperator(manager);
    await recordDeposit(collector, form(operator.id, "cash"));
    const row = (await cashDay(on(manager, date), date)).find((person) => person.id === collector.actor.userId);
    expect(row).toMatchObject({ expectedKobo: 2_000_000 });
    await expect(
      closeCash(collector, { custodianId: collector.actor.userId, businessDate: date, counted: "20,000" }),
    ).resolves.toBeUndefined();
  });

  it("is named in the cash book", async () => {
    const date = "2036-05-15";
    const operator = await makeOperator(manager);
    const { id } = await recordDeposit(on(manager, date), form(operator.id, "cash"));
    const book = await cashBook(on(manager, date), { from: date, to: date });
    expect(book.rows.find((row) => row.deposit_id === id)).toMatchObject({
      source_type: "deposit",
      operator: expect.stringMatching(/\S/),
      receipt: expect.stringMatching(/^DEP-/),
    });
  });

  it("is not a collection and pays nothing the operator owes", async () => {
    const date = "2036-05-16";
    const before = await collectionsFor(on(manager, date), date);
    const operator = await makeOperator(manager);
    await recordDeposit(on(manager, date), form(operator.id, "cash"));
    await recordDeposit(on(manager, date), form(operator.id, "transfer", nextReference()));
    expect(await collectionsFor(on(manager, date), date)).toEqual(before);
    const statement = await getStatement(manager, operator.id);
    expect(statement.payments).toEqual([]);
    expect(statement.creditKobo).toBe(0);
  });

  it("totals only what is still held", async () => {
    const before = (await listDeposits(manager)).heldKobo;
    const operator = await makeOperator(manager);
    await recordDeposit(manager, form(operator.id, "cash", undefined, "5,000"));
    const { id } = await recordDeposit(manager, form(operator.id, "cash", undefined, "7,000"));
    await reverseDeposit(manager, id, { reason: "Mistake" });
    expect((await listDeposits(manager)).heldKobo).toBe(before + 500_000);
  });
});

describe("who can do what", () => {
  it("lets the office record, only the Manager reverse, and the owner watch", async () => {
    const owner = on((await makeUser("owner")).ctx, DAY);
    const supervisor = on((await makeUser("supervisor")).ctx, DAY);
    const operator = await makeOperator(manager);
    const input = () => form(operator.id, "cash");

    await expect(recordDeposit(owner, input())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordDeposit(supervisor, input())).rejects.toBeInstanceOf(ForbiddenError);
    const { id } = await recordDeposit(assistant, input());
    await expect(reverseDeposit(assistant, id, { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listDeposits(owner)).resolves.toBeTruthy();
    await expect(listDeposits(supervisor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(operatorDepositsFor(supervisor, operator.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("shows an operator only their own deposits", async () => {
    const mine = await makeOperator(manager);
    const other = await makeOperator(manager);
    await recordDeposit(manager, form(mine.id, "cash"));
    await recordDeposit(manager, form(other.id, "cash", undefined, "9,000"));
    const seen = await getMyDeposits(operatorCtx(mine.id));
    expect(seen.heldKobo).toBe(2_000_000);
    expect(seen.items.map((item) => item.operatorId)).toEqual([mine.id]);
    await expect(listDeposits(operatorCtx(mine.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordDeposit(operatorCtx(mine.id), form(mine.id, "cash"))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
