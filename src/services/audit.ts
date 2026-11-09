import { desc, eq } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { auditLog, users } from "@/db/schema";
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

export async function listAudit(ctx: Ctx, limit = 200) {
  requirePermission(ctx, "audit.view");
  return db
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
    .orderBy(desc(auditLog.id))
    .limit(limit);
}
