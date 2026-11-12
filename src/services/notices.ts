import { sql } from "drizzle-orm";
import type { Executor, Tx } from "@/db";
import { addDays } from "@/lib/clock";
import type { NotificationKind } from "@/lib/notification-catalogue";
import { DomainError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { NOTABLE_RUN_DAYS } from "@/lib/award-progress";
import { requirePermission, type Ctx } from "./context";
import { inboxSummary, markAllRead, myInbox, notifyMany } from "./notifications";

/**
 * One notice per operator, each with its own wording. A dedupe key is per
 * operator, so the same milestone can reach every operator once.
 */
export async function notifyOperators(
  tx: Tx,
  at: Date,
  rows: { operatorId: string; kind: NotificationKind; body: string; dedupeKey?: string }[],
) {
  await notifyMany(
    tx,
    rows.map((row) => ({
      kind: row.kind,
      body: row.body,
      at,
      operatorIds: [row.operatorId],
      dedupeKey: row.dedupeKey ? `op:${row.operatorId}:${row.dedupeKey}` : undefined,
    })),
  );
}

/** What each operator still has to pay by the end of `date`, to the kobo. */
export async function unpaidDueOn(exec: Executor, date: string, operatorId?: string) {
  const only = operatorId ? sql`AND o.id = ${operatorId}` : sql``;
  return (await exec.execute(sql`
    SELECT o.id AS operator_id, SUM(c.amount_kobo - COALESCE(p.paid, 0))::float8 AS owed
    FROM valid_charges c
    JOIN operators o ON o.id = c.operator_id AND o.status = 'active' ${only}
    LEFT JOIN LATERAL (
      SELECT SUM(e.amount_kobo) AS paid FROM effective_allocations e WHERE e.charge_id = c.id
    ) p ON TRUE
    WHERE c.type = 'daily_balance' AND c.due_on = ${date}::date
      AND c.amount_kobo > COALESCE(p.paid, 0)
    GROUP BY o.id
  `)) as unknown as { operator_id: string; owed: number }[];
}

function requireOperator(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  if (!ctx.actor.operatorId) throw new DomainError("This login is not linked to an operator.");
}

/** The portal's latest notices. The operator comes only from the login session. */
export async function getMyNotices(ctx: Ctx) {
  requireOperator(ctx);
  const [{ items }, { unread, critical }] = await Promise.all([myInbox(ctx), inboxSummary(ctx)]);
  return { items, unread, critical };
}

export async function markMyNoticesRead(ctx: Ctx) {
  requireOperator(ctx);
  await markAllRead(ctx);
}

/** Runs inside the nightly job, so one night can never post these twice. */
export async function queueDayNotices(tx: Tx, date: string, now: Date, runs: Map<string, number>) {
  const dueToday = await unpaidDueOn(tx, date);
  await notifyOperators(
    tx,
    now,
    dueToday.map((row) => {
      const run = runs.get(row.operator_id) ?? 0;
      const stake = run >= NOTABLE_RUN_DAYS ? `avoid a fine and keep your ${run}-day run` : "avoid a fine";
      return {
        operatorId: row.operator_id,
        kind: "balance_reminder",
        body: `${formatNaira(row.owed)} of your balance is due today. Pay today to ${stake}.`,
      };
    }),
  );

  const fined = (await tx.execute(sql`
    SELECT v.operator_id, SUM(v.amount_kobo)::float8 AS total
    FROM violations v
    WHERE v.rule_code = 'R1' AND v.status = 'confirmed' AND v.occurred_on = ${date}::date
    GROUP BY v.operator_id
  `)) as unknown as { operator_id: string; total: number }[];
  await notifyOperators(
    tx,
    now,
    fined.map((row) => ({
      operatorId: row.operator_id,
      kind: "late_fine",
      body: `You have been fined ${formatNaira(row.total)} for a late balance.`,
    })),
  );

  const tomorrow = addDays(date, 1);
  const services = (await tx.execute(sql`
    SELECT a.operator_id, t.code_number AS code
    FROM work_orders w
    JOIN tricycles t ON t.id = w.tricycle_id
    JOIN assignments a ON a.tricycle_id = t.id AND a.returned_on IS NULL
    WHERE w.type = 'service' AND w.status = 'scheduled' AND w.scheduled_for = ${tomorrow}::date
  `)) as unknown as { operator_id: string; code: string }[];
  await notifyOperators(
    tx,
    now,
    services.map((row) => ({
      operatorId: row.operator_id,
      kind: "service_reminder",
      body: `${row.code} is due for service on ${formatDate(tomorrow)}, between 8:00 and 10:00 am.`,
    })),
  );
}
