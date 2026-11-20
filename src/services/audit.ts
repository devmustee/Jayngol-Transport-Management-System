import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { auditLog, users } from "@/db/schema";
import { AUDIT_ACTIONS, AUDIT_GROUPS } from "@/lib/audit-actions";
import { isUuid } from "@/lib/fields";
import { requirePermission, type Actor, type Ctx } from "./context";

type Entry = {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
};

/** Pass the same transaction as the change, so neither can happen alone. */
export async function recordAudit(
  exec: Executor,
  actor: Pick<Actor, "userId" | "role"> | null,
  at: Date,
  entry: Entry,
): Promise<void> {
  await exec.insert(auditLog).values({
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    occurredAt: at,
    ...entry,
  });
}

export const auditFrom = (ctx: Ctx, exec: Executor, entry: Entry) =>
  recordAudit(exec, ctx.actor, ctx.clock(), entry);

export const AUDIT_PER_PAGE = 50;

/** What the Audit log can be searched by. Anything not understood is ignored. */
export type AuditFilter = {
  /** A staff login's id, or "system" for work the app did by itself. */
  who?: string | null;
  /** One action, such as "payment.reverse", or "group:<n>" for a group of AUDIT_GROUPS. */
  what?: string | null;
  from?: string | null;
  to?: string | null;
  /** Words in the reason, the person's name, the record's id or the action's name. */
  q?: string | null;
  page?: number | null;
};

const isDate = (value: string | null | undefined): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
/** Midnight in Lagos, so a day means the business day. */
const lagosMidnight = (date: string) => sql`(${date}::date)::timestamp AT TIME ZONE 'Africa/Lagos'`;

function actionsFor(what: string | null | undefined): string[] | null {
  if (!what) return null;
  const group = /^group:(\d+)$/.exec(what);
  if (group) {
    const found = AUDIT_GROUPS[Number(group[1])];
    return found ? Object.keys(found.actions) : null;
  }
  return what in AUDIT_ACTIONS ? [what] : null;
}

/** The newest actions first, a page at a time, narrowed by any of the filters. */
export async function listAudit(ctx: Ctx, filter: AuditFilter = {}) {
  requirePermission(ctx, "audit.view");
  const conditions: SQL[] = [];
  const who = filter.who === "system" ? "system" : isUuid(filter.who ?? "") ? filter.who! : null;
  if (who === "system") conditions.push(isNull(auditLog.actorUserId));
  else if (who) conditions.push(eq(auditLog.actorUserId, who));
  const actions = actionsFor(filter.what);
  if (actions) conditions.push(inArray(auditLog.action, actions));
  let [from, to] = [isDate(filter.from) ? filter.from : null, isDate(filter.to) ? filter.to : null];
  if (from && to && from > to) [from, to] = [to, from];
  if (from) conditions.push(sql`${auditLog.occurredAt} >= ${lagosMidnight(from)}`);
  if (to) conditions.push(sql`${auditLog.occurredAt} < ${lagosMidnight(to)} + interval '1 day'`);
  const q = filter.q?.trim().slice(0, 60) || null;
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const words = q.toLowerCase();
    const named = Object.entries(AUDIT_ACTIONS)
      .filter(([, label]) => label.toLowerCase().includes(words))
      .map(([action]) => action);
    conditions.push(
      or(
        ilike(auditLog.reason, like),
        ilike(users.name, like),
        ilike(auditLog.entityId, like),
        ...(named.length ? [inArray(auditLog.action, named)] : []),
      )!,
    );
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const page = Math.max(1, Math.floor(filter.page ?? 1)) || 1;

  const [rows, [count], people] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        after: auditLog.after,
        reason: auditLog.reason,
        occurredAt: auditLog.occurredAt,
        actorName: users.name,
        actorRole: auditLog.actorRole,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(AUDIT_PER_PAGE)
      .offset((page - 1) * AUDIT_PER_PAGE),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(where),
    db.select({ id: users.id, name: users.name, status: users.status }).from(users).orderBy(asc(users.name)),
  ]);
  const total = count?.total ?? 0;
  return {
    rows,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / AUDIT_PER_PAGE)),
    people,
    /** The filters as understood, to fill the search form again. */
    filter: { who, what: actions ? filter.what! : null, from, to, q },
    filtered: conditions.length > 0,
  };
}
