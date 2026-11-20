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

type Handover = {
  id: string;
  fromCustodian: string | null;
  toCustodian: string | null;
  createdBy: string;
  amountKobo: number;
  fromPlace?: string;
};

/**
 * Who must agree to a handover. Normally the receiver. When the person
 * recording it is also the receiver, taking someone else's cash, the person
 * giving the cash must confirm instead, so nobody signs off their own claim.
 */
export const handoverConfirmer = (t: Pick<Handover, "fromCustodian" | "toCustodian" | "createdBy">) =>
  t.toCustodian === t.createdBy && t.fromCustodian !== t.createdBy ? t.fromCustodian : t.toCustodian;

/**
 * The person who must agree is asked. The person whose cash it is hears of it
 * too when someone else recorded the handover, so they can withdraw it.
 */
export async function tellHandoverSent(tx: Tx, ctx: Ctx, t: Handover) {
  const confirmer = handoverConfirmer(t);
  if (!confirmer || !t.toCustodian) return;
  const from = t.fromCustodian ? await userName(tx, t.fromCustodian) : ctx.actor.name;
  const to = await userName(tx, t.toCustodian);
  const amount = formatNaira(t.amountKobo);
  await notify(tx, {
    kind: "handover_sent",
    ...by(ctx),
    userIds: [confirmer],
    body:
      confirmer === t.toCustodian
        ? t.fromCustodian
          ? `${from} is handing you ${amount} in cash. Count it, then accept it.`
          : `${ctx.actor.name} is giving you ${amount} in cash from ${t.fromPlace === "bank" ? "the bank" : "the Owner"}. Count it, then accept it.`
        : `${ctx.actor.name} recorded that you gave ${to} ${amount} in cash. Confirm it if you did, or withdraw it.`,
    entity: { type: "money_transfer", id: t.id },
    dedupeKey: `transfer:${t.id}:sent`,
  });
  if (t.fromCustodian && t.fromCustodian !== confirmer && t.fromCustodian !== ctx.actor.userId) {
    await notify(tx, {
      kind: "cash_moved",
      ...by(ctx),
      userIds: [t.fromCustodian],
      body: `${ctx.actor.name} recorded a handover of ${amount} of your cash to ${to}. Withdraw it if this is wrong.`,
      entity: { type: "money_transfer", id: t.id },
      dedupeKey: `transfer:${t.id}:yours`,
    });
  }
}

/** The person who had to agree refused it, or someone withdrew it: everyone involved is told. */
export async function tellHandoverRejected(tx: Tx, ctx: Ctx, t: Handover, reason: string) {
  const refused = handoverConfirmer(t) === ctx.actor.userId;
  const people = [t.createdBy, t.fromCustodian, t.toCustodian].filter((id): id is string => id !== null);
  await notify(tx, {
    kind: "handover_rejected",
    ...by(ctx),
    userIds: [...new Set(people)],
    body: `${ctx.actor.name} ${refused ? "refused" : "withdrew"} the cash handover of ${formatNaira(t.amountKobo)}. Reason: ${reason}`,
    entity: { type: "money_transfer", id: t.id },
    dedupeKey: `transfer:${t.id}:rejected`,
  });
}

/** Someone else moved a person's cash at once, or reversed a move involving it. */
export async function tellCashMoved(
  tx: Tx,
  ctx: Ctx,
  t: Handover,
  how: { what: "moved" | "reversed"; fromLabel: string; toLabel: string; reason?: string },
) {
  const people = [t.fromCustodian, ...(how.what === "reversed" ? [t.toCustodian] : [])].filter(
    (id): id is string => id !== null && id !== ctx.actor.userId,
  );
  if (people.length === 0) return;
  const amount = formatNaira(t.amountKobo);
  await notify(tx, {
    kind: "cash_moved",
    ...by(ctx),
    userIds: [...new Set(people)],
    body:
      how.what === "moved"
        ? `${ctx.actor.name} moved ${amount} of your cash to ${how.toLabel}.`
        : `${ctx.actor.name} reversed the move of ${amount} from ${how.fromLabel} to ${how.toLabel}. Reason: ${how.reason ?? ""}`,
    entity: { type: "money_transfer", id: t.id },
    dedupeKey: `transfer:${t.id}:${how.what}`,
  });
}

/**
 * The Owner is read-only, so cannot accept a handover: instead they are told
 * when money is handed to them, when it leaves the bank or their money, and
 * when any move is reversed.
 */
export async function tellOwnerOfMove(
  tx: Tx,
  ctx: Ctx,
  t: Handover & { fromPlace: string; toPlace: string },
  how: { what: "moved" | "reversed"; fromLabel: string; toLabel: string; reason?: string },
) {
  const matters = how.what === "reversed" || t.toPlace === "owner" || t.fromPlace !== "cash";
  if (!matters) return;
  const amount = formatNaira(t.amountKobo);
  await notify(tx, {
    kind: "owner_money",
    ...by(ctx),
    body:
      how.what === "reversed"
        ? `${ctx.actor.name} reversed the move of ${amount} from ${how.fromLabel} to ${how.toLabel}. Reason: ${how.reason ?? ""}`
        : t.toPlace === "owner"
          ? `${ctx.actor.name} recorded ${amount} handed to you from ${how.fromLabel}. Tell the Manager at once if you did not get it.`
          : `${ctx.actor.name} moved ${amount} from ${how.fromLabel} to ${how.toLabel}.`,
    entity: { type: "money_transfer", id: t.id },
    dedupeKey: `transfer:${t.id}:owner:${how.what}`,
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

const resultText = (countedKobo: number, expectedKobo: number) => {
  const difference = countedKobo - expectedKobo;
  if (difference === 0) return "it matches";
  return `${difference < 0 ? "short" : "over"} by ${formatNaira(Math.abs(difference))}`;
};

/** Someone else counted a person's cash, or corrected their count: that person is told. */
export async function tellCashCounted(
  tx: Tx,
  ctx: Ctx,
  c: { id: string; custodianId: string; businessDate: string; expectedKobo: number; countedKobo: number },
  corrected?: { fromKobo: number; reason: string },
) {
  if (c.custodianId === ctx.actor.userId) return;
  await notify(tx, {
    kind: "cash_counted",
    ...by(ctx),
    userIds: [c.custodianId],
    body: corrected
      ? `${ctx.actor.name} corrected your cash count for ${formatDate(c.businessDate)} from ${formatNaira(corrected.fromKobo)} to ${formatNaira(c.countedKobo)}: ${resultText(c.countedKobo, c.expectedKobo)}. Reason: ${corrected.reason}`
      : `${ctx.actor.name} counted your cash for ${formatDate(c.businessDate)}: ${formatNaira(c.countedKobo)}, ${resultText(c.countedKobo, c.expectedKobo)}.`,
    link: `/cash?date=${c.businessDate}`,
    entity: { type: "cash_close", id: c.id },
    dedupeKey: `cash_close:${c.id}:${corrected ? "corrected" : "counted"}:holder`,
  });
}

/**
 * A count was corrected. The Manager is always told; the Owner too for a change
 * of the same size that would reach them as a difference, or any change to the
 * Manager's own count.
 */
export async function tellCashCorrected(
  tx: Tx,
  ctx: Ctx,
  c: { id: string; custodianId: string; businessDate: string; expectedKobo: number; fromKobo: number; toKobo: number; reason: string },
) {
  const [custodian] = await tx.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, c.custodianId));
  const toOwner = Math.abs(c.toKobo - c.fromKobo) >= OWNER_CASH_DIFFERENCE_KOBO || custodian?.role === "manager";
  const people = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, toOwner ? ["manager", "owner"] : ["manager"])));
  await notify(tx, {
    kind: "cash_count_corrected",
    ...by(ctx),
    userIds: people.map((p) => p.id),
    body: `${ctx.actor.name} corrected ${custodian?.name ? `${custodian.name}'s` : "a"} count for ${formatDate(c.businessDate)} from ${formatNaira(c.fromKobo)} to ${formatNaira(c.toKobo)}: ${resultText(c.toKobo, c.expectedKobo)}. Reason: ${c.reason}`,
    link: `/cash?date=${c.businessDate}`,
    entity: { type: "cash_close", id: c.id },
    dedupeKey: `cash_close:${c.id}:corrected`,
  });
  await tellCashCounted(tx, ctx, { ...c, countedKobo: c.toKobo }, { fromKobo: c.fromKobo, reason: c.reason });
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

export async function tellExpenseDecided(
  tx: Tx,
  ctx: Ctx,
  a: Advance,
  outcome: "sent_back" | "countersigned" | "rejected",
  reason?: string,
) {
  await notify(tx, {
    kind: outcome === "sent_back" ? "expense_sent_back" : outcome === "rejected" ? "expense_rejected" : "expense_countersigned",
    ...by(ctx),
    userIds: [a.collectedBy],
    body:
      outcome === "sent_back"
        ? `${ctx.actor.name} sent back "${a.purpose}" (${formatNaira(a.amountKobo)}). ${reason ?? ""}`.trim()
        : outcome === "rejected"
          ? `${ctx.actor.name} rejected "${a.purpose}" (${formatNaira(a.amountKobo)}). The money is back on the balance. ${reason ?? ""}`.trim()
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
