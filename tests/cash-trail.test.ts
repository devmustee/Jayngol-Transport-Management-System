import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bankMovements, moneyTransfers } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import { bankPosition, confirmBankPayment, recordReconciliation, setOpeningBalance } from "@/services/bank";
import { cashAlerts, cashBook, cashPosition, expectedCash } from "@/services/cash-book";
import type { Ctx } from "@/services/context";
import { cashDay, checkCashClose, closeCash } from "@/services/finance";
import { cancelLoan, grantLoan } from "@/services/loans";
import { getMyNotices, markMyNoticesRead } from "@/services/notices";
import { recordPayment, reversePayment } from "@/services/payments";
import { acceptTransfer, createTransfer, rejectTransfer, voidTransfer } from "@/services/transfers";
import { makeOperator, makeUser, nextReference } from "./helpers";

const wat = (date: string, time = "12:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: () => wat(date, time) });
const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

let manager: Ctx;
let assistant: Ctx;
let owner: Ctx;
beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  assistant = (await makeUser("assistant_manager")).ctx;
  owner = (await makeUser("owner")).ctx;
});

const DAY = "2034-03-10";
const someone = async () => (await makeUser("assistant_manager")).ctx;
const collect = async (ctx: Ctx, amount: string) => {
  const operator = await makeOperator(manager);
  return recordPayment(ctx, { operatorId: operator.id, amount, method: "cash", clientId: randomUUID() });
};
const payBy = async (ctx: Ctx, method: string, reference?: string) => {
  const operator = await makeOperator(manager);
  return recordPayment(ctx, { operatorId: operator.id, amount: "5,000", method, reference, clientId: randomUUID() });
};
const bankRow = (paymentId: string) => sql`SELECT confirmed_at, released_at FROM payment_references WHERE payment_id = ${paymentId}`;
const operatorCtx = (operatorId: string): Ctx => ({
  actor: { userId: randomUUID(), name: "Operator", role: "operator", operatorId },
  clock: () => wat(DAY),
});

describe("operator notices", () => {
  it("shows a receipt only to that operator and marks it read", async () => {
    const mine = await makeOperator(manager);
    const other = await makeOperator(manager);
    await recordPayment(on(manager, DAY), { operatorId: mine.id, amount: "7,000", method: "cash", clientId: randomUUID() });

    const notices = await getMyNotices(operatorCtx(mine.id));
    expect(notices.unread).toBe(1);
    expect(notices.items[0]!.body).toContain("₦7,000");
    expect((await getMyNotices(operatorCtx(other.id))).items).toHaveLength(0);

    await markMyNoticesRead(operatorCtx(other.id));
    expect((await getMyNotices(operatorCtx(mine.id))).unread).toBe(1);
    await markMyNoticesRead(operatorCtx(mine.id));
    expect((await getMyNotices(operatorCtx(mine.id))).unread).toBe(0);
  });

  it("refuses staff", async () => {
    await expect(getMyNotices(manager)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("bank references", () => {
  it("requires one for transfer and POS, but not cash", async () => {
    await expect(payBy(on(manager, DAY), "transfer")).rejects.toMatchObject({ fieldErrors: { reference: expect.anything() } });
    await expect(payBy(on(manager, DAY), "pos", "ab")).rejects.toMatchObject({ fieldErrors: { reference: expect.anything() } });
    await expect(collect(on(manager, DAY), "1,000")).resolves.toBeDefined();
  });

  it("refuses the same reference twice, however it is typed", async () => {
    const reference = nextReference();
    await payBy(on(manager, DAY), "transfer", reference);
    await expect(payBy(on(manager, DAY), "pos", ` ${reference.toLowerCase()} `)).rejects.toMatchObject({
      fieldErrors: { reference: expect.anything() },
    });
  });

  it("frees the reference when the payment is reversed", async () => {
    const reference = nextReference();
    const first = (await payBy(on(manager, DAY), "transfer", reference)) as { id: string };
    await reversePayment(on(manager, DAY), first.id, { reason: "Wrong operator" });
    await expect(payBy(on(manager, DAY), "transfer", reference)).resolves.toBeDefined();
  });

  it("must be confirmed by someone other than the person who recorded it", async () => {
    const paid = (await payBy(on(assistant, DAY), "transfer", nextReference())) as { id: string };
    await expect(confirmBankPayment(assistant, paid.id)).rejects.toThrow(/different person/);
    await confirmBankPayment(manager, paid.id);
    const [row] = (await db.execute(bankRow(paid.id))) as unknown as { confirmed_at: Date | null }[];
    expect(row!.confirmed_at).not.toBeNull();
    await expect(confirmBankPayment(manager, paid.id)).rejects.toThrow(/already/);
  });
});

describe("carrying cash forward", () => {
  it("keeps cash with the person until it is recorded leaving", async () => {
    const person = await someone();
    await collect(on(person, "2034-04-01"), "20,000");
    expect(await cashPosition(db, person.actor.userId, "2034-04-05")).toEqual({ openingKobo: 2_000_000, movedKobo: 0 });
  });

  it("starts each day from the last count", async () => {
    const person = await someone();
    const id = person.actor.userId;
    await collect(on(person, "2034-04-01"), "20,000");
    await closeCash(on(person, "2034-04-01", "20:00"), { custodianId: id, businessDate: "2034-04-01", counted: "19,000", explanation: "Short" });
    await collect(on(person, "2034-04-02"), "5,000");
    expect(await cashPosition(db, id, "2034-04-02")).toEqual({ openingKobo: 1_900_000, movedKobo: 500_000 });
  });

  it("covers unclosed days with the next count, and refuses going back", async () => {
    const person = await someone();
    const id = person.actor.userId;
    await collect(on(person, "2034-04-01"), "10,000");
    await collect(on(person, "2034-04-02"), "3,000");
    await closeCash(on(person, "2034-04-02", "20:00"), { custodianId: id, businessDate: "2034-04-02", counted: "13,000" });
    await expect(
      closeCash(on(person, "2034-04-02", "20:05"), { custodianId: id, businessDate: "2034-04-01", counted: "10,000" }),
    ).rejects.toThrow(/later day/);
  });

  it("flags a person who has not closed since a past day", async () => {
    const person = await someone();
    await collect(on(person, "2034-05-01"), "1,000");
    const alerts = await cashAlerts(db, "2034-05-03");
    expect(alerts.cashNotClosed.find((row) => row.name === person.actor.name)).toMatchObject({ since: "2034-05-01" });
    expect((await cashAlerts(db, "2034-05-01")).cashNotClosed.find((row) => row.name === person.actor.name)).toBeUndefined();
  });
});

describe("second check", () => {
  async function closed() {
    const person = await someone();
    await collect(on(person, "2034-06-01"), "10,000");
    await closeCash(on(person, "2034-06-01", "20:00"), { custodianId: person.actor.userId, businessDate: "2034-06-01", counted: "10,000" });
    const day = await cashDay(on(person, "2034-06-01"), "2034-06-01");
    return { person, closeId: day.find((row) => row.id === person.actor.userId)!.close!.id };
  }

  it("cannot be done by the person who closed", async () => {
    const { person, closeId } = await closed();
    await expect(checkCashClose(person, closeId, { recounted: "10,000" })).rejects.toThrow(/different person/);
  });

  it("needs a note when the recount differs, and carries the recount forward", async () => {
    const { person, closeId } = await closed();
    await expect(checkCashClose(manager, closeId, { recounted: "9,500" })).rejects.toMatchObject({
      fieldErrors: { note: expect.anything() },
    });
    await checkCashClose(manager, closeId, { recounted: "9,500", note: "One note was fake" });
    expect(await expectedCash(db, person.actor.userId, "2034-06-02")).toBe(950_000);
    await expect(checkCashClose(manager, closeId, { recounted: "9,500", note: "Again" })).rejects.toThrow(/already/);
  });

  it("cannot be changed in the database", async () => {
    await expect(db.execute(sql`DELETE FROM cash_close_checks`)).rejects.toThrow();
  });
});

describe("moving money", () => {
  it("needs a teller number and photo for a bank deposit, then moves it", async () => {
    const person = await someone();
    const id = person.actor.userId;
    const ctx = on(person, "2034-07-01");
    await collect(ctx, "30,000");
    const base = { from: id, to: "bank", amount: "25,000" };
    await expect(createTransfer(ctx, base)).rejects.toMatchObject({ fieldErrors: { reference: expect.anything() } });
    await expect(createTransfer(ctx, { ...base, reference: "T-1" })).rejects.toMatchObject({ fieldErrors: { photo: expect.anything() } });
    const deposit = await createTransfer(ctx, { ...base, reference: "T-1", photo: PHOTO });
    expect(await expectedCash(db, id, "2034-07-01")).toBe(500_000);
    const rows = await db.select().from(bankMovements).where(eq(bankMovements.sourceId, deposit.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account: "bank", amountKobo: 2_500_000, sourceType: "transfer_in" });
  });

  it("refuses more cash than the person holds", async () => {
    const person = await someone();
    const ctx = on(person, "2034-07-01");
    await collect(ctx, "1,000");
    await expect(
      createTransfer(ctx, { from: person.actor.userId, to: "bank", amount: "2,000", reference: "T-2", photo: PHOTO }),
    ).rejects.toMatchObject({ fieldErrors: { from: expect.anything() } });
  });

  it("moves a handover only when the receiver accepts", async () => {
    const sender = await someone();
    const receiver = await someone();
    const ctx = on(sender, "2034-07-02");
    await collect(ctx, "8,000");
    const handover = await createTransfer(ctx, { from: sender.actor.userId, to: receiver.actor.userId, amount: "8,000" });
    expect(handover.status).toBe("pending");
    expect(await expectedCash(db, sender.actor.userId, "2034-07-02")).toBe(800_000);

    await expect(acceptTransfer(on(manager, "2034-07-02"), handover.id)).rejects.toThrow(/receiving/);
    await acceptTransfer(on(receiver, "2034-07-02"), handover.id);
    expect(await expectedCash(db, sender.actor.userId, "2034-07-02")).toBe(0);
    expect(await expectedCash(db, receiver.actor.userId, "2034-07-02")).toBe(800_000);
    await expect(acceptTransfer(on(receiver, "2034-07-02"), handover.id)).rejects.toThrow(/already/);
  });

  it("moves nothing when a handover is refused", async () => {
    const sender = await someone();
    const receiver = await someone();
    const ctx = on(sender, "2034-07-02");
    await collect(ctx, "4,000");
    const handover = await createTransfer(ctx, { from: sender.actor.userId, to: receiver.actor.userId, amount: "4,000" });
    await rejectTransfer(on(receiver, "2034-07-02"), handover.id, { reason: "Not received" });
    expect(await expectedCash(db, sender.actor.userId, "2034-07-02")).toBe(400_000);
    expect(await expectedCash(db, receiver.actor.userId, "2034-07-02")).toBe(0);
  });

  it("limits staff to their own cash, and bank or owner money to the Manager", async () => {
    const person = await someone();
    await expect(createTransfer(person, { from: "bank", to: "owner", amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTransfer(person, { from: manager.actor.userId, to: "owner", amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTransfer(owner, { from: "bank", to: "owner", amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reverses a mistake with new entries and keeps the record", async () => {
    const person = await someone();
    const ctx = on(person, "2034-07-03");
    await collect(ctx, "6,000");
    const move = await createTransfer(ctx, { from: person.actor.userId, to: "owner", amount: "6,000" });
    expect(await expectedCash(db, person.actor.userId, "2034-07-03")).toBe(0);
    await expect(voidTransfer(ctx, move.id, { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await voidTransfer(on(manager, "2034-07-03"), move.id, { reason: "Wrong amount" });
    expect(await expectedCash(db, person.actor.userId, "2034-07-03")).toBe(600_000);
    const [row] = await db.select().from(moneyTransfers).where(eq(moneyTransfers.id, move.id));
    expect(row).toMatchObject({ status: "voided", reason: "Wrong amount" });
  });
});

describe("owner money", () => {
  it("keeps a loan from the owner off the bank, and returns it there on cancel", async () => {
    const date = "2035-01-10";
    const operator = await makeOperator(manager);
    const ctx = on(manager, date);
    const loan = await grantLoan(ctx, { operatorId: operator.id, amount: "9,000", source: "owner" });
    let book = await cashBook(ctx, { from: date, to: date });
    expect(book.bank.moneyOut).toBe(0);
    expect(book.owner.moneyOut).toBe(900_000);
    await cancelLoan(ctx, loan!.id, { reason: "Not collected" });
    book = await cashBook(ctx, { from: date, to: date });
    expect(book.owner.net).toBe(0);
  });
});

describe("bank reconciliation", () => {
  it("sets the opening balance once, for the Manager only", async () => {
    await expect(setOpeningBalance(assistant, { amount: "1", date: DAY })).rejects.toBeInstanceOf(ForbiddenError);
    await setOpeningBalance(on(manager, DAY), { amount: "100,000", date: "2030-01-01" });
    await expect(setOpeningBalance(on(manager, DAY), { amount: "1", date: "2030-01-01" })).rejects.toThrow(/already/);
    expect((await bankPosition(on(manager, DAY))).hasOpening).toBe(true);
  });

  it("freezes the month-end figures and needs a reason for a difference", async () => {
    const ctx = on(manager, "2036-06-15");
    await expect(recordReconciliation(ctx, { month: "2036-06", statement: "1" })).rejects.toMatchObject({
      fieldErrors: { month: expect.anything() },
    });
    const [{ book } = { book: 0 }] = (await db.execute(sql`
      SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS book FROM bank_movements
      WHERE account = 'bank' AND business_date < '2036-06-01'
    `)) as unknown as { book: number }[];
    const statement = ((book + 50_000) / 100).toFixed(2);
    await expect(recordReconciliation(ctx, { month: "2036-05", statement })).rejects.toMatchObject({
      fieldErrors: { explanation: expect.anything() },
    });
    await recordReconciliation(ctx, { month: "2036-05", statement, explanation: "Bank charges" });
    const { history } = await bankPosition(ctx);
    expect(history[0]).toMatchObject({ month: "2036-05-01", bookKobo: book, statementKobo: book + 50_000 });
    await expect(recordReconciliation(ctx, { month: "2036-05", statement, explanation: "x" })).rejects.toMatchObject({
      fieldErrors: { month: expect.anything() },
    });
  });
});
