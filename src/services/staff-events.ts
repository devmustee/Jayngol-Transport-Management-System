import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { operators, stockItems, users } from "@/db/schema";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { Ctx } from "./context";
import { notify } from "./notifications";

/**
 * What staff are told when something happens (STAFF_NOTIFICATIONS_PLAN.md
 * section 4.1). Each runs inside the event's own transaction, so the notice
 * exists exactly when the event does. The catalogue picks who is told, and the
 * person who caused the event is always left out.
 */

const operatorName = async (tx: Tx, id: string) =>
  (await tx.select({ name: operators.name }).from(operators).where(eq(operators.id, id)))[0]?.name ?? "An operator";

const userName = async (tx: Tx, id: string) =>
  (await tx.select({ name: users.name }).from(users).where(eq(users.id, id)))[0]?.name ?? "Someone";

/** From the person doing it: they are the one not told. */
const by = (ctx: Ctx) => ({ at: ctx.clock(), exceptUserId: ctx.actor.userId, createdBy: ctx.actor.userId });

/** A cash count off by this much or more also reaches the Owner. */
export const OWNER_CASH_DIFFERENCE_KOBO = 200_000;

export async function tellPaymentReversed(
  tx: Tx,
  ctx: Ctx,
  p: { id: string; operatorId: string; amountKobo: number; receiptNumber: string; reason: string },
) {
  await notify(tx, {
    kind: "payment_reversed",
    ...by(ctx),
    body: `${await operatorName(tx, p.operatorId)}: ${formatNaira(p.amountKobo)} (receipt ${p.receiptNumber}) reversed by ${ctx.actor.name}. Reason: ${p.reason}`,
    link: `/payments/${p.id}`,
    entity: { type: "payment", id: p.id },
    dedupeKey: `payment:${p.id}:reversed`,
  });
}

export async function tellPaymentBackdated(
  tx: Tx,
  ctx: Ctx,
  p: { id: string; operatorId: string; amountKobo: number; date: string; reason: string },
) {
  await notify(tx, {
    kind: "payment_backdated",
    ...by(ctx),
    body: `${await operatorName(tx, p.operatorId)}: ${formatNaira(p.amountKobo)} recorded by ${ctx.actor.name} as received on ${formatDate(p.date)}. Reason: ${p.reason}`,
    link: `/payments/${p.id}`,
    entity: { type: "payment", id: p.id },
    dedupeKey: `payment:${p.id}:backdated`,
  });
}

/** From the nightly job, so nobody is left out. */
export async function tellSackingFlagged(tx: Tx, now: Date, d: { id: string; operatorId: string; unpaidDays: number }) {
  await notify(tx, {
    kind: "sacking_flagged",
    at: now,
    body: `${await operatorName(tx, d.operatorId)} has ${d.unpaidDays} unpaid days. Decide what happens next.`,
    link: "/sacking",
    entity: { type: "dismissal", id: d.id },
    dedupeKey: `dismissal:${d.id}:flagged`,
  });
}

export async function tellOffenceRaised(
  tx: Tx,
  ctx: Ctx,
  v: { id: string; operatorId: string; rule: string; occurredOn: string },
) {
  await notify(tx, {
    kind: "offence_raised",
    ...by(ctx),
    body: `${await operatorName(tx, v.operatorId)}: ${v.rule} on ${formatDate(v.occurredOn)}, raised by ${ctx.actor.name}.`,
    entity: { type: "violation", id: v.id },
    dedupeKey: `violation:${v.id}:raised`,
  });
}

/** Tells the person who raised an offence how it was decided. */
export async function tellOffenceDecided(
  tx: Tx,
  ctx: Ctx,
  v: { id: string; operatorId: string; rule: string; occurredOn: string; raisedBy: string | null },
  outcome: "confirmed" | "rejected" | "waived",
  reason?: string,
) {
  if (!v.raisedBy) return;
  await notify(tx, {
    kind: "offence_decided",
    ...by(ctx),
    userIds: [v.raisedBy],
    body: `${await operatorName(tx, v.operatorId)}: ${v.rule} on ${formatDate(v.occurredOn)} was ${outcome} by ${ctx.actor.name}.${reason ? ` Reason: ${reason}` : ""}`,
    entity: { type: "violation", id: v.id },
    dedupeKey: `violation:${v.id}:${outcome}`,
  });
}

export async function tellHandoverSent(
  tx: Tx,
  ctx: Ctx,
  t: { id: string; fromCustodian: string | null; toCustodian: string | null; amountKobo: number },
) {
  if (!t.toCustodian) return;
  const from = t.fromCustodian ? await userName(tx, t.fromCustodian) : ctx.actor.name;
  await notify(tx, {
    kind: "handover_sent",
    ...by(ctx),
    userIds: [t.toCustodian],
    body: `${from} is handing you ${formatNaira(t.amountKobo)} in cash. Count it, then accept it.`,
    entity: { type: "money_transfer", id: t.id },
    dedupeKey: `transfer:${t.id}:sent`,
  });
}

/** The receiver refused it, or the sender withdrew it: the other side is told. */
export async function tellHandoverRejected(
  tx: Tx,
  ctx: Ctx,
  t: { id: string; toCustodian: string | null; createdBy: string; amountKobo: number },
  reason: string,
) {
  const refused = t.toCustodian === ctx.actor.userId;
  await notify(tx, {
    kind: "handover_rejected",
    ...by(ctx),
    userIds: [t.createdBy, ...(t.toCustodian ? [t.toCustodian] : [])],
    body: `${ctx.actor.name} ${refused ? "refused" : "withdrew"} the cash handover of ${formatNaira(t.amountKobo)}. Reason: ${reason}`,
    entity: { type: "money_transfer", id: t.id },
    dedupeKey: `transfer:${t.id}:rejected`,
  });
}

/**
 * The Manager hears of any difference. The Owner hears of ₦2,000 or more, and
 * of any difference in the Manager's own count.
 */
export async function tellCashDifference(
  tx: Tx,
  ctx: Ctx,
  c: { id: string; custodianId: string; businessDate: string; expectedKobo: number; countedKobo: number; explanation: string | null },
) {
  const difference = c.countedKobo - c.expectedKobo;
  if (difference === 0) return;
  const [custodian] = await tx.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, c.custodianId));
  const toOwner = Math.abs(difference) >= OWNER_CASH_DIFFERENCE_KOBO || custodian?.role === "manager";
  const people = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, toOwner ? ["manager", "owner"] : ["manager"])));
  await notify(tx, {
    kind: "cash_difference",
    ...by(ctx),
    userIds: people.map((p) => p.id),
    body: `${custodian?.name ?? "Cash"} was ${difference < 0 ? "short" : "over"} by ${formatNaira(Math.abs(difference))} on ${formatDate(c.businessDate)}.${c.explanation ? ` ${c.explanation}` : ""}`,
    link: `/cash?date=${c.businessDate}`,
    entity: { type: "cash_close", id: c.id },
    dedupeKey: `cash_close:${c.id}`,
  });
}

type Advance = { id: string; purpose: string; amountKobo: number; collectedBy: string };

/** Each send for countersigning is its own event, since a sent-back record comes again. */
export async function tellExpenseSubmitted(tx: Tx, ctx: Ctx, a: Advance) {
  await notify(tx, {
    kind: "expense_submitted",
    ...by(ctx),
    body: `${await userName(tx, a.collectedBy)}: ${a.purpose}, ${formatNaira(a.amountKobo)}.`,
    link: `/expenses/${a.id}`,
    entity: { type: "expense_advance", id: a.id },
    dedupeKey: `advance:${a.id}:submitted:${ctx.clock().getTime()}`,
  });
}

export async function tellExpenseDecided(tx: Tx, ctx: Ctx, a: Advance, outcome: "sent_back" | "countersigned", reason?: string) {
  await notify(tx, {
    kind: outcome === "sent_back" ? "expense_sent_back" : "expense_countersigned",
    ...by(ctx),
    userIds: [a.collectedBy],
    body:
      outcome === "sent_back"
        ? `${ctx.actor.name} sent back "${a.purpose}" (${formatNaira(a.amountKobo)}). ${reason ?? ""}`.trim()
        : `${ctx.actor.name} countersigned "${a.purpose}" (${formatNaira(a.amountKobo)}).`,
    link: `/expenses/${a.id}`,
    entity: { type: "expense_advance", id: a.id },
    dedupeKey: `advance:${a.id}:${outcome}:${ctx.clock().getTime()}`,
  });
}

/** One notice per nightly run, however many awards it proposed. */
export async function tellAwardsProposed(tx: Tx, now: Date, run: string, count: number) {
  if (count === 0) return;
  await notify(tx, {
    kind: "awards_proposed",
    at: now,
    body: `${count} award${count === 1 ? "" : "s"} proposed on ${formatDate(run)}. Approve or reject ${count === 1 ? "it" : "them"}.`,
    dedupeKey: `awards:${run}`,
  });
}

/** Only when a move takes an item from above its reorder level to at or below it. */
export async function tellIfStockFell(tx: Tx, ctx: Ctx, itemId: string, beforeMilli: number, afterMilli: number) {
  const [item] = await tx
    .select({ name: stockItems.name, unit: stockItems.unit, level: stockItems.reorderLevelMilli })
    .from(stockItems)
    .where(eq(stockItems.id, itemId));
  if (!item || item.level <= 0 || !(beforeMilli > item.level && afterMilli <= item.level)) return;
  const qty = (milli: number) => `${milli / 1000}`;
  await notify(tx, {
    kind: "stock_low",
    ...by(ctx),
    body: `${item.name}: ${qty(afterMilli)} ${item.unit}${afterMilli === 1000 ? "" : "s"} left, reorder level ${qty(item.level)}.`,
    link: `/store/${itemId}`,
    entity: { type: "stock_item", id: itemId },
    dedupeKey: `stock:${itemId}:low:${ctx.clock().getTime()}`,
  });
}

export async function tellAccountLocked(tx: Tx, now: Date, user: { id: string; name: string }, minutes: number) {
  await notify(tx, {
    kind: "account_locked",
    at: now,
    exceptUserId: user.id,
    body: `${user.name}'s login was locked after too many wrong passwords. It opens again in ${minutes} minutes, or reset the password now.`,
    entity: { type: "user", id: user.id },
    dedupeKey: `user:${user.id}:locked:${now.getTime()}`,
  });
}
