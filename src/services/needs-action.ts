import { sql } from "drizzle-orm";
import { db } from "@/db";
import { businessDate, lagosTime } from "@/lib/clock";
import { formatDate } from "@/lib/format";
import { can, type Permission } from "@/lib/permissions";
import type { Severity } from "@/lib/notification-catalogue";
import { cashAlerts } from "./cash-book";
import type { Ctx } from "./context";
import { lastJobDate } from "./daily-job";
import { inboxSummary } from "./notifications";

/**
 * Work waiting for this person now (STAFF_NOTIFICATIONS_PLAN.md section 4.2).
 * It is worked out from the records every time and never stored, so it clears
 * the moment the work is done, by whoever does it.
 */
export type ActionItem = { key: string; title: string; count: number; link: string; severity: Severity };

/** Inspections left today are shown from this time, Lagos time. */
export const INSPECTION_REMINDER_FROM = "16:00";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function needsAction(ctx: Ctx): Promise<ActionItem[]> {
  const { role, userId } = ctx.actor;
  const has = (permission: Permission) => can(role, permission);
  const now = ctx.clock();
  const today = businessDate(now);
  const lateInDay = lagosTime(now) >= INSPECTION_REMINDER_FROM;

  // One round trip for every count; each is read only if the person can act on it.
  const [countsRows, cash, lastRun] = await Promise.all([
    db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM violations WHERE status = 'proposed' AND raised_by IS DISTINCT FROM ${userId}) AS offences,
        (SELECT COUNT(*)::int FROM dismissals WHERE status = 'flagged') AS sacking,
        (SELECT COUNT(*)::int FROM award_candidates WHERE status = 'proposed') AS awards,
        (SELECT COUNT(*)::int FROM money_transfers WHERE status = 'pending' AND to_custodian = ${userId}) AS handovers,
        (SELECT COUNT(*)::int FROM expense_advances WHERE status = 'submitted' AND collected_by <> ${userId}) AS to_countersign,
        (SELECT COUNT(*)::int FROM expense_advances
          WHERE status = 'open' AND collected_by = ${userId} AND return_note IS NOT NULL) AS sent_back,
        (SELECT COUNT(*)::int FROM stock_items i JOIN stock_balances b ON b.item_id = i.id
          WHERE i.reorder_level_milli > 0 AND b.quantity_milli <= i.reorder_level_milli) AS low_stock,
        (SELECT COUNT(*)::int FROM assignments a JOIN tricycles t ON t.id = a.tricycle_id
          WHERE a.returned_on IS NULL AND t.status = 'issued'
            AND NOT EXISTS (SELECT 1 FROM inspections i WHERE i.tricycle_id = t.id AND i.business_date = ${today}::date)
        ) AS uninspected
    `),
    has("cash.close") || has("bank.reconcile") ? cashAlerts(db, today) : null,
    has("user.manage") ? lastJobDate() : null,
  ]);
  const c = (countsRows as unknown as Record<string, number>[])[0] ?? {};
  const items: ActionItem[] = [];
  const add = (show: boolean, item: ActionItem) => {
    if (show && item.count > 0) items.push(item);
  };

  add(has("user.manage"), {
    key: "job",
    title: "The nightly job has not run today. Balances and fines may be out of date.",
    count: lastRun === today ? 0 : 1,
    link: "/dashboard",
    severity: "critical",
  });
  add(has("dismissal.decide"), {
    key: "sacking",
    title: `${plural(c.sacking ?? 0, "operator")} at 5 unpaid days, waiting for your decision`,
    count: c.sacking ?? 0,
    link: "/sacking",
    severity: "critical",
  });
  const mine = cash?.cashNotClosed.find((person) => person.id === userId);
  add(has("cash.close"), {
    key: "cash",
    title: mine
      ? mine.week
        ? `Your cash for the week of ${formatDate(mine.week.from)} is not closed`
        : `Your cash is not closed since ${formatDate(mine.since)}`
      : "",
    count: mine ? 1 : 0,
    link: mine ? `/cash?date=${mine.week ? mine.week.to : mine.since}` : "/cash",
    severity: "action",
  });
  add(has("money.transfer"), {
    key: "handovers",
    title: `${plural(c.handovers ?? 0, "cash handover")} waiting for you to accept`,
    count: c.handovers ?? 0,
    link: "/transfers",
    severity: "action",
  });
  add(has("violation.confirm"), {
    key: "offences",
    title: `${plural(c.offences ?? 0, "offence")} to confirm`,
    count: c.offences ?? 0,
    link: "/offences?status=proposed",
    severity: "action",
  });
  add(has("expense.countersign"), {
    key: "countersign",
    title: `${plural(c.to_countersign ?? 0, "expense")} to countersign`,
    count: c.to_countersign ?? 0,
    link: "/expenses",
    severity: "action",
  });
  add(has("expense.record"), {
    key: "sent-back",
    title: `${plural(c.sent_back ?? 0, "expense")} sent back to you to correct`,
    count: c.sent_back ?? 0,
    link: "/expenses",
    severity: "action",
  });
  add(has("award.approve"), {
    key: "awards",
    title: `${plural(c.awards ?? 0, "award")} to decide`,
    count: c.awards ?? 0,
    link: "/awards",
    severity: "action",
  });
  add(has("bank.reconcile"), {
    key: "bank",
    title: `${plural(cash?.bankToCheck ?? 0, "transfer or POS payment", "transfer and POS payments")} to confirm against the bank`,
    count: cash?.bankToCheck ?? 0,
    link: "/bank",
    severity: "action",
  });
  add(has("stock.move"), {
    key: "stock",
    title: `${plural(c.low_stock ?? 0, "store item")} at or below the reorder level`,
    count: c.low_stock ?? 0,
    link: "/store",
    severity: "action",
  });
  add(has("inspection.record") && lateInDay, {
    key: "inspections",
    title: `${plural(c.uninspected ?? 0, "tricycle")} not inspected yet today`,
    count: c.uninspected ?? 0,
    link: "/inspections",
    severity: "action",
  });
  return items;
}

/**
 * What the staff bell shows: unread updates plus open work. Each kind of work
 * counts once, so 130 bank payments to check do not bury everything else. It
 * turns red for anything urgent in either.
 */
export async function staffBell(ctx: Ctx) {
  const [summary, actions] = await Promise.all([inboxSummary(ctx), needsAction(ctx)]);
  return {
    ...summary,
    actions: actions.length,
    critical: summary.critical + actions.filter((item) => item.severity === "critical").length,
  };
}
