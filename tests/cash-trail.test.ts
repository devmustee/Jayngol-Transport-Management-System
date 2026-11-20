import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bankMovements, moneyTransfers, notificationRecipients, notifications, users } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import {
  bankPosition,
  bookAt,
  confirmBankItems,
  confirmBankPayment,
  correctOpeningBalance,
  correctReconciliation,
  recordReconciliation,
  setOpeningBalance,
  undoBankConfirm,
} from "@/services/bank";
import { cashAlerts, cashBook, cashPosition, expectedCash, moneySources } from "@/services/cash-book";
import type { Ctx } from "@/services/context";
import { cashDay, closeCash, correctCashCount } from "@/services/finance";
import { cancelLoan, grantLoan } from "@/services/loans";
import { getMyNotices, markMyNoticesRead } from "@/services/notices";
import { listPayments, recordPayment, reversePayment } from "@/services/payments";
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

describe("closing cash", () => {
  it("is one step: the close is final, with no second check", async () => {
    const person = await someone();
    await collect(on(person, "2034-06-01"), "10,000");
    await closeCash(on(person, "2034-06-01", "20:00"), { custodianId: person.actor.userId, businessDate: "2034-06-01", counted: "9,500", explanation: "₦500 short" });
    const [row] = (await cashDay(on(person, "2034-06-01"), "2034-06-01")).filter((p) => p.id === person.actor.userId);
    expect(row!.close).toMatchObject({ countedKobo: 950_000 });
    expect(row!.check).toBeNull();
    expect(await expectedCash(db, person.actor.userId, "2034-06-02")).toBe(950_000);
    expect((await cashAlerts(db, "2034-06-02")).cashNotClosed.find((r) => r.name === person.actor.name)).toBeUndefined();
  });

  it("keeps old second checks unchangeable", async () => {
    await db.execute(sql`
      INSERT INTO cash_close_checks (close_id, checked_at)
      SELECT id, now() FROM cash_closes ORDER BY business_date DESC LIMIT 1 ON CONFLICT DO NOTHING`);
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

const toldAbout = async (userId: string, kind: string, transferId: string) =>
  (
    await db
      .select({ body: notifications.body })
      .from(notificationRecipients)
      .innerJoin(notifications, eq(notifications.id, notificationRecipients.notificationId))
      .where(and(eq(notificationRecipients.userId, userId), eq(notifications.kind, kind), eq(notifications.entityId, transferId)))
  ).map((row) => row.body);
const disable = (ctx: Ctx) => db.update(users).set({ status: "disabled" }).where(eq(users.id, ctx.actor.userId));

describe("moving money safely", () => {
  it("cannot promise the same cash in two handovers, or spend cash a handover is waiting on", async () => {
    const date = "2034-08-01";
    const sender = on(await someone(), date);
    const first = await someone();
    const second = await someone();
    await collect(sender, "10,000");
    const one = await createTransfer(sender, { from: sender.actor.userId, to: first.actor.userId, amount: "7,000" });
    expect(one.message).toMatch(/Waiting for .* to accept ₦7,000/);
    await expect(
      createTransfer(sender, { from: sender.actor.userId, to: second.actor.userId, amount: "4,000" }),
    ).rejects.toMatchObject({ fieldErrors: { from: expect.stringMatching(/Only ₦3,000 is free.*₦7,000 is waiting/) } });
    await expect(
      createTransfer(sender, { from: sender.actor.userId, to: "owner", amount: "4,000" }),
    ).rejects.toMatchObject({ fieldErrors: { from: expect.anything() } });
    const operator = await makeOperator(manager);
    await expect(
      grantLoan(on(manager, date), { operatorId: operator.id, amount: "4,000", source: sender.actor.userId }),
    ).rejects.toThrow();

    const mine = (await moneySources(on(manager, date))).find((person) => person.id === sender.actor.userId)!;
    expect(mine).toMatchObject({ heldKobo: 1_000_000, waitingKobo: 700_000, availableKobo: 300_000 });

    await acceptTransfer(on(first, date), one.id);
    expect(await expectedCash(db, first.actor.userId, date)).toBe(700_000);
    const two = await createTransfer(sender, { from: sender.actor.userId, to: second.actor.userId, amount: "3,000" });
    expect(two.status).toBe("pending");
  });

  it("asks the giver, not the Manager, to confirm when the Manager takes their cash", async () => {
    const date = "2034-08-02";
    const boss = on(manager, date);
    const assistantNow = on(await someone(), date);
    await collect(assistantNow, "5,000");
    const handover = await createTransfer(boss, { from: assistantNow.actor.userId, to: manager.actor.userId, amount: "5,000" });
    expect(handover.message).toMatch(/to confirm they gave you ₦5,000/);
    expect(await toldAbout(assistantNow.actor.userId, "handover_sent", handover.id)).toHaveLength(1);

    await expect(acceptTransfer(boss, handover.id)).rejects.toThrow(/giving the cash must confirm/);
    expect(await expectedCash(db, assistantNow.actor.userId, date)).toBe(500_000);
    await acceptTransfer(assistantNow, handover.id);
    expect(await expectedCash(db, assistantNow.actor.userId, date)).toBe(0);
    expect(await expectedCash(db, manager.actor.userId, date)).toBeGreaterThanOrEqual(500_000);
  });

  it("tells the person whose cash it is, and lets them withdraw a handover someone else recorded", async () => {
    const date = "2034-08-03";
    const giver = on(await someone(), date);
    const taker = on(await someone(), date);
    await collect(giver, "2,000");
    const handover = await createTransfer(on(manager, date), { from: giver.actor.userId, to: taker.actor.userId, amount: "2,000" });
    expect(await toldAbout(taker.actor.userId, "handover_sent", handover.id)).toHaveLength(1);
    expect((await toldAbout(giver.actor.userId, "cash_moved", handover.id))[0]).toContain("of your cash");
    await rejectTransfer(giver, handover.id, { reason: "I never gave this" });
    const [row] = await db.select().from(moneyTransfers).where(eq(moneyTransfers.id, handover.id));
    expect(row!.status).toBe("rejected");
    expect((await toldAbout(manager.actor.userId, "handover_rejected", handover.id))[0]).toContain("withdrew");

    const stranger = on(await someone(), date);
    const again = await createTransfer(on(manager, date), { from: giver.actor.userId, to: taker.actor.userId, amount: "1,000" });
    await expect(rejectTransfer(stranger, again.id, { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("tells the person when the Manager sends their cash straight to the Owner", async () => {
    const date = "2034-08-04";
    const person = on(await someone(), date);
    await collect(person, "3,000");
    const move = await createTransfer(on(manager, date), { from: person.actor.userId, to: "owner", amount: "3,000" });
    expect(move.message).toMatch(/₦3,000 from .* handed to the Owner/);
    expect((await toldAbout(person.actor.userId, "cash_moved", move.id))[0]).toContain("moved ₦3,000 of your cash");
  });

  it("warns that the bank was not checked before there is an opening balance", async () => {
    const move = await createTransfer(on(manager, "2034-08-05"), { from: "bank", to: "owner", amount: "1,000" });
    expect(move.message).toContain("no opening balance");
  });

  it("will not accept a handover from someone who has left, and says why", async () => {
    const date = "2034-08-06";
    const sender = on(await someone(), date);
    const receiver = on(await someone(), date);
    await collect(sender, "2,000");
    const handover = await createTransfer(sender, { from: sender.actor.userId, to: receiver.actor.userId, amount: "2,000" });
    await disable(sender);
    await expect(acceptTransfer(receiver, handover.id)).rejects.toThrow(/no longer staff, so this handover cannot be accepted/);
    await rejectTransfer(receiver, handover.id, { reason: "They left" });
  });

  it("will not reverse a move into the cash of someone who has left", async () => {
    const date = "2034-08-07";
    const person = on(await someone(), date);
    await collect(person, "3,000");
    const move = await createTransfer(person, { from: person.actor.userId, to: "owner", amount: "3,000" });
    expect(move.message).toContain("handed to the Owner");
    await disable(person);
    await expect(voidTransfer(on(manager, date), move.id, { reason: "Wrong" })).rejects.toThrow(/no longer staff/);
    expect(await expectedCash(db, person.actor.userId, date)).toBe(0);
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
  const ownBank = (date: string, before: string) =>
    db.execute(sql`
      SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS sum FROM bank_movements
      WHERE account = 'bank' AND source_type <> 'opening_balance' AND business_date >= ${date}::date AND business_date < ${before}::date
    `) as unknown as Promise<{ sum: number }[]>;

  it("refuses a month before there is an opening balance", async () => {
    await expect(recordReconciliation(on(manager, "2036-06-15"), { month: "2036-05", statement: "1" })).rejects.toThrow(
      /opening bank balance first/,
    );
  });

  it("sets the opening balance once, for the Manager only, and counts bank money only from its date", async () => {
    // Bank money from before the opening date is already in the opening figure.
    await db.insert(bankMovements).values({
      amountKobo: 1_000_000,
      businessDate: "2029-12-31",
      sourceType: "transfer_in",
      sourceId: randomUUID(),
      at: wat("2029-12-31"),
    });
    await expect(setOpeningBalance(assistant, { amount: "1", date: DAY })).rejects.toBeInstanceOf(ForbiddenError);
    await setOpeningBalance(on(manager, DAY), { amount: "100,000", date: "2030-01-01" });
    await expect(setOpeningBalance(on(manager, DAY), { amount: "1", date: "2030-01-01" })).rejects.toThrow(/already/);
    expect((await bankPosition(on(manager, DAY))).hasOpening).toBe(true);
    const [{ sum }] = (await ownBank("2030-01-01", "2030-01-02")) as [{ sum: number }];
    expect((await bookAt(db, "2030-01-02")).bookKobo).toBe(10_000_000 + sum);
    const book = await cashBook(manager, { from: "2029-12-01", to: "2030-01-01", whose: "bank" });
    expect(book.bank.openingKobo).toBe(0);
    expect(book.bank.closingKobo).toBe(10_000_000 + sum);
  });

  it("corrects the opening balance with a reason, minus allowed, and keeps the first figure", async () => {
    const ctx = on(manager, DAY);
    await expect(correctOpeningBalance(assistant, { amount: "1", date: "2030-01-01", reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(correctOpeningBalance(ctx, { amount: "-1,000.50", date: "2030-01-01" })).rejects.toMatchObject({
      fieldErrors: { reason: expect.anything() },
    });
    await correctOpeningBalance(ctx, { amount: "-1,000.50", date: "2030-01-01", reason: "Overdrawn on the statement" });
    const [{ sum }] = (await ownBank("2030-01-01", "2030-01-02")) as [{ sum: number }];
    expect((await bookAt(db, "2030-01-02")).bookKobo).toBe(-100_050 + sum);
    await correctOpeningBalance(ctx, { amount: "100,000", date: "2030-01-01", reason: "Typed the wrong figure" });
    const position = await bankPosition(ctx);
    expect(position.opening).toMatchObject({ amountKobo: 10_000_000, asOf: "2030-01-01", first: { amountKobo: 10_000_000 } });
    expect(position.opening!.corrections).toHaveLength(2);
    expect(position.canCorrectOpening).toBe(true);
    await expect(correctOpeningBalance(ctx, { amount: "100,000", date: "2030-01-01", reason: "x" })).rejects.toMatchObject({
      fieldErrors: { amount: expect.anything() },
    });
  });

  it("refuses a month before the opening month", async () => {
    await expect(recordReconciliation(on(manager, "2036-06-15"), { month: "2029-12", statement: "1" })).rejects.toMatchObject({
      fieldErrors: { month: expect.stringMatching(/books start/) },
    });
  });

  it("freezes the month-end figures and needs a reason for a difference", async () => {
    const ctx = on(manager, "2036-06-15");
    await expect(recordReconciliation(ctx, { month: "2036-06", statement: "1" })).rejects.toMatchObject({
      fieldErrors: { month: expect.anything() },
    });
    const { bookKobo: book } = await bookAt(db, "2036-06-01");
    const statement = ((book + 50_000) / 100).toFixed(2);
    await expect(recordReconciliation(ctx, { month: "2036-05", statement })).rejects.toMatchObject({
      fieldErrors: { explanation: expect.anything() },
    });
    await recordReconciliation(ctx, { month: "2036-05", statement, explanation: "Bank charges" });
    const { history } = await bankPosition(ctx);
    expect(history[0]).toMatchObject({ month: "2036-05-01", book, statement: book + 50_000, recorded_by: expect.any(String) });
    await expect(recordReconciliation(ctx, { month: "2036-05", statement, explanation: "x" })).rejects.toMatchObject({
      fieldErrors: { month: expect.anything() },
    });
  });

  it("takes an overdrawn statement figure", async () => {
    const ctx = on(manager, "2036-07-15");
    await recordReconciliation(ctx, { month: "2036-06", statement: "-2,500", explanation: "Overdrawn" });
    expect((await bankPosition(ctx)).history[0]).toMatchObject({ month: "2036-06-01", statement: -250_000 });
  });

  it("fixes the opening balance once a month is reconciled", async () => {
    await expect(
      correctOpeningBalance(on(manager, DAY), { amount: "5", date: "2030-01-01", reason: "Late fix" }),
    ).rejects.toThrow(/fixed/);
    expect((await bankPosition(on(manager, DAY))).canCorrectOpening).toBe(false);
  });

  it("corrects a statement figure once, with a reason, keeping the first", async () => {
    const ctx = on(manager, "2036-07-15");
    const row = (await bankPosition(ctx)).history.find((r) => r.month === "2036-05-01")!;
    await expect(correctReconciliation(ctx, row.id, { statement: (row.book / 100).toFixed(2) })).rejects.toMatchObject({
      fieldErrors: { reason: expect.anything() },
    });
    await expect(
      correctReconciliation(ctx, row.id, { statement: ((row.book + 1) / 100).toFixed(2), reason: "Typo" }),
    ).rejects.toMatchObject({ fieldErrors: { explanation: expect.anything() } });
    await correctReconciliation(ctx, row.id, { statement: (row.book / 100).toFixed(2), reason: "Typed an extra 500" });
    const fixed = (await bankPosition(ctx)).history.find((r) => r.id === row.id)!;
    expect(fixed).toMatchObject({ statement: row.book + 50_000, corrected_statement: row.book, correction_reason: "Typed an extra 500" });
    await expect(
      correctReconciliation(ctx, row.id, { statement: "1", explanation: "x", reason: "Again" }),
    ).rejects.toThrow(/once/);
  });

  it("suggests the first ended month not yet reconciled", async () => {
    expect((await bankPosition(on(manager, "2036-07-15"))).nextMonth).toBe("2030-01");
  });
});

describe("confirming against the statement", () => {
  const ref = async (ctx: Ctx) => (await payBy(on(ctx, DAY), "transfer", nextReference())) as { id: string; receiptNumber?: string };

  it("counts all waiting, finds by reference, and confirms several at once", async () => {
    const reference = nextReference();
    const mine = (await payBy(on(assistant, DAY), "pos", reference)) as { id: string };
    const other = await ref(assistant);
    const position = await bankPosition(manager, { q: reference.toLowerCase() });
    expect(position.toConfirm.map((row) => row.id)).toEqual([mine.id]);
    expect(position.matchedCount).toBe(1);
    expect(position.waitingCount).toBeGreaterThanOrEqual(2);
    expect((await bankPosition(manager, { q: "5,000" })).matchedCount).toBeGreaterThanOrEqual(2);

    await expect(confirmBankItems(manager, { items: [] })).rejects.toBeDefined();
    await expect(confirmBankItems(assistant, { items: [`payment:${mine.id}`] })).rejects.toThrow(/different person/);
    expect(await confirmBankItems(on(manager, DAY), { items: [`payment:${mine.id}`, `payment:${other.id}`] })).toEqual({ confirmed: 2 });
    // Already confirmed: skipped, not an error.
    expect(await confirmBankItems(on(manager, DAY), { items: [`payment:${mine.id}`] })).toEqual({ confirmed: 0 });
    const today = await bankPosition(on(manager, DAY));
    expect(today.confirmedToday.map((row) => row.id)).toEqual(expect.arrayContaining([mine.id, other.id]));
  });

  it("is all or none when one cannot be confirmed", async () => {
    const theirs = await ref(assistant);
    const own = await ref(manager);
    await expect(
      confirmBankItems(on(manager, DAY), { items: [`payment:${theirs.id}`, `payment:${own.id}`] }),
    ).rejects.toThrow(/different person/);
    const [row] = (await db.execute(bankRow(theirs.id))) as unknown as { confirmed_at: Date | null }[];
    expect(row!.confirmed_at).toBeNull();
  });

  it("undoes a confirmation the same day, only by whoever made it", async () => {
    const paid = await ref(assistant);
    await confirmBankPayment(on(manager, DAY), paid.id);
    await expect(undoBankConfirm(on(owner, DAY), { kind: "payment", id: paid.id })).rejects.toBeDefined();
    const other = await someone();
    await expect(undoBankConfirm(on(other, DAY), { kind: "payment", id: paid.id })).rejects.toThrow(/person who confirmed/);
    await expect(undoBankConfirm(on(manager, "2034-03-11"), { kind: "payment", id: paid.id })).rejects.toThrow(/today/);
    await undoBankConfirm(on(manager, DAY), { kind: "payment", id: paid.id });
    const [row] = (await db.execute(bankRow(paid.id))) as unknown as { confirmed_at: Date | null }[];
    expect(row!.confirmed_at).toBeNull();
    await expect(undoBankConfirm(on(manager, DAY), { kind: "payment", id: paid.id })).rejects.toThrow(/not been confirmed/);
  });
});

describe("the bank book", () => {
  it("refuses a move out of the bank beyond the book once there is an opening balance", async () => {
    const boss = on(manager, "2034-09-01");
    const { bookKobo } = await bankPosition(boss);
    const tooMuch = String(Math.max(Math.floor(bookKobo / 100), 0) + 1_000);
    await expect(createTransfer(boss, { from: "bank", to: "owner", amount: tooMuch })).rejects.toMatchObject({
      fieldErrors: { amount: expect.stringMatching(/The bank book shows only/) },
    });
  });
});

describe("cash close fixes", () => {
  const closeOf = async (ctx: Ctx, person: Ctx, date: string) =>
    (await cashDay(ctx, date)).find((row) => row.id === person.actor.userId)!;

  it("takes later cash off when an earlier day is closed, so nothing is counted twice", async () => {
    const boss = (await makeUser("manager")).ctx;
    await collect(on(boss, "2036-03-08"), "10,000"); // Sunday
    await collect(on(boss, "2036-03-10", "09:00"), "4,000"); // Monday morning
    const result = await closeCash(on(boss, "2036-03-10", "10:00"), {
      custodianId: boss.actor.userId,
      businessDate: "2036-03-09",
      counted: "14,000",
    });
    expect(result).toMatchObject({ countedKobo: 1_000_000, expectedKobo: 1_000_000, laterKobo: 400_000 });
    expect(await expectedCash(db, boss.actor.userId, "2036-03-10")).toBe(1_400_000);
    await expect(
      closeCash(on(boss, "2036-03-10", "10:00"), { custodianId: boss.actor.userId, businessDate: "2036-03-09", counted: "14,000" }),
    ).rejects.toThrow(/already been closed/);
  });

  it("refuses cash in hand below what came in after the day", async () => {
    const person = await someone();
    await collect(on(person, "2036-03-20"), "1,000");
    await collect(on(person, "2036-03-21"), "5,000");
    await expect(
      closeCash(on(person, "2036-03-21"), { custodianId: person.actor.userId, businessDate: "2036-03-20", counted: "3,000", explanation: "x" }),
    ).rejects.toMatchObject({ fieldErrors: { counted: expect.stringMatching(/came in after/) } });
  });

  it("corrects a mistyped count once, and the next day starts from the correction", async () => {
    const date = "2036-04-01";
    const person = on(await someone(), date, "18:00");
    await collect(person, "50,000");
    await closeCash(person, { custodianId: person.actor.userId, businessDate: date, counted: "5,000", explanation: "typo" });
    expect(await expectedCash(db, person.actor.userId, "2036-04-02")).toBe(500_000);

    const before = await closeOf(on(manager, date), person, date);
    expect(before).toMatchObject({ isLatestClose: true, correction: null });
    const stranger = on(await someone(), date);
    await expect(correctCashCount(stranger, before.close!.id, { counted: "50,000", reason: "x" })).rejects.toThrow(/own count/);
    await expect(correctCashCount(person, before.close!.id, { counted: "50,000", reason: "" })).rejects.toMatchObject({
      fieldErrors: { reason: expect.anything() },
    });
    await correctCashCount(person, before.close!.id, { counted: "50,000", reason: "Typed one zero too few" });

    const after = await closeOf(on(manager, date), person, date);
    expect(after.countedKobo).toBe(5_000_000);
    expect(after.correction).toMatchObject({ reason: "Typed one zero too few", countedKobo: 5_000_000 });
    expect(await expectedCash(db, person.actor.userId, "2036-04-02")).toBe(5_000_000);
    expect((await toldAbout(manager.actor.userId, "cash_count_corrected", before.close!.id))[0]).toContain("from ₦5,000 to ₦50,000");
    await expect(correctCashCount(on(manager, date), before.close!.id, { counted: "49,000", reason: "again" })).rejects.toThrow(
      /already been corrected/,
    );
  });

  it("cannot correct a count once a later count was made", async () => {
    const person = await someone();
    await collect(on(person, "2036-04-10"), "1,000");
    await closeCash(on(person, "2036-04-10", "18:00"), { custodianId: person.actor.userId, businessDate: "2036-04-10", counted: "1,000" });
    await closeCash(on(person, "2036-04-11", "18:00"), { custodianId: person.actor.userId, businessDate: "2036-04-11", counted: "1,000" });
    const first = await closeOf(on(manager, "2036-04-11"), person, "2036-04-10");
    expect(first.isLatestClose).toBe(false);
    await expect(correctCashCount(on(manager, "2036-04-11"), first.close!.id, { counted: "900", reason: "x" })).rejects.toThrow(
      /later count/,
    );
  });

  it("tells the holder when someone else counts their cash", async () => {
    const date = "2036-05-01";
    const person = on(await someone(), date);
    await collect(person, "2,000");
    await closeCash(on(manager, date, "18:00"), {
      custodianId: person.actor.userId,
      businessDate: date,
      counted: "1,500",
      explanation: "Counted while away",
    });
    const row = await closeOf(on(manager, date), person, date);
    expect((await toldAbout(person.actor.userId, "cash_counted", row.close!.id))[0]).toMatch(/counted your cash .*short by ₦500/);
  });

  it("keeps someone who has left on the page until the Manager counts and takes over their cash", async () => {
    const date = "2036-06-03";
    const boss = on((await makeUser("manager")).ctx, date, "18:00");
    const person = on(await someone(), "2036-06-01");
    await collect(person, "7,000");
    await disable(person);
    expect((await cashAlerts(db, date)).cashNotClosed.some((row) => row.id === person.actor.userId)).toBe(true);
    const card = await closeOf(boss, person, date);
    expect(card).toMatchObject({ active: false, expectedKobo: 700_000 });

    await expect(
      closeCash(boss, { custodianId: person.actor.userId, businessDate: "2036-06-02", counted: "7,000" }),
    ).rejects.toMatchObject({ fieldErrors: { businessDate: expect.stringMatching(/has left/) } });
    const result = await closeCash(boss, { custodianId: person.actor.userId, businessDate: date, counted: "7,000" });
    expect(result.takenOverKobo).toBe(700_000);
    expect(await expectedCash(db, boss.actor.userId, "2036-06-04")).toBe(700_000);
    expect(await expectedCash(db, person.actor.userId, "2036-06-04")).toBe(0);

    const later = on(boss, "2036-06-05");
    expect((await cashDay(later, "2036-06-05")).some((row) => row.id === person.actor.userId)).toBe(false);
    expect((await cashAlerts(db, "2036-06-05")).cashNotClosed.some((row) => row.id === person.actor.userId)).toBe(false);
  });
});

describe("payment fixes", () => {
  it("will not reverse cash the collector no longer holds, unless another source is chosen", async () => {
    const date = "2037-02-02";
    const person = on(await someone(), date);
    const payment = await collect(person, "5,000");
    await createTransfer(person, { from: person.actor.userId, to: "owner", amount: "5,000" });
    const boss = on(manager, date);
    await expect(reversePayment(boss, payment.id, { reason: "Wrong operator" })).rejects.toMatchObject({
      fieldErrors: { source: expect.stringMatching(/Only ₦0/) },
    });
    await reversePayment(boss, payment.id, { reason: "Wrong operator", source: "owner" });
    expect(await expectedCash(db, person.actor.userId, date)).toBe(0);
  });

  it("still takes a reversal from the collector when they hold the cash", async () => {
    const date = "2037-02-03";
    const person = on(await someone(), date);
    const payment = await collect(person, "3,000");
    await reversePayment(on(manager, date), payment.id, { reason: "Entered twice", source: "" });
    expect(await expectedCash(db, person.actor.userId, date)).toBe(0);
  });

  it("totals a day by entry day, and lists late entries apart", async () => {
    const date = "2037-02-10";
    const boss = on(manager, date);
    const operator = await makeOperator(manager);
    const today = await recordPayment(boss, { operatorId: operator.id, amount: "4,000", method: "cash", clientId: randomUUID() });
    const late = await recordPayment(boss, {
      operatorId: operator.id,
      amount: "2,000",
      method: "pos",
      reference: nextReference(),
      clientId: randomUUID(),
      backdateTo: "2037-02-08",
      backdateReason: "Paper receipt from the weekend",
    });
    const gone = await recordPayment(boss, { operatorId: operator.id, amount: "1,000", method: "cash", clientId: randomUUID() });
    await reversePayment(boss, gone.id, { reason: "Mistake" });

    const day = await listPayments(boss, date);
    const mine = (ids: { id: string }[]) => ids.filter((row) => [today.id, late.id, gone.id].includes(row.id)).map((row) => row.id);
    expect(mine(day.forDay).sort()).toEqual([today.id, gone.id].sort());
    expect(mine(day.lateEntries)).toEqual([late.id]);
    expect(day.byMethod.pos).toBeGreaterThanOrEqual(200_000);
    expect(day.reversedKobo).toBeGreaterThanOrEqual(100_000);

    const weekend = await listPayments(boss, "2037-02-08");
    expect(mine(weekend.forDay)).toEqual([late.id]);
    expect(weekend.forDay.find((row) => row.id === late.id)!.enteredOn).toBe(date);
  });
});

describe("cash book fixes", () => {
  it("shows moves apart, with what was held at the start and the end", async () => {
    const date = "2041-06-10";
    const person = on(await someone(), date);
    await collect(person, "8,000");
    // Held from an earlier day, so the start is not zero.
    const before = on(person, "2041-06-09");
    await collect(before, "2,000");
    await createTransfer(person, { from: person.actor.userId, to: "owner", amount: "3,000" });

    const book = await cashBook(on(manager, date), { from: date, to: date, whose: person.actor.userId });
    expect(book.cash).toMatchObject({
      openingKobo: 200_000,
      moneyIn: 800_000,
      moneyOut: 0,
      movedOut: 300_000,
      net: 500_000,
      closingKobo: 700_000,
    });
    expect(book.rows.every((row) => row.account === "cash")).toBe(true);

    const moves = await cashBook(on(manager, date), { from: date, to: date, whose: person.actor.userId, kind: "moves" });
    expect(moves.rows.map((row) => row.source_type)).toEqual(["transfer_out"]);
    expect(moves.rows[0]!.transfer_id).toBeTruthy();
    expect(moves.cash.closingKobo).toBe(700_000);
    expect(moves.narrowed).toBe(true);

    const owner = await cashBook(on(manager, date), { from: date, to: date, whose: "owner" });
    expect(owner.rows.every((row) => row.account === "owner")).toBe(true);
    expect(owner.owner.movedIn).toBeGreaterThanOrEqual(300_000);
  });
});
