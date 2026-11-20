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

  await queueContributionNotices(tx, date, now);

  // On the 5th: working operators who have saved nothing this month. A reminder only.
  if (date.endsWith("-05")) {
    const monthStart = `${date.slice(0, 8)}01`;
    const idle = (await tx.execute(sql`
      SELECT o.id AS operator_id FROM operators o
      WHERE o.status = 'active'
        AND EXISTS (SELECT 1 FROM assignments a WHERE a.operator_id = o.id AND a.returned_on IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM operator_deposits d
          WHERE d.operator_id = o.id AND d.business_date >= ${monthStart}::date
            AND NOT EXISTS (SELECT 1 FROM operator_deposit_reversals r WHERE r.deposit_id = d.id))
    `)) as unknown as { operator_id: string }[];
    await notifyOperators(
      tx,
      now,
      idle.map((row) => ({
        operatorId: row.operator_id,
        kind: "saving_reminder",
        body: "Jayngol: You have not started saving this month. Bring your saving to the office; it is given back at the month end.",
        dedupeKey: `saving_reminder:${monthStart}`,
      })),
    );
  }
}

/**
 * Saturday: the weekly contribution is due tomorrow, for everyone who will be
 * charged and has not paid it ahead. Monday: a reminder for unpaid weeks.
 */
async function queueContributionNotices(tx: Tx, date: string, now: Date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 6) {
    const sunday = addDays(date, 1);
    const due = (await tx.execute(sql`
      WITH rate AS (
        SELECT amount_kobo FROM contribution_rates WHERE effective_from <= ${sunday}::date
        ORDER BY effective_from DESC LIMIT 1
      )
      SELECT DISTINCT o.id AS operator_id, (SELECT amount_kobo FROM rate)::float8 AS amount
      FROM operators o
      JOIN assignments a ON a.operator_id = o.id
      WHERE EXISTS (SELECT 1 FROM rate)
        AND o.status = 'active'
        AND a.issued_on < ${sunday}::date AND a.returned_on IS NULL
        AND (SELECT amount_kobo FROM rate) > COALESCE((
          SELECT SUM(p.amount_kobo - COALESCE((
                   SELECT SUM(x.amount_kobo) FROM payment_allocations x
                   JOIN valid_charges c ON c.id = x.charge_id
                   WHERE x.payment_id = p.id), 0))
          FROM payments p
          WHERE p.operator_id = o.id AND p.purpose = 'contribution'
            AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)), 0)
    `)) as unknown as { operator_id: string; amount: number }[];
    await notifyOperators(
      tx,
      now,
      due.map((row) => ({
        operatorId: row.operator_id,
        kind: "contribution_due",
        body: `Jayngol: Your weekly contribution of ${formatNaira(row.amount)} is due tomorrow, Sunday.`,
        dedupeKey: `contribution_due:${sunday}`,
      })),
    );
  }
  if (weekday === 1) {
    const owing = (await tx.execute(sql`
      SELECT c.operator_id, COUNT(*)::int AS weeks,
             SUM(c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                           WHERE e.charge_id = c.id), 0))::float8 AS owed
      FROM valid_charges c
      JOIN operators o ON o.id = c.operator_id
      WHERE c.type = 'contribution' AND c.business_date < ${date}::date
        AND o.status = 'active'
        AND c.amount_kobo > COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                      WHERE e.charge_id = c.id), 0)
      GROUP BY c.operator_id
    `)) as unknown as { operator_id: string; weeks: number; owed: number }[];
    await notifyOperators(
      tx,
      now,
      owing.map((row) => ({
        operatorId: row.operator_id,
        kind: "contribution_unpaid",
        body:
          row.weeks === 1
            ? `Jayngol: Your weekly contribution of ${formatNaira(row.owed)} for Sunday was not paid. Please pay it at the office.`
            : `Jayngol: You owe ${formatNaira(row.owed)} in weekly contributions for ${row.weeks} weeks. Please pay at the office.`,
        dedupeKey: `contribution_unpaid:${date}`,
      })),
    );
  }
}
