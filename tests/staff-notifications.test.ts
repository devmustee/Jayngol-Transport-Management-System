import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { notificationRecipients, notifications, users } from "@/db/schema";
import { login } from "@/services/auth";
import type { Ctx } from "@/services/context";
import { recordExpense, sendBackAdvance } from "@/services/expenses";
import { closeCash } from "@/services/finance";
import { needsAction, staffBell } from "@/services/needs-action";
import { latestUrgent } from "@/services/notifications";
import { recordPayment, reversePayment } from "@/services/payments";
import { tellAwardsProposed } from "@/services/staff-events";
import { adjustStock, createStockItem } from "@/services/store";
import { createTransfer, rejectTransfer } from "@/services/transfers";
import { confirmViolation, proposeViolation } from "@/services/violations";
import { makeOperator, makeUser } from "./helpers";

const wat = (date: string, time = "12:00") => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time?: string): Ctx => ({ ...ctx, clock: () => wat(date, time) });

/** How many notices of a kind reached this person, optionally about one record. */
async function told(userId: string, kind: string, entityId?: string) {
  const rows = await db
    .select({ body: notifications.body })
    .from(notificationRecipients)
    .innerJoin(notifications, eq(notifications.id, notificationRecipients.notificationId))
    .where(
      and(
        eq(notificationRecipients.userId, userId),
        eq(notifications.kind, kind),
        entityId ? eq(notifications.entityId, entityId) : undefined,
      ),
    );
  return rows.map((row) => row.body);
}

let manager: Ctx;
let assistant: Ctx;
let owner: Ctx;
let supervisor: Ctx;
beforeAll(async () => {
  const [m, a, o, s] = await Promise.all([makeUser("manager"), makeUser("assistant_manager"), makeUser("owner"), makeUser("supervisor")]);
  manager = m.ctx;
  assistant = a.ctx;
  owner = o.ctx;
  supervisor = s.ctx;
});

const pay = async (ctx: Ctx, amount: string, extra: Record<string, unknown> = {}) => {
  const operator = await makeOperator(manager);
  const { id } = (await recordPayment(ctx, { operatorId: operator.id, amount, method: "cash", clientId: randomUUID(), ...extra }))!;
  return { id, operator };
};

describe("payments", () => {
  it("tells the Owner of a reversal, never the Manager who made it", async () => {
    const { id } = await pay(on(assistant, "2041-01-05"), "3,000");
    await reversePayment(on(manager, "2041-01-05"), id, { reason: "Wrong operator" });
    const [body] = await told(owner.actor.userId, "payment_reversed", id);
    expect(body).toContain("₦3,000");
    expect(body).toContain("Wrong operator");
    expect(await told(manager.actor.userId, "payment_reversed", id)).toHaveLength(0);
    expect(await told(assistant.actor.userId, "payment_reversed", id)).toHaveLength(0);
  });

  it("tells the Owner of a backdated payment", async () => {
    const { id } = await pay(on(manager, "2041-01-07"), "2,000", { backdateTo: "2041-01-05", backdateReason: "Paid on Sunday" });
    expect(await told(owner.actor.userId, "payment_backdated", id)).toHaveLength(1);
    expect(await told(manager.actor.userId, "payment_backdated", id)).toHaveLength(0);
  });
});

describe("offences", () => {
  it("asks the office to confirm, then tells the Supervisor how it was decided", async () => {
    const operator = await makeOperator(manager);
    const raised = await db.transaction((tx) =>
      proposeViolation(tx, on(supervisor, "2041-02-01"), {
        ruleCode: "R2",
        operatorId: operator.id,
        tricycleId: null,
        occurredOn: "2041-02-01",
        occurrenceKey: `R2:test:${randomUUID()}`,
      }),
    );
    const id = raised!.id;
    expect(await told(manager.actor.userId, "offence_raised", id)).toHaveLength(1);
    expect(await told(assistant.actor.userId, "offence_raised", id)).toHaveLength(1);
    expect(await told(supervisor.actor.userId, "offence_raised", id)).toHaveLength(0);
    expect(await told(owner.actor.userId, "offence_raised", id)).toHaveLength(0);

    await confirmViolation(on(manager, "2041-02-01"), id);
    expect((await told(supervisor.actor.userId, "offence_decided", id))[0]).toContain("confirmed");
    expect(await told(assistant.actor.userId, "offence_decided", id)).toHaveLength(0);
  });
});

describe("cash", () => {
  it("tells the receiver of a handover, and the sender when it is refused", async () => {
    const sender = (await makeUser("assistant_manager")).ctx;
    const receiver = (await makeUser("manager")).ctx;
    await pay(on(sender, "2041-03-01"), "8,000");
    const t = await createTransfer(on(sender, "2041-03-01"), { from: sender.actor.userId, to: receiver.actor.userId, amount: "5,000" });
    expect(await told(receiver.actor.userId, "handover_sent", t.id)).toHaveLength(1);
    expect(await told(manager.actor.userId, "handover_sent", t.id)).toHaveLength(0);

    await rejectTransfer(on(receiver, "2041-03-01"), t.id, { reason: "Count was ₦4,500" });
    expect((await told(sender.actor.userId, "handover_rejected", t.id))[0]).toContain("refused");
    expect(await told(receiver.actor.userId, "handover_rejected", t.id)).toHaveLength(0);
  });

  it("tells the Manager of a small difference, and the Owner only of a large one or the Manager's own", async () => {
    const closeIdOf = async (custodian: string, date: string) =>
      ((await db.execute(sql`SELECT id FROM cash_closes WHERE custodian_id = ${custodian} AND business_date = ${date}`)) as unknown as {
        id: string;
      }[])[0]!.id;

    const small = (await makeUser("assistant_manager")).ctx;
    await pay(on(small, "2041-03-02"), "10,000");
    await closeCash(on(small, "2041-03-02", "20:00"), { custodianId: small.actor.userId, businessDate: "2041-03-02", counted: "9,500", explanation: "Change" });
    const smallId = await closeIdOf(small.actor.userId, "2041-03-02");
    expect((await told(manager.actor.userId, "cash_difference", smallId))[0]).toContain("short by ₦500");
    expect(await told(owner.actor.userId, "cash_difference", smallId)).toHaveLength(0);

    const large = (await makeUser("assistant_manager")).ctx;
    await pay(on(large, "2041-03-02"), "10,000");
    await closeCash(on(large, "2041-03-02", "20:00"), { custodianId: large.actor.userId, businessDate: "2041-03-02", counted: "7,500", explanation: "Lost" });
    expect(await told(owner.actor.userId, "cash_difference", await closeIdOf(large.actor.userId, "2041-03-02"))).toHaveLength(1);

    const boss = (await makeUser("manager")).ctx;
    await pay(on(boss, "2041-03-03"), "10,000");
    await closeCash(on(boss, "2041-03-03", "20:00"), { custodianId: boss.actor.userId, businessDate: "2041-03-03", counted: "10,100", explanation: "Extra" });
    const bossId = await closeIdOf(boss.actor.userId, "2041-03-03");
    expect(await told(owner.actor.userId, "cash_difference", bossId)).toHaveLength(1);
    expect(await told(boss.actor.userId, "cash_difference", bossId)).toHaveLength(0);
    expect(await told(manager.actor.userId, "cash_difference", bossId)).toHaveLength(1);
  });

  it("says nothing when the count matches", async () => {
    const exact = (await makeUser("assistant_manager")).ctx;
    await pay(on(exact, "2041-03-04"), "4,000");
    await closeCash(on(exact, "2041-03-04", "20:00"), { custodianId: exact.actor.userId, businessDate: "2041-03-04", counted: "4,000" });
    const [row] = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM notifications n JOIN cash_closes c ON c.id::text = n.entity_id
      WHERE c.custodian_id = ${exact.actor.userId}`)) as unknown as { n: number }[];
    expect(row!.n).toBe(0);
  });
});

describe("expenses", () => {
  it("asks the Manager to countersign, and tells the recorder when it is sent back", async () => {
    const recorder = (await makeUser("assistant_manager")).ctx;
    await pay(on(recorder, "2041-04-01"), "6,000");
    const { id } = (await recordExpense(on(recorder, "2041-04-01"), {
      description: "Brake pads",
      category: "store_purchase",
      amount: "2,000",
      spentOn: "2041-04-01",
    }))!;
    expect((await told(manager.actor.userId, "expense_submitted", id))[0]).toContain("Brake pads");
    expect(await told(recorder.actor.userId, "expense_submitted", id)).toHaveLength(0);

    await sendBackAdvance(on(manager, "2041-04-01"), id, { reason: "No receipt" });
    expect((await told(recorder.actor.userId, "expense_sent_back", id))[0]).toContain("No receipt");
    expect(await told(assistant.actor.userId, "expense_sent_back", id)).toHaveLength(0);
  });
});

describe("store", () => {
  it("tells the office once, when stock falls to the reorder level", async () => {
    const item = (await createStockItem(manager, { name: `Bolt ${randomUUID()}`, unit: "piece", kind: "part", reorderLevel: "5", quantity: "10", unitCost: "100" }))!;
    await adjustStock(manager, item.id, { counted: "7", reason: "Count" });
    expect(await told(assistant.actor.userId, "stock_low", item.id)).toHaveLength(0);
    await adjustStock(on(manager, "2041-05-01"), item.id, { counted: "4", reason: "Count" });
    expect((await told(assistant.actor.userId, "stock_low", item.id))[0]).toContain("4 pieces left");
    expect(await told(manager.actor.userId, "stock_low", item.id)).toHaveLength(0);
    await adjustStock(on(manager, "2041-05-02"), item.id, { counted: "3", reason: "Count" });
    expect(await told(assistant.actor.userId, "stock_low", item.id)).toHaveLength(1);
  });
});

describe("logins", () => {
  it("tells the Manager when a login is locked", async () => {
    const { user } = await makeUser("supervisor");
    const clock = () => wat("2041-06-01");
    for (let i = 0; i < 5; i++) {
      await expect(login({ phone: user.phone, secret: "wrong-password", ip: `10.9.${i}.${Math.floor(Math.random() * 250)}` }, clock)).rejects.toThrow();
    }
    expect((await told(manager.actor.userId, "account_locked", user.id))[0]).toContain(user.name);
    expect(await told(user.id, "account_locked", user.id)).toHaveLength(0);
  });
});

describe("nightly job notices", () => {
  it("posts one awards notice per run, however often it runs", async () => {
    const run = "2041-07-01";
    await db.transaction((tx) => tellAwardsProposed(tx, wat(run), run, 3));
    await db.transaction((tx) => tellAwardsProposed(tx, wat(run), run, 3));
    const rows = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM notifications WHERE dedupe_key = ${`awards:${run}`}`)) as unknown as {
      n: number;
    }[];
    expect(rows[0]!.n).toBe(1);
    expect((await told(manager.actor.userId, "awards_proposed")).some((b) => b.startsWith("3 awards"))).toBe(true);
  });
});

describe("needs action", () => {
  it("shows each person only the work they can do", async () => {
    const receiver = (await makeUser("assistant_manager")).ctx;
    const sender = (await makeUser("assistant_manager")).ctx;
    await pay(on(sender, "2041-08-01"), "3,000");
    await createTransfer(on(sender, "2041-08-01"), { from: sender.actor.userId, to: receiver.actor.userId, amount: "1,000" });

    const keys = async (ctx: Ctx, time = "12:00") => (await needsAction(on(ctx, "2041-08-01", time))).map((i) => i.key);
    expect(await keys(receiver)).toContain("handovers");
    expect(await keys(sender)).not.toContain("handovers");
    const seen = await keys(supervisor);
    for (const key of ["offences", "countersign", "awards", "bank", "stock", "handovers", "job", "sacking"]) {
      expect(seen).not.toContain(key);
    }
    expect(await keys(owner)).toEqual([]);
  });

  it("shows inspections left only from 4 pm", async () => {
    // Other tests leave tricycles out with nobody inspecting them on this date.
    const count = (time: string) => needsAction(on(supervisor, "2041-08-02", time)).then((items) => items.some((i) => i.key === "inspections"));
    expect(await count("15:59")).toBe(false);
    const after = await count("16:00");
    const [row] = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM assignments a JOIN tricycles t ON t.id = a.tricycle_id
      WHERE a.returned_on IS NULL AND t.status = 'issued'`)) as unknown as { n: number }[];
    expect(after).toBe(row!.n > 0);
  });

  it("counts open work in the bell, and shows an urgent notice until it is opened", async () => {
    const receiver = (await makeUser("manager")).ctx;
    const sender = (await makeUser("assistant_manager")).ctx;
    await pay(on(sender, "2041-08-03"), "3,000");
    await createTransfer(on(sender, "2041-08-03"), { from: sender.actor.userId, to: receiver.actor.userId, amount: "1,000" });
    const bell = await staffBell(on(receiver, "2041-08-03"));
    expect(bell.actions).toBeGreaterThanOrEqual(1);

    const [locked] = await db.select().from(users).where(eq(users.id, (await makeUser("supervisor")).user.id));
    for (let i = 0; i < 5; i++) {
      await login({ phone: locked!.phone, secret: "nope-nope", ip: `10.8.${i}.${Math.floor(Math.random() * 250)}` }, () => wat("2041-08-03")).catch(() => null);
    }
    expect((await latestUrgent(on(receiver, "2041-08-03")))?.body).toContain(locked!.name);
  });
});
