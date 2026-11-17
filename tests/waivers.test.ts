import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { charges, dismissals, violations } from "@/db/schema";
import { addDays } from "@/lib/clock";
import { issueTricycle } from "@/services/assignments";
import { balanceTotals } from "@/services/balance-periods";
import type { Ctx } from "@/services/context";
import { processDay } from "@/services/daily-job";
import { openCharges, unallocatedPayments, unpaidDaysAsOf } from "@/services/ledger";
import { recordPayment } from "@/services/payments";
import { listWaivers, reverseWaiver, waiveBalances, waiveFleetDay } from "@/services/waivers";
import { makeOperator, makeTricycle, makeUser, nextReference, noticesFor } from "./helpers";

/** Waivers run in 2062, away from every other test's dates. */
const at = (date: string, time = "10:00") => () => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: at(date, time) });

async function ownerNotices(entityId: string) {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'balance_waiver' AND entity_id = ${entityId}
  `)) as unknown as { n: number }[];
  return row!.n;
}

describe("balance waivers", () => {
  let manager: Ctx;
  let assistant: Ctx;
  let owner: Ctx;

  /**
   * An operator owing ₦10,000 for each given day (due the next day). No
   * tricycle is issued, so the night job in other test files has no extra
   * operator to charge.
   */
  async function owing(days: string[]) {
    const operator = await makeOperator(manager);
    const ids: string[] = [];
    for (const day of days) {
      const [row] = await db
        .insert(charges)
        .values({
          type: "daily_balance",
          operatorId: operator.id,
          amountKobo: 1_000_000,
          businessDate: day,
          dueOn: addDays(day, 1),
        })
        .returning({ id: charges.id });
      ids.push(row!.id);
    }
    return { operatorId: operator.id, ids };
  }

  beforeAll(async () => {
    manager = on((await makeUser("manager")).ctx, "2062-02-10");
    assistant = on((await makeUser("assistant_manager")).ctx, "2062-02-10");
    owner = on((await makeUser("owner")).ctx, "2062-02-10");
  });

  it("only lets the Manager waive", async () => {
    const op = await owing(["2062-02-01"]);
    const raw = { operatorId: op.operatorId, reason: "illness", note: "Ill", waiveFine: false, lines: [{ chargeId: op.ids[0]! }] };
    await expect(waiveBalances(assistant, raw)).rejects.toThrow();
    await expect(waiveBalances(owner, raw)).rejects.toThrow();
    expect((await openCharges(db, op.operatorId, "daily_balance")).length).toBe(1);
  });

  it("waives whole days, tells the operator and the Owner, and closes a sacking alert", async () => {
    const days = ["2062-02-01", "2062-02-02", "2062-02-03", "2062-02-04", "2062-02-05"];
    const op = await owing(days);
    await db.insert(dismissals).values({
      operatorId: op.operatorId, status: "flagged", unpaidDays: 5, flaggedOn: "2062-02-06", createdAt: new Date(),
    });
    const cashBefore = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM cash_movements`)) as unknown as { n: number }[];

    const { id } = await waiveBalances(manager, {
      operatorId: op.operatorId, reason: "illness", note: "In hospital", waiveFine: false,
      lines: [{ chargeId: op.ids[0]! }, { chargeId: op.ids[1]! }],
    });

    const open = await openCharges(db, op.operatorId, "daily_balance");
    expect(open.map((c) => c.businessDate)).toEqual(days.slice(2));
    expect((await unpaidDaysAsOf(db, "2062-02-10")).get(op.operatorId)?.days).toBe(3);
    const [alert] = await db.select().from(dismissals).where(eq(dismissals.operatorId, op.operatorId));
    expect(alert!.status).toBe("resolved");

    const notice = await noticesFor(op.operatorId, "balance_waived");
    expect(notice[0]!.body).toContain("₦20,000");
    expect(await ownerNotices(id)).toBe(1);

    const cashAfter = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM cash_movements`)) as unknown as { n: number }[];
    expect(cashAfter[0]!.n).toBe(cashBefore[0]!.n);
    const [audit] = (await db.execute(sql`
      SELECT reason FROM audit_log WHERE action = 'balance.waive' AND entity_id = ${id}
    `)) as unknown as { reason: string }[];
    expect(audit?.reason).toBe("In hospital");
  });

  it("waives part of a day, never more than is unpaid, and leaves paid money alone", async () => {
    const op = await owing(["2062-02-01"]);
    const paid = await recordPayment(on(assistant, "2062-02-03"), {
      operatorId: op.operatorId, clientId: randomUUID(), amount: "3,000", method: "transfer", reference: nextReference(),
    });
    const base = { operatorId: op.operatorId, reason: "breakdown", note: "Engine", waiveFine: false };

    await expect(
      waiveBalances(manager, { ...base, lines: [{ chargeId: op.ids[0]!, amount: "8,000" }] }),
    ).rejects.toMatchObject({ fieldErrors: { [`amount_${op.ids[0]}`]: expect.stringMatching(/Only ₦7,000/) } });

    await waiveBalances(manager, { ...base, lines: [{ chargeId: op.ids[0]!, amount: "4,000" }] });
    expect((await openCharges(db, op.operatorId, "daily_balance"))[0]!.outstandingKobo).toBe(300_000);

    await waiveBalances(manager, { ...base, lines: [{ chargeId: op.ids[0]! }] });
    expect(await openCharges(db, op.operatorId, "daily_balance")).toEqual([]);
    const [alloc] = (await db.execute(sql`
      SELECT SUM(amount_kobo)::float8 AS total FROM payment_allocations WHERE payment_id = ${paid.id}
    `)) as unknown as { total: number }[];
    expect(alloc!.total).toBe(300_000);
    expect(await unallocatedPayments(db, op.operatorId)).toEqual([]);

    // A day already waived cannot be waived again.
    await expect(waiveBalances(manager, { ...base, lines: [{ chargeId: op.ids[0]! }] })).rejects.toThrow(/already paid or waived/);
  });

  it("reverses a waiver, bringing back exactly what was waived", async () => {
    const op = await owing(["2062-02-01", "2062-02-02"]);
    const { id } = await waiveBalances(manager, {
      operatorId: op.operatorId, reason: "police", note: "Impounded", waiveFine: false,
      lines: [{ chargeId: op.ids[0]! }, { chargeId: op.ids[1]!, amount: "2,500" }],
    });
    expect((await openCharges(db, op.operatorId, "daily_balance")).reduce((s, c) => s + c.outstandingKobo, 0)).toBe(750_000);
    await expect(reverseWaiver(assistant, id, { reason: "No" })).rejects.toThrow();
    await reverseWaiver(manager, id, { reason: "Released the same day" });
    expect((await openCharges(db, op.operatorId, "daily_balance")).reduce((s, c) => s + c.outstandingKobo, 0)).toBe(2_000_000);
    await expect(reverseWaiver(manager, id, { reason: "Again" })).rejects.toThrow(/already been reversed/);
    expect((await listWaivers(manager)).find((w) => w.id === id)?.reversal?.reason).toBe("Released the same day");
  });

  it("reports due, waived, paid and owed that add up", async () => {
    const op = await owing(["2062-02-01", "2062-02-02", "2062-02-03"]);
    await recordPayment(on(assistant, "2062-02-04"), {
      operatorId: op.operatorId, clientId: randomUUID(), amount: "5,000", method: "transfer", reference: nextReference(),
    });
    await waiveBalances(manager, {
      operatorId: op.operatorId, reason: "other", note: "Agreed", waiveFine: false,
      lines: [{ chargeId: op.ids[1]! }, { chargeId: op.ids[2]!, amount: "1,000" }],
    });
    const totals = await balanceTotals(db, { from: "2062-02-01", to: "2062-02-03" }, op.operatorId);
    expect(totals.dueKobo + totals.waivedKobo).toBe(3_000_000);
    expect(totals.waivedKobo).toBe(1_100_000);
    expect(totals.paidKobo).toBe(500_000);
    expect(totals.owedKobo).toBe(totals.dueKobo - totals.paidKobo);
    expect(totals.owedKobo).toBe(1_400_000);
  });

  it("keeps a late day late for awards, but a waiver before the deadline lowers what was due", async () => {
    const op = await owing(["2062-02-01", "2062-02-02", "2062-02-03"]);
    // Before day 1's deadline (end of 2 Feb): whole day 1 and half of day 2.
    await waiveBalances(on(manager, "2062-02-02"), {
      operatorId: op.operatorId, reason: "illness", note: "Ill", waiveFine: false,
      lines: [{ chargeId: op.ids[0]! }, { chargeId: op.ids[1]!, amount: "5,000" }],
    });
    // Long after day 3's deadline.
    await waiveBalances(on(manager, "2062-02-20"), {
      operatorId: op.operatorId, reason: "illness", note: "Late paperwork", waiveFine: false,
      lines: [{ chargeId: op.ids[2]! }],
    });
    const rows = (await db.execute(sql`
      SELECT id, amount_kobo::float8 AS amount FROM award_balance_days WHERE operator_id = ${op.operatorId}
    `)) as unknown as { id: string; amount: number }[];
    const due = Object.fromEntries(rows.map((r) => [r.id, r.amount]));
    expect(due[op.ids[0]!]).toBeUndefined();
    expect(due[op.ids[1]!]).toBe(500_000);
    expect(due[op.ids[2]!]).toBe(1_000_000);
  });

  it("waives the late fine when ticked, and keeps it when not", async () => {
    const makeFined = async () => {
      const operator = await makeOperator(manager);
      const tricycle = await makeTricycle(manager);
      await issueTricycle(on(manager, "2062-04-01"), { tricycleId: tricycle.id, operatorId: operator.id, issuedOn: "2062-04-01" });
      return operator.id;
    };
    const ticked = await makeFined();
    const unticked = await makeFined();
    // The job raises 2 April's balance; on 4 April it is judged late and fined.
    for (const day of ["2062-04-02", "2062-04-03", "2062-04-04"]) await processDay(day, at(day, "00:05"));
    for (const operatorId of [ticked, unticked]) {
      expect((await openCharges(db, operatorId, "penalty")).length).toBe(1);
    }
    const waive = async (operatorId: string, waiveFine: boolean) => {
      const [day] = await openCharges(db, operatorId, "daily_balance");
      expect(day!.businessDate).toBe("2062-04-02");
      await waiveBalances(on(manager, "2062-04-04"), {
        operatorId, reason: "accident", note: "Crash", waiveFine, lines: [{ chargeId: day!.id }],
      });
    };
    await waive(ticked, true);
    await waive(unticked, false);
    expect(await openCharges(db, ticked, "penalty")).toEqual([]);
    const [fine] = await db.select().from(violations).where(eq(violations.operatorId, ticked));
    expect(fine!.status).toBe("waived");
    expect((await openCharges(db, unticked, "penalty")).length).toBe(1);
  });

  it("waives a past day for the whole fleet once", async () => {
    const day = "2062-05-04";
    const a = await owing([day]);
    const b = await owing([day, addDays(day, 1)]);
    const first = await waiveFleetDay(on(manager, "2062-05-06"), { businessDate: day, note: "Flood" });
    expect(first.operators).toBeGreaterThanOrEqual(2);
    expect(await openCharges(db, a.operatorId, "daily_balance")).toEqual([]);
    expect((await openCharges(db, b.operatorId, "daily_balance")).map((c) => c.businessDate)).toEqual([addDays(day, 1)]);
    const again = await waiveFleetDay(on(manager, "2062-05-06"), { businessDate: day, note: "Flood" });
    expect(again.operators).toBe(0);
    expect(await ownerNotices(day)).toBe(1);
    await expect(waiveFleetDay(on(manager, "2062-05-06"), { businessDate: "2062-05-09", note: "Future" })).rejects.toThrow();
  });

  it("lets nobody but staff see waivers", async () => {
    const me: Ctx = {
      actor: { userId: (await makeUser("supervisor")).user.id, name: "Op", role: "operator", operatorId: null },
      clock: at("2062-05-06"),
    };
    await expect(listWaivers(me)).rejects.toThrow();
  });

  it("never lets a waiver line point at something other than a daily balance", async () => {
    const op = await owing([]);
    const [fine] = await db
      .insert(charges)
      .values({ type: "penalty", operatorId: op.operatorId, amountKobo: 300_000, businessDate: "2062-02-01" })
      .returning({ id: charges.id });
    await expect(
      waiveBalances(manager, { operatorId: op.operatorId, reason: "other", note: "x", waiveFine: false, lines: [{ chargeId: fine!.id }] }),
    ).rejects.toThrow(/already paid or waived/);
  });
});
