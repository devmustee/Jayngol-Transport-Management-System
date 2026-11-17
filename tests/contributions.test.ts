import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { charges, operators } from "@/db/schema";
import { addDays } from "@/lib/clock";
import { issueTricycle } from "@/services/assignments";
import type { Ctx } from "@/services/context";
import {
  contributionPosition,
  createWeeklyContributions,
  getMyContributions,
  listContributions,
  setContributionRate,
  waiveContribution,
} from "@/services/contributions";
import { processDay } from "@/services/daily-job";
import { openCharges, unallocatedPayments } from "@/services/ledger";
import { recordPayment, reversePayment } from "@/services/payments";
import { makeOperator, makeTricycle, makeUser, nextReference, noticesFor } from "./helpers";

/**
 * Contributions run on Sundays far from every other test's dates. Sunday
 * 4 January 2060 is the first week charged.
 */
const S0 = "2060-01-04";
const sunday = (n: number) => addDays(S0, 7 * n);
const at = (date: string, time = "10:00") => () => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: at(date, time) });

const raise = (date: string) => db.transaction((tx) => createWeeklyContributions(tx, date));

async function weeksOf(operatorId: string) {
  return (await db.execute(sql`
    SELECT cw.week_ending::text AS week, c.amount_kobo::float8 AS amount,
           EXISTS (SELECT 1 FROM charge_voids v WHERE v.charge_id = c.id) AS voided
    FROM contribution_weeks cw JOIN charges c ON c.id = cw.charge_id
    WHERE cw.operator_id = ${operatorId} ORDER BY cw.week_ending
  `)) as unknown as { week: string; amount: number; voided: boolean }[];
}

describe("weekly contributions", () => {
  let manager: Ctx;
  let assistant: Ctx;
  let holder: string;
  let sundayIssue: string;
  let sacked: string;
  let noTricycle: string;

  beforeAll(async () => {
    manager = on((await makeUser("manager")).ctx, "2059-12-30");
    assistant = on((await makeUser("assistant_manager")).ctx, "2059-12-30");

    const issue = async (issuedOn: string) => {
      const operator = await makeOperator(manager);
      const tricycle = await makeTricycle(manager);
      await issueTricycle(on(manager, issuedOn), { tricycleId: tricycle.id, operatorId: operator.id, issuedOn });
      return operator.id;
    };
    holder = await issue("2060-01-01");
    sundayIssue = await issue(S0);
    sacked = await issue("2060-01-01");
    await db.update(operators).set({ status: "sacked" }).where(eq(operators.id, sacked));
    noTricycle = (await makeOperator(manager)).id;

    await setContributionRate(manager, { effectiveFrom: S0, amount: "500" });
  });

  it("only starts on a Sunday after today", async () => {
    await expect(setContributionRate(manager, { effectiveFrom: "2060-01-05", amount: "500" })).rejects.toThrow();
    await expect(setContributionRate(on(manager, S0), { effectiveFrom: S0, amount: "500" })).rejects.toThrow();
    await expect(setContributionRate(assistant, { effectiveFrom: sunday(5), amount: "500" })).rejects.toThrow();
  });

  it("charges nothing before the start Sunday", async () => {
    await raise(addDays(S0, -7));
    expect(await weeksOf(holder)).toEqual([]);
  });

  it("raises one charge per holder on Sunday, even when run twice", async () => {
    await raise(S0);
    await raise(S0);
    await raise(addDays(S0, 1)); // Monday: never a contribution day.
    expect(await weeksOf(holder)).toEqual([{ week: S0, amount: 50_000, voided: false }]);
    // Issued on the Sunday itself: the first week is the next one.
    expect(await weeksOf(sundayIssue)).toEqual([]);
    expect(await weeksOf(sacked)).toEqual([]);
    expect(await weeksOf(noTricycle)).toEqual([]);
  });

  it("keeps the old amount for past weeks when the rate changes", async () => {
    await setContributionRate(on(manager, addDays(S0, 2)), { effectiveFrom: sunday(2), amount: "700" });
    await raise(sunday(1));
    await raise(sunday(2));
    expect((await weeksOf(holder)).map((w) => w.amount)).toEqual([50_000, 50_000, 70_000]);
    expect((await weeksOf(sundayIssue)).map((w) => w.week)).toEqual([sunday(1), sunday(2)]);
  });

  it("never mixes contribution money with balances", async () => {
    // An unpaid daily balance sits beside the contributions.
    const [balance] = await db
      .insert(charges)
      .values({ type: "daily_balance", operatorId: holder, amountKobo: 1_000_000, businessDate: sunday(2) })
      .returning({ id: charges.id });

    const day = sunday(2);
    const position = await contributionPosition(db, holder, day);
    expect(position.owedKobo).toBe(170_000);
    // Owed plus four weeks ahead at the coming rate.
    expect(position.maxKobo).toBe(170_000 + 4 * 70_000);
    await expect(
      recordPayment(on(assistant, day), {
        operatorId: holder, clientId: randomUUID(), amount: "4,600", method: "cash", purpose: "contribution",
      }),
    ).rejects.toMatchObject({ fieldErrors: { amount: expect.stringMatching(/At most/) } });

    const paid = await recordPayment(on(assistant, day), {
      operatorId: holder, clientId: randomUUID(), amount: "2,500", method: "cash", purpose: "contribution",
    });
    expect(await openCharges(db, holder, "contribution")).toEqual([]);
    const balances = await openCharges(db, holder, "daily_balance");
    expect(balances.find((c) => c.id === balance!.id)?.outstandingKobo).toBe(1_000_000);
    expect(await unallocatedPayments(db, holder)).toEqual([]);
    expect((await contributionPosition(db, holder, day)).creditKobo).toBe(80_000);

    // Next Sunday's week is paid from the contribution credit.
    await raise(sunday(3));
    expect(await openCharges(db, holder, "contribution")).toEqual([]);
    expect((await contributionPosition(db, holder, sunday(3))).creditKobo).toBe(10_000);

    // Balance money paid ahead never pays a contribution.
    await recordPayment(on(assistant, sunday(3)), {
      operatorId: holder, clientId: randomUUID(), amount: "15,000", method: "transfer", reference: nextReference(),
    });
    expect(await openCharges(db, holder, "daily_balance")).toEqual([]);
    const balanceCredit = (await unallocatedPayments(db, holder)).reduce((s, c) => s + c.free, 0);
    expect(balanceCredit).toBe(500_000);
    await raise(sunday(4));
    const open = await openCharges(db, holder, "contribution");
    expect(open.map((c) => c.outstandingKobo)).toEqual([60_000]);
    expect((await unallocatedPayments(db, holder)).reduce((s, c) => s + c.free, 0)).toBe(500_000);

    // Reversing the contribution payment brings its weeks back as owed.
    await reversePayment(on(manager, sunday(4)), paid.id, { reason: "Wrong operator" });
    const after = await contributionPosition(db, holder, sunday(4));
    expect(after.weeksOwed).toBe(5);
    expect(after.owedKobo).toBe(50_000 + 50_000 + 70_000 + 70_000 + 70_000);
    expect(after.creditKobo).toBe(0);
  });

  it("stops paying ahead at four weeks", async () => {
    const day = addDays(sunday(2), 1);
    const position = await contributionPosition(db, sundayIssue, day);
    // Weeks 1 to 4 are already raised by the tests before this one.
    expect(position.owedKobo).toBe(260_000);
    await recordPayment(on(assistant, day), {
      operatorId: sundayIssue, clientId: randomUUID(), amount: naira(position.maxKobo), method: "cash", purpose: "contribution",
    });
    expect((await contributionPosition(db, sundayIssue, day)).maxKobo).toBe(0);
    await expect(
      recordPayment(on(assistant, day), {
        operatorId: sundayIssue, clientId: randomUUID(), amount: "500", method: "cash", purpose: "contribution",
      }),
    ).rejects.toMatchObject({ fieldErrors: { amount: expect.stringMatching(/4 weeks ahead/) } });
  });

  it("waives an unpaid week with an audit entry, Manager only", async () => {
    const [week] = await openCharges(db, holder, "contribution");
    await expect(waiveContribution(assistant, week!.id, { reason: "Ill" })).rejects.toThrow();
    await waiveContribution(manager, week!.id, { reason: "In hospital that week" });
    expect((await weeksOf(holder)).find((w) => w.week === week!.businessDate)?.voided).toBe(true);
    const [audit] = (await db.execute(sql`
      SELECT reason FROM audit_log WHERE action = 'contribution.waive' AND entity_id = ${week!.id}
    `)) as unknown as { reason: string }[];
    expect(audit?.reason).toBe("In hospital that week");
    await expect(waiveContribution(manager, week!.id, { reason: "Again" })).rejects.toThrow(/already/);
  });

  it("never adds a late fine for an unpaid contribution", async () => {
    await processDay(sunday(5), at(sunday(5), "00:05"));
    await processDay(addDays(sunday(5), 1), at(addDays(sunday(5), 1), "00:05"));
    const [row] = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM late_evaluations l JOIN charges c ON c.id = l.charge_id
      WHERE c.type = 'contribution'
    `)) as unknown as { n: number }[];
    expect(row!.n).toBe(0);
    const [fines] = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM violations WHERE operator_id = ${holder}
    `)) as unknown as { n: number }[];
    expect(fines!.n).toBe(0);
    expect((await weeksOf(holder)).map((w) => w.week)).toContain(sunday(5));
  });

  it("reminds on Saturday and on Monday", async () => {
    const saturday = addDays(sunday(6), -1);
    await processDay(saturday, at(saturday, "00:05"));
    const due = await noticesFor(holder, "contribution_due");
    expect(due.length).toBe(1);
    expect(due[0]!.body).toContain("due tomorrow, Sunday");
    // Paid four weeks ahead, so nothing is due.
    expect(await noticesFor(sundayIssue, "contribution_due")).toEqual([]);

    await processDay(sunday(6), at(sunday(6), "00:05"));
    const monday = addDays(sunday(6), 1);
    await processDay(monday, at(monday, "00:05"));
    // One reminder each Monday: this one and the Monday after week 5.
    const unpaid = await noticesFor(holder, "contribution_unpaid");
    expect(unpaid.length).toBe(2);
    expect(unpaid[0]!.body).toMatch(/weeks/);
  });

  it("lists everyone and shows operators only their own weeks", async () => {
    const list = await listContributions(on(manager, sunday(6)), sunday(6));
    const row = list.operators.find((o) => o.operatorId === holder)!;
    expect(row.weekStatus).toBe("unpaid");
    expect(row.owedKobo).toBe(list.operators.find((o) => o.operatorId === holder)!.unpaid.reduce((s, u) => s + u.outstanding, 0));
    expect(list.operators.some((o) => o.operatorId === noTricycle)).toBe(false);

    const me: Ctx = {
      actor: { userId: (await makeUser("supervisor")).user.id, name: "Op", role: "operator", operatorId: sundayIssue },
      clock: at(sunday(6)),
    };
    const mine = await getMyContributions(me);
    expect(mine.owedKobo).toBe(0);
    expect(mine.weeks.every((w) => w.week_ending >= sunday(1))).toBe(true);
    expect(mine.totalPaidKobo).toBeGreaterThan(0);
    await expect(listContributions(me)).rejects.toThrow();
  });
});

const naira = (kobo: number) => String(kobo / 100);
