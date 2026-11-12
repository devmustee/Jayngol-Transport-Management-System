import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { notificationRecipients, notifications, users } from "@/db/schema";
import { DomainError } from "@/lib/errors";
import {
  CATALOGUE,
  isAppLink,
  isNotificationKind,
  type CatalogueEntry,
  type NotificationKind,
} from "@/lib/notification-catalogue";
import { isStaff, rolesWith } from "@/lib/permissions";
import type { Ctx } from "./context";

/**
 * The one way anything is announced to anyone (NOTIFICATION_PLAN.md). It runs
 * inside the caller's transaction, so the notice exists exactly when the event
 * does. The catalogue decides severity, title, link and audience.
 */
export type NotifyEvent = {
  kind: NotificationKind;
  body: string;
  at: Date;
  /** Operators to tell, for operator notices. */
  operatorIds?: string[];
  /** For staff notices: people to tell instead of everyone holding the catalogue's permission. */
  userIds?: string[];
  link?: string;
  entity?: { type: string; id: string };
  /** A notification with a key is posted once, however often the event is retried. */
  dedupeKey?: string;
  createdBy?: string | null;
};

const internalLink = (link: string | undefined, fallback: string) => (link && isAppLink(link) ? link : fallback);

/** Active staff who hold a permission, or only those of `userIds` who are active. */
async function staffFor(tx: Tx, permission: Parameters<typeof rolesWith>[0], userIds?: string[]) {
  const filters: SQL[] = [eq(users.status, "active"), inArray(users.role, rolesWith(permission))];
  if (userIds) {
    if (userIds.length === 0) return [];
    filters.push(inArray(users.id, userIds));
  }
  const rows = await tx.select({ id: users.id }).from(users).where(and(...filters));
  return rows.map((row) => row.id);
}

/** Exactly who an event reaches. Features never choose recipients themselves. */
export async function audienceFor(tx: Tx, entry: CatalogueEntry, event: Pick<NotifyEvent, "operatorIds" | "userIds">) {
  return entry.audience === "operator"
    ? { operatorIds: [...new Set(event.operatorIds ?? [])], userIds: [] as string[] }
    : { operatorIds: [] as string[], userIds: await staffFor(tx, entry.audience.permission, event.userIds) };
}

/** Posts several notifications at once. Returns how many were new. */
export async function notifyMany(tx: Tx, events: NotifyEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const planned = [];
  for (const event of events) {
    if (!isNotificationKind(event.kind)) throw new DomainError(`Unknown notification: ${event.kind}`);
    const entry: CatalogueEntry = CATALOGUE[event.kind];
    const recipients = await audienceFor(tx, entry, event);
    if (recipients.operatorIds.length + recipients.userIds.length === 0) continue;
    planned.push({ event, entry, recipients, id: randomUUID() });
  }
  if (planned.length === 0) return 0;

  const saved = await tx
    .insert(notifications)
    .values(
      planned.map(({ event, entry, id }) => ({
        id,
        kind: event.kind,
        severity: entry.severity,
        title: entry.title,
        body: event.body,
        link: internalLink(event.link, entry.link),
        entityType: event.entity?.type ?? null,
        entityId: event.entity?.id ?? null,
        dedupeKey: event.dedupeKey ?? null,
        createdBy: event.createdBy ?? null,
        createdAt: event.at,
      })),
    )
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  // A key already used means this event was posted before: tell nobody again.
  const isNew = new Set(saved.map((row) => row.id));
  const rows = planned
    .filter((plan) => isNew.has(plan.id))
    .flatMap(({ id, event, recipients }) => [
      ...recipients.operatorIds.map((operatorId) => ({ notificationId: id, operatorId, createdAt: event.at })),
      ...recipients.userIds.map((userId) => ({ notificationId: id, userId, createdAt: event.at })),
    ]);
  if (rows.length > 0) await tx.insert(notificationRecipients).values(rows);
  return isNew.size;
}

export const notify = async (tx: Tx, event: NotifyEvent) => (await notifyMany(tx, [event])) > 0;

/* ---------- Each person's own inbox ---------- */

/** The person comes only from the login session: staff by user, operators by operator. */
function me(ctx: Ctx): SQL {
  if (isStaff(ctx.actor.role)) return eq(notificationRecipients.userId, ctx.actor.userId);
  if (ctx.actor.role === "operator" && ctx.actor.operatorId) {
    return eq(notificationRecipients.operatorId, ctx.actor.operatorId);
  }
  throw new DomainError("This login has no inbox.");
}

const notExpired = (now: Date) => or(isNull(notifications.expiresAt), gt(notifications.expiresAt, now));

export const PAGE_SIZE = 30;

export type InboxItem = Awaited<ReturnType<typeof myInbox>>["items"][number];

export async function myInbox(ctx: Ctx, options: { unreadOnly?: boolean; page?: number } = {}) {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const now = ctx.clock();
  const where = and(me(ctx), notExpired(now), options.unreadOnly ? isNull(notificationRecipients.readAt) : undefined);
  const rows = await db
    .select({
      id: notificationRecipients.id,
      kind: notifications.kind,
      severity: notifications.severity,
      title: notifications.title,
      body: notifications.body,
      link: notifications.link,
      createdAt: notificationRecipients.createdAt,
      readAt: notificationRecipients.readAt,
    })
    .from(notificationRecipients)
    .innerJoin(notifications, eq(notifications.id, notificationRecipients.notificationId))
    .where(where)
    .orderBy(desc(notificationRecipients.createdAt), desc(notificationRecipients.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);
  return { items: rows.slice(0, PAGE_SIZE), page, hasMore: rows.length > PAGE_SIZE };
}

/** What the bell shows. Small, so checking it every minute costs almost nothing. */
export async function inboxSummary(ctx: Ctx) {
  const [row] = await db
    .select({
      unread: count(),
      critical: sql<number>`(COUNT(*) FILTER (WHERE ${notifications.severity} = 'critical'))::int`,
      latest: sql<string | null>`MAX(${notificationRecipients.createdAt})::text`,
    })
    .from(notificationRecipients)
    .innerJoin(notifications, eq(notifications.id, notificationRecipients.notificationId))
    .where(and(me(ctx), isNull(notificationRecipients.readAt), notExpired(ctx.clock())));
  return { unread: row?.unread ?? 0, critical: row?.critical ?? 0, latest: row?.latest ?? null };
}

/** Marks one of the person's own notifications read and says where it leads. */
export async function openNotification(ctx: Ctx, recipientId: string) {
  const [row] = await db
    .select({ readAt: notificationRecipients.readAt, link: notifications.link })
    .from(notificationRecipients)
    .innerJoin(notifications, eq(notifications.id, notificationRecipients.notificationId))
    .where(and(eq(notificationRecipients.id, recipientId), me(ctx)));
  if (!row) throw new DomainError("Notification not found.");
  if (!row.readAt) {
    await db
      .update(notificationRecipients)
      .set({ readAt: ctx.clock() })
      .where(and(eq(notificationRecipients.id, recipientId), me(ctx), isNull(notificationRecipients.readAt)));
  }
  return { link: row.link };
}

export async function markAllRead(ctx: Ctx) {
  await db
    .update(notificationRecipients)
    .set({ readAt: ctx.clock() })
    .where(and(me(ctx), isNull(notificationRecipients.readAt)));
}
