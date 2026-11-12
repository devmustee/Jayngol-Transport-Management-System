import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { notificationRecipients, notifications, users } from "@/db/schema";
import { copyOldNotices } from "@/db/copy-old-notices";
import { CATALOGUE, isAppLink } from "@/lib/notification-catalogue";
import { login, resolveSession } from "@/services/auth";
import type { Ctx } from "@/services/context";
import {
  audienceFor,
  inboxSummary,
  markAllRead,
  myInbox,
  notify,
  openNotification,
  PAGE_SIZE,
} from "@/services/notifications";
import { notifyOperators } from "@/services/notices";
import { fixedClock, makeOperator, makeUser, noticesFor, NOW, SECRET } from "./helpers";

const operatorCtx = (operatorId: string): Ctx => ({
  actor: { userId: randomUUID(), name: "Operator", role: "operator", operatorId },
  clock: () => new Date(),
});

let manager: Ctx;
beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
});

/** A staff notification addressed straight to some people, as Phase 2 events will be. */
async function tellStaff(userIds: string[], options: { severity?: "info" | "action" | "critical"; expiresAt?: Date; at?: Date } = {}) {
  const at = options.at ?? new Date();
  const [row] = await db
    .insert(notifications)
    .values({
      kind: "test",
      severity: options.severity ?? "action",
      title: "Test",
      body: "Something to look at",
      link: "/cash",
      expiresAt: options.expiresAt ?? null,
      createdAt: at,
    })
    .returning({ id: notifications.id });
  await db.insert(notificationRecipients).values(userIds.map((userId) => ({ notificationId: row!.id, userId, createdAt: at })));
  return row!.id;
}

const recipientOf = async (notificationId: string, userId: string) =>
  (await db.execute(sql`
    SELECT id FROM notification_recipients WHERE notification_id = ${notificationId} AND user_id = ${userId}
  `)) as unknown as { id: string }[];

describe("posting", () => {
  it("uses the catalogue's title, severity and link", async () => {
    const operator = await makeOperator(manager);
    await db.transaction((tx) => notify(tx, { kind: "late_fine", body: "Fined ₦500", at: new Date(), operatorIds: [operator.id] }));
    const [row] = await db
      .select()
      .from(notifications)
      .innerJoin(notificationRecipients, eq(notificationRecipients.notificationId, notifications.id))
      .where(eq(notificationRecipients.operatorId, operator.id));
    expect(row!.notifications).toMatchObject({
      title: CATALOGUE.late_fine.title,
      severity: "action",
      link: "/me",
      body: "Fined ₦500",
    });
  });

  it("posts a keyed event once, however often it is retried", async () => {
    const operator = await makeOperator(manager);
    const event = { kind: "milestone" as const, body: "First week", at: new Date(), operatorIds: [operator.id], dedupeKey: `t:${randomUUID()}` };
    expect(await db.transaction((tx) => notify(tx, event))).toBe(true);
    expect(await db.transaction((tx) => notify(tx, event))).toBe(false);
    expect(await noticesFor(operator.id, "milestone")).toHaveLength(1);
  });

  it("keeps each operator's once-only notices apart", async () => {
    const [a, b] = await Promise.all([makeOperator(manager), makeOperator(manager)]);
    const rows = [a, b].map((op) => ({ operatorId: op.id, kind: "milestone" as const, body: "Once", dedupeKey: "milestone:first_week" }));
    await db.transaction((tx) => notifyOperators(tx, new Date(), rows));
    await db.transaction((tx) => notifyOperators(tx, new Date(), rows));
    expect(await noticesFor(a.id, "milestone")).toHaveLength(1);
    expect(await noticesFor(b.id, "milestone")).toHaveLength(1);
  });

  it("saves nothing when the event itself fails", async () => {
    const operator = await makeOperator(manager);
    await expect(
      db.transaction(async (tx) => {
        await notify(tx, { kind: "receipt", body: "Paid", at: new Date(), operatorIds: [operator.id] });
        throw new Error("payment failed");
      }),
    ).rejects.toThrow("payment failed");
    expect(await noticesFor(operator.id)).toHaveLength(0);
  });

  it("refuses a kind that is not in the catalogue", async () => {
    await expect(
      db.transaction((tx) => notify(tx, { kind: "made_up" as "receipt", body: "x", at: new Date(), operatorIds: [] })),
    ).rejects.toThrow(/Unknown notification/);
  });

  it("reaches active staff by permission, never disabled accounts", async () => {
    const [owner, assistant, supervisor, gone] = await Promise.all([
      makeUser("owner"),
      makeUser("assistant_manager"),
      makeUser("supervisor"),
      makeUser("manager"),
    ]);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, gone.user.id));
    const entry = { severity: "action" as const, title: "Check", link: "/cash", audience: { permission: "cash.check" as const } };
    const everyone = [owner, assistant, supervisor, gone].map((person) => person.user.id);
    const { userIds } = await db.transaction((tx) => audienceFor(tx, entry, { userIds: everyone }));
    expect(userIds.sort()).toEqual([owner.user.id, assistant.user.id].sort());
  });
});

describe("each person's inbox", () => {
  it("shows people only their own notifications", async () => {
    const [a, b] = await Promise.all([makeUser("manager"), makeUser("assistant_manager")]);
    const id = await tellStaff([a.user.id]);
    expect((await myInbox(a.ctx)).items.map((item) => item.title)).toContain("Test");
    expect((await myInbox(b.ctx)).items).toHaveLength(0);
    const [mine] = await recipientOf(id, a.user.id);
    await expect(openNotification(b.ctx, mine!.id)).rejects.toThrow(/not found/);
    await markAllRead(b.ctx);
    expect((await inboxSummary(a.ctx)).unread).toBe(1);
  });

  it("marks one read when it is opened and says where it leads", async () => {
    const { ctx, user } = await makeUser("assistant_manager");
    const id = await tellStaff([user.id], { severity: "critical" });
    expect(await inboxSummary(ctx)).toMatchObject({ unread: 1, critical: 1 });
    const [mine] = await recipientOf(id, user.id);
    expect(await openNotification(ctx, mine!.id)).toEqual({ link: "/cash" });
    expect(await inboxSummary(ctx)).toMatchObject({ unread: 0, critical: 0 });
    expect((await myInbox(ctx, { unreadOnly: true })).items).toHaveLength(0);
    expect((await myInbox(ctx)).items[0]!.readAt).not.toBeNull();
  });

  it("gives operators their portal notices, newest first", async () => {
    const operator = await makeOperator(manager);
    const me = operatorCtx(operator.id);
    await db.transaction((tx) =>
      notifyOperators(tx, new Date(Date.now() - 60_000), [{ operatorId: operator.id, kind: "receipt", body: "Older" }]),
    );
    await db.transaction((tx) => notifyOperators(tx, new Date(), [{ operatorId: operator.id, kind: "receipt", body: "Newer" }]));
    expect((await myInbox(me)).items.map((item) => item.body)).toEqual(["Newer", "Older"]);
    await markAllRead(me);
    expect((await inboxSummary(me)).unread).toBe(0);
  });

  it("hides expired notifications", async () => {
    const { ctx, user } = await makeUser("manager");
    await tellStaff([user.id], { expiresAt: new Date(ctx.clock().getTime() - 1000) });
    expect((await myInbox(ctx)).items).toHaveLength(0);
    expect((await inboxSummary(ctx)).unread).toBe(0);
  });

  it("pages through a long inbox", async () => {
    const { ctx, user } = await makeUser("manager");
    const start = Date.now() - 100_000;
    for (let i = 0; i < PAGE_SIZE + 5; i++) await tellStaff([user.id], { at: new Date(start + i * 1000) });
    const first = await myInbox(ctx);
    const second = await myInbox(ctx, { page: 2 });
    expect(first).toMatchObject({ hasMore: true, page: 1 });
    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(second).toMatchObject({ hasMore: false });
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(PAGE_SIZE + 5);
  });
});

describe("the record of what people were told", () => {
  it("cannot be reworded", async () => {
    const { user } = await makeUser("manager");
    const id = await tellStaff([user.id]);
    await expect(db.update(notifications).set({ body: "Changed" }).where(eq(notifications.id, id))).rejects.toThrow();
  });

  it("can only be marked read or acknowledged, once", async () => {
    const [{ user }, other] = await Promise.all([makeUser("manager"), makeUser("manager")]);
    const id = await tellStaff([user.id]);
    const [mine] = await recipientOf(id, user.id);
    const row = eq(notificationRecipients.id, mine!.id);
    await expect(db.update(notificationRecipients).set({ userId: other.user.id }).where(row)).rejects.toThrow();
    await db.update(notificationRecipients).set({ readAt: new Date() }).where(row);
    await expect(db.update(notificationRecipients).set({ readAt: null }).where(row)).rejects.toThrow();
    await db.update(notificationRecipients).set({ acknowledgedAt: new Date() }).where(row);
  });

  it("must link inside the app", async () => {
    const save = (link: string) =>
      db.insert(notifications).values({ kind: "test", severity: "info", title: "x", body: "x", link, createdAt: new Date() });
    for (const bad of ["https://example.com", "//example.com", "/\\example.com", "/cash page", "/cash\n"]) {
      expect(isAppLink(bad), bad).toBe(false);
      await expect(save(bad), bad).rejects.toThrow();
    }
    for (const good of ["/", "/cash", "/me#my-balance", "/cash?date=2026-11-09"]) {
      expect(isAppLink(good), good).toBe(true);
      await expect(save(good)).resolves.toBeDefined();
    }
  });
});

describe("checking the bell", () => {
  it("does not keep an idle staff login alive", async () => {
    const { user } = await makeUser("supervisor");
    const { token } = await login({ phone: user.phone, secret: SECRET, ip: "203.0.113.77" }, fixedClock);
    const after = (ms: number) => () => new Date(NOW.getTime() + ms);
    // The bell checks quietly 11 hours in, then the person comes back 13 hours after that.
    expect(await resolveSession(token, after(11 * 3600_000), { touch: false })).not.toBeNull();
    expect(await resolveSession(token, after(24 * 3600_000))).toBeNull();
  });
});

describe("the catch-up copy after release", () => {
  it("copies notices the old code wrote, and their read state, once", async () => {
    const operator = await makeOperator(manager);
    const at = new Date();
    const [gap] = (await db.execute(sql`
      INSERT INTO operator_notices (operator_id, kind, body, created_at)
      VALUES (${operator.id}, 'receipt', 'Written by the old code', ${at.toISOString()}) RETURNING id
    `)) as unknown as { id: string }[];
    expect(await copyOldNotices(db)).toMatchObject({ copied: 1 });
    expect(await noticesFor(operator.id)).toMatchObject([{ kind: "receipt", body: "Written by the old code", readAt: null }]);

    await db.execute(sql`UPDATE operator_notices SET read_at = ${at.toISOString()} WHERE id = ${gap!.id}`);
    expect(await copyOldNotices(db)).toMatchObject({ copied: 0, markedRead: 1 });
    expect((await noticesFor(operator.id))[0]!.readAt).not.toBeNull();
    expect(await copyOldNotices(db)).toEqual({ copied: 0, markedRead: 0 });
  });
});
