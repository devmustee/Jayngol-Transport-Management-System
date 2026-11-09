import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  charges,
  dismissals,
  jobRuns,
  operators,
  payments,
  smsOutbox,
  tricycles,
  violations,
} from "@/db/schema";
import { addDays } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import { issueTricycle, returnTricycle, changeRate } from "@/services/assignments";
import type { Ctx } from "@/services/context";
import { runDailyJob } from "@/services/daily-job";
import { clearSackingAlert, confirmSacking, reinstateOperator } from "@/services/dismissals";
import { addNonCollectionDay, cashDay, closeCash, getStatement } from "@/services/finance";
import { recordPayment, reversePayment } from "@/services/payments";
import { deliverSms } from "@/services/sms";
import { listInStockTricycles } from "@/services/tricycles";
import { confirmViolation, rejectViolation, waiveViolation } from "@/services/violations";
import { makeOperator, makeTricycle, makeUser } from "./helpers";

const at = (date: string, time = "00:05") => new Date(`${date}T${time}:00+01:00`);
const clockAt = (date: string, time?: string) => () => at(date, time);

let manager: Ctx;
let assistant: Ctx;

beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  assistant = (await makeUser("assistant_manager")).ctx;
});

const on = (ctx: Ctx, date: string, time = "12:00"): Ctx => ({ ...ctx, clock: clockAt(date, time) });

/** Pretends the job last ran on this date, so the next run starts the day after. */
async function baseline(date: string) {
  await db.delete(jobRuns);
  await db.insert(jobRuns).values({ job: "daily", businessDate: date, finishedAt: at(date) });
}

const job = (date: string, time?: string) => runDailyJob(clockAt(date, time));

async function runDays(from: string, to: string) {
  for (let date = from; date <= to; date = addDays(date, 1)) await job(date);
}

/** An operator holding a tricycle since the day before the given date. */
async function operatorFrom(startDate: string, balance = "12000") {
  const t = await makeTricycle(manager);
  const o = await makeOperator(manager);
  const issued = addDays(startDate, -1);
  const assignment = (await issueTricycle(on(manager, issued), {
    tricycleId: t.id,
    operatorId: o.id,
    issuedOn: issued,
    dailyBalance: balance,
  }))!;
  return { operatorId: o.id, tricycleId: t.id, assignmentId: assignment.id };
}

const pay = (ctx: Ctx, operatorId: string, amount: string, extra: Record<string, unknown> = {}) =>
  recordPayment(ctx, {
    operatorId,
    amount,
    method: "transfer",
    clientId: randomUUID(),
    ...extra,
  });

const fines = (operatorId: string) =>
  db
    .select()
    .from(violations)
    .where(and(eq(violations.operatorId, operatorId), eq(violations.ruleCode, "R1")));

const alertsFor = (operatorId: string) =>
  db.select().from(dismissals).where(eq(dismissals.operatorId, operatorId));

describe("daily balance job", () => {
  it("charges from the day after issue at the rate in force", async () => {
    await baseline("2026-10-31");
    const { operatorId, assignmentId } = await operatorFrom("2026-11-02");
    await runDays("2026-11-01", "2026-11-03");
    const before = await getStatement(manager, operatorId);
    expect(before.unpaidDays).toBe(2); // 2 and 3 November, not the 1st (issue date)
    expect(before.balanceOwedKobo).toBe(2_400_000);

    await changeRate(on(manager, "2026-11-03"), assignmentId, {
      dailyBalance: "15000",
      effectiveFrom: "2026-11-04",
    });
    await job("2026-11-04");
    expect((await getStatement(manager, operatorId)).balanceOwedKobo).toBe(3_900_000);
  });

  it("changes nothing when run twice", async () => {
    await baseline("2026-11-01");
    const { operatorId } = await operatorFrom("2026-11-02");
    await job("2026-11-02");
    await job("2026-11-02");
    await job("2026-11-02", "09:00");
    expect((await getStatement(manager, operatorId)).unpaidDays).toBe(1);
  });

  it("catches up after being skipped for three days", async () => {
    await baseline("2026-11-01");
    const { operatorId } = await operatorFrom("2026-11-02");
    const processed = await job("2026-11-05");
    expect(processed).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
    expect((await getStatement(manager, operatorId)).unpaidDays).toBe(4);
    // 2 Nov fined on 4 Nov, 3 Nov fined on 5 Nov.
    expect(await fines(operatorId)).toHaveLength(2);
  });

  it("skips dates the Manager marks", async () => {
    await addNonCollectionDay(on(manager, "2026-12-01"), { businessDate: "2026-12-25", reason: "Christmas" });
    await baseline("2026-12-23");
    const { operatorId } = await operatorFrom("2026-12-24");
    await runDays("2026-12-24", "2026-12-26");
    const rows = await db
      .select()
      .from(charges)
      .where(and(eq(charges.operatorId, operatorId), eq(charges.type, "daily_balance")));
    expect(rows.map((r) => r.businessDate).sort()).toEqual(["2026-12-24", "2026-12-26"]);
  });
});

describe("2-day rule", () => {
  it("matches the agreed example: fines Wed, Thu, Fri, then a sacking alert", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");

    await runDays("2026-11-09", "2026-11-10");
    expect(await fines(operatorId)).toHaveLength(0); // Mon, Tue allowed

    await job("2026-11-11");
    expect(await fines(operatorId)).toHaveLength(1);
    await job("2026-11-12");
    expect(await fines(operatorId)).toHaveLength(2);
    await job("2026-11-13");
    const three = await fines(operatorId);
    expect(three.map((f) => f.occurredOn).sort()).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(await alertsFor(operatorId)).toHaveLength(0);

    await job("2026-11-14");
    const statement = await getStatement(manager, operatorId);
    expect(statement.penaltiesOwedKobo).toBe(900_000);
    expect(await fines(operatorId)).toHaveLength(3); // no fourth while waiting
    expect(await alertsFor(operatorId)).toMatchObject([{ status: "flagged", unpaidDays: 5 }]);

    await runDays("2026-11-15", "2026-11-17");
    expect(await fines(operatorId)).toHaveLength(3);
    expect(await alertsFor(operatorId)).toHaveLength(1);
  });

  it("accepts a payment at 23:59 on the deadline", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await job("2026-11-09");
    await pay(on(manager, "2026-11-10", "23:59"), operatorId, "12000");
    await runDays("2026-11-10", "2026-11-11");
    expect(await fines(operatorId)).toHaveLength(0);
  });

  it("does not let a payment at 00:01 clear the offence", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await runDays("2026-11-09", "2026-11-10");
    await pay(on(manager, "2026-11-11", "00:01"), operatorId, "24000");
    await job("2026-11-11", "00:05");
    expect(await fines(operatorId)).toHaveLength(1);
  });

  it("fines a part payment that leaves the day short", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await job("2026-11-09");
    await pay(on(manager, "2026-11-10", "09:00"), operatorId, "11,999.99");
    await runDays("2026-11-10", "2026-11-11");
    expect(await fines(operatorId)).toHaveLength(1);
  });

  it("uses an advance payment for later days, on time", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await job("2026-11-09");
    await pay(on(manager, "2026-11-09", "10:00"), operatorId, "36000");
    expect((await getStatement(manager, operatorId)).creditKobo).toBe(2_400_000);
    await runDays("2026-11-10", "2026-11-13");
    const statement = await getStatement(manager, operatorId);
    expect(statement.creditKobo).toBe(0);
    expect(statement.unpaidDays).toBe(2); // 12 and 13 Nov
    expect(await fines(operatorId)).toHaveLength(0);
  });

  it("fines the next night when a payment that prevented a fine is reversed", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await job("2026-11-09");
    const payment = (await pay(on(manager, "2026-11-10", "09:00"), operatorId, "12000"))!;
    await runDays("2026-11-10", "2026-11-11");
    await pay(on(manager, "2026-11-11", "09:00"), operatorId, "12000"); // Tuesday's, on time
    expect(await fines(operatorId)).toHaveLength(0);

    await reversePayment(on(manager, "2026-11-11"), payment.id, { reason: "Transfer bounced" });
    await job("2026-11-12");
    expect(await fines(operatorId)).toHaveLength(1);
  });
});

describe("payments", () => {
  it("saves once when the same form is submitted twice", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    const clientId = randomUUID();
    const input = { operatorId, amount: "12000", method: "transfer", clientId };
    const [a, b] = await Promise.all([
      recordPayment(on(manager, "2026-11-09"), input),
      recordPayment(on(manager, "2026-11-09"), input),
    ]);
    expect(a!.id).toBe(b!.id);
    expect(await db.select().from(payments).where(eq(payments.clientId, clientId))).toHaveLength(1);
  });

  it("takes penalties only when the cashier says so", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await runDays("2026-11-09", "2026-11-11");
    await pay(on(manager, "2026-11-11"), operatorId, "36000");
    let s = await getStatement(manager, operatorId);
    expect([s.unpaidDays, s.penaltiesOwedKobo]).toEqual([0, 300_000]);

    await pay(on(manager, "2026-11-11"), operatorId, "3000", { penaltyAmount: "3000" });
    s = await getStatement(manager, operatorId);
    expect(s.penaltiesOwedKobo).toBe(0);
    await expect(pay(on(manager, "2026-11-11"), operatorId, "3000", { penaltyAmount: "3000" })).rejects.toThrow();
  });

  it("requires a tricycle answer in person, and raises R8 for confirmation", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await job("2026-11-09");
    await expect(pay(on(assistant, "2026-11-09"), operatorId, "1000", { method: "cash" })).rejects.toMatchObject({
      fieldErrors: { tricyclePresent: expect.any(String) },
    });

    await pay(on(assistant, "2026-11-09"), operatorId, "1000", { method: "cash", tricyclePresent: "no" });
    await pay(on(assistant, "2026-11-09", "15:00"), operatorId, "1000", { method: "cash", tricyclePresent: "no" });
    const raised = await db
      .select()
      .from(violations)
      .where(and(eq(violations.operatorId, operatorId), eq(violations.ruleCode, "R8")));
    expect(raised).toMatchObject([{ status: "proposed", amountKobo: 300_000 }]);

    await expect(confirmViolation(assistant, raised[0]!.id)).rejects.toThrow(/Someone else/);
    expect((await getStatement(manager, operatorId)).penaltiesOwedKobo).toBe(0);
    await confirmViolation(manager, raised[0]!.id);
    expect((await getStatement(manager, operatorId)).penaltiesOwedKobo).toBe(300_000);

    await waiveViolation(manager, raised[0]!.id, { reason: "Tricycle was at the gate" });
    expect((await getStatement(manager, operatorId)).penaltiesOwedKobo).toBe(0);
  });

  it("does not ask about a tricycle on a remote transfer or for a sacked operator", async () => {
    await baseline("2026-11-08");
    const { operatorId, assignmentId } = await operatorFrom("2026-11-09");
    await pay(on(manager, "2026-11-09"), operatorId, "1000", { method: "transfer" });
    await returnTricycle(on(manager, "2026-11-09"), assignmentId, { returnedOn: "2026-11-09", reason: "other" });
    await expect(
      pay(on(manager, "2026-11-09"), operatorId, "1000", { method: "cash" }),
    ).resolves.toBeDefined();
  });

  it("lets a rejected R8 charge nothing", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await pay(on(assistant, "2026-11-09"), operatorId, "1000", { method: "pos", tricyclePresent: "no" });
    const [raised] = await db.select().from(violations).where(eq(violations.operatorId, operatorId));
    await rejectViolation(manager, raised!.id, { reason: "Entered in error" });
    expect((await getStatement(manager, operatorId)).penaltiesOwedKobo).toBe(0);
  });

  it("limits backdating and reversal to the Manager", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    const backdate = { backdateTo: "2026-11-08", backdateReason: "Book entry" };
    await expect(pay(on(assistant, "2026-11-09"), operatorId, "1000", backdate)).rejects.toThrow(ForbiddenError);
    const p = (await pay(on(manager, "2026-11-09"), operatorId, "1000", backdate))!;
    await expect(reversePayment(assistant, p.id, { reason: "x" })).rejects.toThrow(ForbiddenError);
  });

  it("keeps old debts with the old operator when a tricycle is reassigned", async () => {
    await baseline("2026-11-08");
    const first = await operatorFrom("2026-11-09");
    await runDays("2026-11-09", "2026-11-10");
    await returnTricycle(on(manager, "2026-11-10"), first.assignmentId, {
      returnedOn: "2026-11-10",
      reason: "reassigned",
    });
    const second = await makeOperator(manager);
    await issueTricycle(on(manager, "2026-11-10"), {
      tricycleId: first.tricycleId,
      operatorId: second.id,
      issuedOn: "2026-11-10",
      dailyBalance: "15000",
    });
    await job("2026-11-11");
    expect((await getStatement(manager, first.operatorId)).balanceOwedKobo).toBe(2_400_000);
    expect((await getStatement(manager, second.id)).balanceOwedKobo).toBe(1_500_000);
  });

  it("voids balances raised after a backdated return", async () => {
    await baseline("2026-11-08");
    const { operatorId, assignmentId } = await operatorFrom("2026-11-09");
    await runDays("2026-11-09", "2026-11-11");
    await returnTricycle(on(manager, "2026-11-11"), assignmentId, { returnedOn: "2026-11-09", reason: "other" });
    expect((await getStatement(manager, operatorId)).unpaidDays).toBe(1);
  });

  it("queues a receipt SMS and delivers through a provider", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await pay(on(manager, "2026-11-09"), operatorId, "12000");
    const [operator] = await db.select().from(operators).where(eq(operators.id, operatorId));
    const queued = await db.select().from(smsOutbox).where(eq(smsOutbox.toPhone, operator!.phone));
    expect(queued[0]).toMatchObject({ status: "pending", kind: "receipt" });
    expect(queued[0]!.body).toContain("₦12,000");

    const sent: string[] = [];
    await deliverSms({ send: async (to) => void sent.push(to) }, clockAt("2026-11-09"), 10_000);
    expect(sent).toContain(operator!.phone);
  });

  it("cannot be edited or deleted in the database", async () => {
    await expect(db.execute(sql`UPDATE payments SET amount_kobo = 1`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM charges`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM payment_allocations`)).rejects.toThrow();
  });
});

describe("sacking and appeal", () => {
  async function flagged() {
    await baseline("2026-11-08");
    const person = await operatorFrom("2026-11-09");
    await runDays("2026-11-09", "2026-11-14");
    const [alert] = await alertsFor(person.operatorId);
    expect(alert!.status).toBe("flagged");
    return { ...person, alertId: alert!.id };
  }

  it("never sacks by itself, and the Manager's decision takes the tricycle back", async () => {
    const { operatorId, tricycleId, alertId } = await flagged();
    let [op] = await db.select().from(operators).where(eq(operators.id, operatorId));
    expect(op!.status).toBe("active");

    await expect(confirmSacking(assistant, alertId, { returnedOn: "2026-11-14" })).rejects.toThrow(ForbiddenError);
    await confirmSacking(on(manager, "2026-11-14"), alertId, { returnedOn: "2026-11-14" });
    [op] = await db.select().from(operators).where(eq(operators.id, operatorId));
    expect(op!.status).toBe("sacked");
    const [t] = await db.select().from(tricycles).where(eq(tricycles.id, tricycleId));
    expect(t!.status).toBe("in_stock");

    const unpaid = (await getStatement(manager, operatorId)).unpaidDays;
    await runDays("2026-11-15", "2026-11-16");
    expect((await getStatement(manager, operatorId)).unpaidDays).toBe(unpaid); // no new balances
  });

  it("leaves the tricycle free for another operator", async () => {
    const { tricycleId, alertId } = await flagged();
    await confirmSacking(on(manager, "2026-11-14"), alertId, { returnedOn: "2026-11-14" });
    expect((await listInStockTricycles(manager)).map((t) => t.id)).toContain(tricycleId);

    const next = await makeOperator(manager);
    const issued = await issueTricycle(on(manager, "2026-11-15"), {
      tricycleId,
      operatorId: next.id,
      issuedOn: "2026-11-15",
      dailyBalance: "12000",
    });
    expect(issued).toBeDefined();
    const [t] = await db.select().from(tricycles).where(eq(tricycles.id, tricycleId));
    expect(t!.status).toBe("issued");
  });

  it("cannot reinstate until ₦9,000 and all balances are paid", async () => {
    const { operatorId, tricycleId, alertId } = await flagged();
    await confirmSacking(on(manager, "2026-11-14"), alertId, { returnedOn: "2026-11-14" });
    const statement = await getStatement(manager, operatorId);
    const form = { tricycleId, issuedOn: "2026-11-15", dailyBalance: "12000" };

    await expect(reinstateOperator(on(manager, "2026-11-15"), alertId, form)).rejects.toThrow(/must be paid/);
    await pay(on(manager, "2026-11-15"), operatorId, String(statement.balanceOwedKobo / 100));
    await expect(reinstateOperator(on(manager, "2026-11-15"), alertId, form)).rejects.toThrow(/must be paid/);
    await pay(on(manager, "2026-11-15"), operatorId, "9000", { penaltyAmount: "9000" });
    await reinstateOperator(on(manager, "2026-11-15"), alertId, form);

    const [op] = await db.select().from(operators).where(eq(operators.id, operatorId));
    expect(op!.status).toBe("active");
    expect(await fines(operatorId)).toHaveLength(3); // still count against awards
    await job("2026-11-15");
    expect(await fines(operatorId)).toHaveLength(3); // capped days are not fined later
  });

  it("closes the alert by itself when a payment on day 4 brings the count down", async () => {
    await baseline("2026-11-08");
    const { operatorId } = await operatorFrom("2026-11-09");
    await runDays("2026-11-09", "2026-11-12");
    await pay(on(manager, "2026-11-12"), operatorId, "12000");
    await runDays("2026-11-13", "2026-11-14");
    expect(await alertsFor(operatorId)).toHaveLength(0);
  });

  it("refuses a sacking if the operator has paid since the alert", async () => {
    const { operatorId, alertId } = await flagged();
    await pay(on(manager, "2026-11-14"), operatorId, "12000");
    await expect(confirmSacking(on(manager, "2026-11-14"), alertId, { returnedOn: "2026-11-14" })).rejects.toThrow(/paid since/);
  });

  it("does not ask again about the same debt after the Manager gives more time", async () => {
    const { operatorId, alertId } = await flagged();
    await clearSackingAlert(on(manager, "2026-11-14"), alertId, { reason: "Hospital bill" });
    await runDays("2026-11-15", "2026-11-17");
    expect(await alertsFor(operatorId)).toMatchObject([{ status: "resolved" }]);
  });
});

describe("cash close", () => {
  it("needs an explanation for a difference and closes once", async () => {
    await baseline("2026-11-08");
    const custodian = await makeUser("assistant_manager");
    const { operatorId } = await operatorFrom("2026-11-09");
    const ctx = on(custodian.ctx, "2026-11-09");
    await pay(ctx, operatorId, "12000", { method: "cash", tricyclePresent: "yes" });
    await pay(ctx, operatorId, "5000", { method: "transfer" }); // not physical cash

    const form = { custodianId: custodian.user.id, businessDate: "2026-11-09" };
    await expect(closeCash(ctx, { ...form, counted: "11000" })).rejects.toMatchObject({
      fieldErrors: { explanation: expect.any(String) },
    });
    await closeCash(ctx, { ...form, counted: "12000" });
    await expect(closeCash(ctx, { ...form, counted: "12000" })).rejects.toThrow(/already been closed/);

    const day = await cashDay(ctx, "2026-11-09");
    expect(day.find((d) => d.id === custodian.user.id)).toMatchObject({ expectedKobo: 1_200_000 });

    // Cash after closing counts towards the next day.
    await pay(on(custodian.ctx, "2026-11-09", "18:00"), operatorId, "1000", { method: "cash", tricyclePresent: "yes" });
    const next = await cashDay(ctx, "2026-11-10");
    expect(next.find((d) => d.id === custodian.user.id)).toMatchObject({ expectedKobo: 100_000 });
  });

  it("lets only the Manager close another person's cash", async () => {
    const other = await makeUser("assistant_manager");
    await expect(
      closeCash(on(assistant, "2026-11-09"), { custodianId: other.user.id, businessDate: "2026-11-09", counted: "0" }),
    ).rejects.toThrow(/your own/);
  });
});

describe("simulated month", () => {
  it("reconciles to the kobo", async () => {
    await baseline("2026-09-30");
    const custodian = await makeUser("assistant_manager");

    // A small repeatable pseudo-random generator, so failures can be replayed.
    let seed = 20261109;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };

    const people = await Promise.all(
      [10000, 12000, 15000, 12000, 10000, 15000].map(async (naira) => ({
        ...(await operatorFrom("2026-10-01", String(naira))),
        naira,
        charged: 0,
        paid: 0,
        cash: 0,
      })),
    );

    for (let i = 0; i < 31; i++) {
      const date = addDays("2026-10-01", i);
      await job(date);
      for (const p of people) {
        p.charged += p.naira;
        const roll = random();
        if (roll < 0.15) continue; // missed the day
        const amount =
          roll < 0.3
            ? Math.round(p.naira * 0.37 * 100) / 100 // part payment with kobo
            : roll < 0.45
              ? p.naira * 2 // catching up or paying ahead
              : p.naira;
        const isCash = random() < 0.6;
        await pay(on(custodian.ctx, date, "11:30"), p.operatorId, amount.toFixed(2), {
          method: isCash ? "cash" : "transfer",
          ...(isCash ? { tricyclePresent: "yes" } : {}),
        });
        p.paid += Math.round(amount * 100);
        if (isCash) p.cash += Math.round(amount * 100);
      }
    }

    for (const p of people) {
      const s = await getStatement(manager, p.operatorId);
      expect(s.balanceOwedKobo - s.creditKobo).toBe(p.charged * 100 - p.paid);
    }

    const rows = (await db.execute(sql`
      SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS total FROM cash_movements
      WHERE custodian_id = ${custodian.user.id}
    `)) as unknown as { total: number }[];
    expect(rows[0]!.total).toBe(people.reduce((sum, p) => sum + p.cash, 0));

    // Never more allocated to a charge than the charge is worth.
    const over = (await db.execute(sql`
      SELECT c.id FROM charges c
      JOIN effective_allocations e ON e.charge_id = c.id
      GROUP BY c.id HAVING SUM(e.amount_kobo) > c.amount_kobo
    `)) as unknown as unknown[];
    expect(over).toHaveLength(0);
  }, 60_000);
});
