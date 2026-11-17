import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import {
  balanceWaiverLines,
  balanceWaiverReversals,
  balanceWaivers,
  dismissals,
  nonCollectionDays,
  operators,
  violations,
} from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField, idField, requiredText } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira, parseNairaToKobo } from "@/lib/money";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { SACKING_DAYS } from "./daily-job";
import { applyCredit, openCharges, unpaidDaysAsOf, voidCharge } from "./ledger";
import { notifyOperators } from "./notices";
import { notifyMany } from "./notifications";

/**
 * Balance waivers: the Manager forgives all or part of an operator's daily
 * balances. Nothing is edited or deleted. A waiver is its own record, the
 * `valid_charges` view subtracts it everywhere, and an undo is a reversal row.
 */

export const WAIVER_REASON_LABELS = {
  breakdown: "Breakdown",
  illness: "Illness",
  bereavement: "Bereavement",
  accident: "Accident",
  police: "Police",
  staff_mistake: "Staff mistake",
  no_balance_day: "No-balance day",
  other: "Other",
} as const;
export type WaiverReason = keyof typeof WAIVER_REASON_LABELS;

const CHOSEN_REASONS = ["breakdown", "illness", "bereavement", "accident", "police", "staff_mistake", "other"] as const;

const waiveSchema = z.object({
  operatorId: idField("operator"),
  reason: z.enum(CHOSEN_REASONS, "Choose a reason"),
  note: requiredText("Note", 500),
  waiveFine: z.boolean(),
  lines: z
    .array(z.object({ chargeId: z.uuid(), amount: z.string().optional() }))
    .min(1, "Tick at least one day to waive"),
});

const daysText = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** Unpaid days an operator can have waived, oldest first, with any late fine on them. */
export async function waiverForm(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "balance.waive");
  const [operator] = await db.select().from(operators).where(eq(operators.id, operatorId)).limit(1);
  if (!operator) return null;
  const days = (await db.execute(sql`
    SELECT c.id, c.business_date::text AS business_date, c.amount_kobo::float8 AS amount,
           (SELECT o.amount_kobo FROM charges o WHERE o.id = c.id)::float8 AS original,
           (c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                      WHERE e.charge_id = c.id), 0))::float8 AS outstanding,
           t.code_number,
           (SELECT COALESCE(SUM(pc.amount_kobo), 0) FROM violations v
              JOIN valid_charges pc ON pc.id = v.charge_id
             WHERE v.source_charge_id = c.id AND v.status = 'confirmed')::float8 AS fine
    FROM valid_charges c
    LEFT JOIN tricycles t ON t.id = c.tricycle_id
    WHERE c.operator_id = ${operatorId} AND c.type = 'daily_balance'
    ORDER BY c.business_date, c.created_at
  `)) as unknown as {
    id: string;
    business_date: string;
    amount: number;
    original: number;
    outstanding: number;
    code_number: string | null;
    fine: number;
  }[];
  return {
    operator,
    days: days
      .filter((d) => d.outstanding > 0)
      .map((d) => ({
        chargeId: d.id,
        date: d.business_date,
        dueKobo: d.amount,
        waivedBeforeKobo: d.original - d.amount,
        outstandingKobo: d.outstanding,
        tricycleCode: d.code_number,
        fineKobo: d.fine,
      })),
  };
}

/** Waives the confirmed late fines raised for these days. */
async function waiveLateFines(tx: Tx, chargeIds: string[], by: { userId: string; at: Date }, reason: string) {
  if (chargeIds.length === 0) return 0;
  const fines = await tx
    .select({ id: violations.id, chargeId: violations.chargeId, amountKobo: violations.amountKobo })
    .from(violations)
    .where(and(inArray(violations.sourceChargeId, chargeIds), eq(violations.status, "confirmed")))
    .for("update");
  for (const fine of fines) {
    if (fine.chargeId) await voidCharge(tx, fine.chargeId, by, reason);
    await tx
      .update(violations)
      .set({ status: "waived", decidedBy: by.userId, decidedAt: by.at, decisionReason: reason })
      .where(eq(violations.id, fine.id));
  }
  return fines.reduce((s, f) => s + f.amountKobo, 0);
}

/** A sacking alert closes once waived days bring the operator below the limit. */
async function recheckSacking(tx: Tx, operatorId: string, today: string) {
  const unpaid = await unpaidDaysAsOf(tx, today);
  if ((unpaid.get(operatorId)?.days ?? 0) >= SACKING_DAYS) return;
  await tx
    .update(dismissals)
    .set({ status: "resolved" })
    .where(and(eq(dismissals.operatorId, operatorId), eq(dismissals.status, "flagged")));
}

type Line = { chargeId: string; amountKobo: number; date: string };

/** Writes one waiver inside a transaction that already holds the operator's lock. */
async function writeWaiver(
  tx: Tx,
  ctx: Ctx,
  input: { operatorId: string; reason: WaiverReason; note: string; waiveFine: boolean; fleetDay?: string },
  lines: Line[],
) {
  const now = ctx.clock();
  const [waiver] = await tx
    .insert(balanceWaivers)
    .values({
      operatorId: input.operatorId,
      reason: input.reason,
      note: input.note,
      fineWaived: input.waiveFine,
      fleetDay: input.fleetDay ?? null,
      waivedBy: ctx.actor.userId,
      waivedAt: now,
    })
    .returning({ id: balanceWaivers.id });
  await tx.insert(balanceWaiverLines).values(
    lines.map((line) => ({ waiverId: waiver!.id, chargeId: line.chargeId, amountKobo: line.amountKobo })),
  );
  const fineKobo = input.waiveFine
    ? await waiveLateFines(tx, lines.map((l) => l.chargeId), { userId: ctx.actor.userId, at: now }, `Balance waived: ${input.note}`)
    : 0;
  await applyCredit(tx, input.operatorId);
  await recheckSacking(tx, input.operatorId, businessDate(now));

  const total = lines.reduce((s, l) => s + l.amountKobo, 0);
  const dates = lines.map((l) => l.date).sort();
  const when = dates.length === 1 ? formatDate(dates[0]!) : `${formatDate(dates[0]!)} to ${formatDate(dates.at(-1)!)}`;
  await notifyOperators(tx, now, [
    {
      operatorId: input.operatorId,
      kind: "balance_waived",
      body: `${formatNaira(total)} of your balance was waived (${daysText(lines.length)}, ${when}).${fineKobo > 0 ? ` The late fine of ${formatNaira(fineKobo)} was waived too.` : ""}`,
    },
  ]);
  await auditFrom(ctx, tx, {
    action: "balance.waive",
    entityType: "balance_waiver",
    entityId: waiver!.id,
    after: {
      operatorId: input.operatorId,
      amountKobo: total,
      days: dates,
      reason: input.reason,
      fineKobo,
    },
    reason: input.note,
  });
  return { id: waiver!.id, totalKobo: total, fineKobo, when, days: lines.length };
}

/** The Manager waives all or part of one operator's unpaid days. */
export async function waiveBalances(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "balance.waive");
  const input = parseInput(waiveSchema, raw);

  return db.transaction(async (tx) => {
    const [operator] = await tx
      .select({ id: operators.id, name: operators.name })
      .from(operators)
      .where(eq(operators.id, input.operatorId))
      .for("update");
    if (!operator) throw new DomainError("Operator not found.");

    // Amounts are checked against what is unpaid now, under the lock, so a
    // payment taken while the form was open is never waived away.
    const open = new Map((await openCharges(tx, operator.id, "daily_balance")).map((c) => [c.id, c]));
    const seen = new Set<string>();
    const lines: Line[] = [];
    for (const line of input.lines) {
      if (seen.has(line.chargeId)) continue;
      seen.add(line.chargeId);
      const charge = open.get(line.chargeId);
      const field = `amount_${line.chargeId}`;
      if (!charge) {
        throw new DomainError("One of the days is already paid or waived. Reload the page and try again.");
      }
      let amountKobo = charge.outstandingKobo;
      if (line.amount && line.amount.trim() !== "") {
        const parsed = parseNairaToKobo(line.amount);
        if (parsed === null || parsed <= 0) throw fieldError(field, "Enter an amount in naira");
        if (parsed > charge.outstandingKobo) {
          throw fieldError(field, `Only ${formatNaira(charge.outstandingKobo)} is unpaid on ${formatDate(charge.businessDate)}`);
        }
        amountKobo = parsed;
      }
      lines.push({ chargeId: charge.id, amountKobo, date: charge.businessDate });
    }

    const result = await writeWaiver(tx, ctx, input, lines);
    await notifyMany(tx, [
      {
        kind: "balance_waiver",
        body: `${ctx.actor.name} waived ${formatNaira(result.totalKobo)} for ${operator.name} (${daysText(result.days)}, ${result.when}): ${WAIVER_REASON_LABELS[input.reason].toLowerCase()}. ${input.note}`,
        at: ctx.clock(),
        link: `/waivers?show=${result.id}`,
        entity: { type: "balance_waiver", id: result.id },
        dedupeKey: `balance_waiver:${result.id}`,
        createdBy: ctx.actor.userId,
      },
    ]);
    return { id: result.id };
  });
}

/** Undoes a waiver: its days are owed again. A late fine waived with it stays waived. */
export async function reverseWaiver(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "balance.waive");
  const id = parseInput(idField("waiver"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  const now = ctx.clock();

  await db.transaction(async (tx) => {
    const [waiver] = await tx.select().from(balanceWaivers).where(eq(balanceWaivers.id, id));
    if (!waiver) throw new DomainError("Waiver not found.");
    const [operator] = await tx
      .select({ id: operators.id, name: operators.name })
      .from(operators)
      .where(eq(operators.id, waiver.operatorId))
      .for("update");
    const [already] = await tx
      .select({ id: balanceWaiverReversals.waiverId })
      .from(balanceWaiverReversals)
      .where(eq(balanceWaiverReversals.waiverId, id));
    if (already) throw new DomainError("This waiver has already been reversed.");

    await tx.insert(balanceWaiverReversals).values({ waiverId: id, reversedBy: ctx.actor.userId, reason, reversedAt: now });
    await applyCredit(tx, waiver.operatorId);

    const [total] = (await tx.execute(sql`
      SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS total FROM balance_waiver_lines WHERE waiver_id = ${id}
    `)) as unknown as { total: number }[];
    await notifyOperators(tx, now, [
      {
        operatorId: waiver.operatorId,
        kind: "balance_waived",
        body: `A waiver of ${formatNaira(total!.total)} on your balance was cancelled, so it is owed again. Reason: ${reason}`,
      },
    ]);
    await notifyMany(tx, [
      {
        kind: "balance_waiver",
        body: `${ctx.actor.name} cancelled a waiver of ${formatNaira(total!.total)} for ${operator!.name}. ${reason}`,
        at: now,
        link: `/waivers?show=${id}`,
        entity: { type: "balance_waiver", id },
        dedupeKey: `balance_waiver_reversed:${id}`,
        createdBy: ctx.actor.userId,
      },
    ]);
    await auditFrom(ctx, tx, {
      action: "balance.waive_reverse",
      entityType: "balance_waiver",
      entityId: id,
      before: { operatorId: waiver.operatorId, amountKobo: total!.total },
      reason,
    });
  });
}

/**
 * A day with no balance for the whole fleet, decided after it began (a flood,
 * a strike, a public order). The date becomes a no-balance day and every
 * balance raised for it is waived, with its late fine. Running it twice
 * changes nothing.
 */
export async function waiveFleetDay(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "balance.waive");
  const input = parseInput(z.object({ businessDate: dateField("Date"), note: requiredText("Reason", 200) }), raw);
  const today = businessDate(ctx.clock());
  if (input.businessDate > today) {
    throw fieldError("businessDate", "For a future date, add it as a no-balance day instead");
  }

  return db.transaction(async (tx) => {
    await tx
      .insert(nonCollectionDays)
      .values({ businessDate: input.businessDate, reason: input.note, createdBy: ctx.actor.userId })
      .onConflictDoNothing();

    const rows = (await tx.execute(sql`
      SELECT c.id, c.operator_id,
             (c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                        WHERE e.charge_id = c.id), 0))::float8 AS outstanding
      FROM valid_charges c
      WHERE c.type = 'daily_balance' AND c.business_date = ${input.businessDate}::date
      ORDER BY c.operator_id
    `)) as unknown as { id: string; operator_id: string; outstanding: number }[];
    const byOperator = new Map<string, Line[]>();
    for (const row of rows) {
      if (row.outstanding <= 0) continue;
      const list = byOperator.get(row.operator_id) ?? [];
      list.push({ chargeId: row.id, amountKobo: row.outstanding, date: input.businessDate });
      byOperator.set(row.operator_id, list);
    }

    let total = 0;
    for (const operatorId of [...byOperator.keys()].sort()) {
      await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, operatorId)).for("update");
      const result = await writeWaiver(
        tx,
        ctx,
        { operatorId, reason: "no_balance_day", note: input.note, waiveFine: true, fleetDay: input.businessDate },
        byOperator.get(operatorId)!,
      );
      total += result.totalKobo;
    }

    await auditFrom(ctx, tx, {
      action: "balance.waive_day",
      entityType: "calendar",
      entityId: input.businessDate,
      after: { operators: byOperator.size, amountKobo: total },
      reason: input.note,
    });
    if (byOperator.size > 0) {
      await notifyMany(tx, [
        {
          kind: "balance_waiver",
          body: `${ctx.actor.name} waived ${formatDate(input.businessDate)} for the whole fleet: ${formatNaira(total)} from ${byOperator.size} operator${byOperator.size === 1 ? "" : "s"}. ${input.note}`,
          at: ctx.clock(),
          link: `/waivers?day=${input.businessDate}`,
          entity: { type: "calendar", id: input.businessDate },
          dedupeKey: `balance_waiver_day:${input.businessDate}:${total}`,
          createdBy: ctx.actor.userId,
        },
      ]);
    }
    return { operators: byOperator.size, totalKobo: total };
  });
}

/** Every waiver, newest first, with its days, for the Waivers page. */
export async function listWaivers(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const rows = (await db.execute(sql`
    SELECT w.id, w.operator_id, o.name AS operator_name, o.phone, w.reason, w.note, w.fine_waived,
           w.fleet_day::text AS fleet_day, w.waived_at, u.name AS waived_by,
           r.reason AS reversal_reason, r.reversed_at, ru.name AS reversed_by,
           held.code_number, held.registration_number,
           (SELECT json_agg(json_build_object('date', c.business_date, 'amount', l.amount_kobo,
                                              'code', t.code_number) ORDER BY c.business_date)
            FROM balance_waiver_lines l JOIN charges c ON c.id = l.charge_id
            LEFT JOIN tricycles t ON t.id = c.tricycle_id
            WHERE l.waiver_id = w.id) AS lines
    FROM balance_waivers w
    JOIN operators o ON o.id = w.operator_id
    JOIN users u ON u.id = w.waived_by
    LEFT JOIN balance_waiver_reversals r ON r.waiver_id = w.id
    LEFT JOIN users ru ON ru.id = r.reversed_by
    LEFT JOIN LATERAL (
      SELECT t.code_number, t.registration_number
      FROM assignments a JOIN tricycles t ON t.id = a.tricycle_id
      WHERE a.operator_id = o.id AND a.returned_on IS NULL
      ORDER BY a.issued_on DESC LIMIT 1
    ) held ON true
    ORDER BY w.waived_at DESC
    LIMIT 500
  `)) as unknown as {
    id: string;
    operator_id: string;
    operator_name: string;
    phone: string;
    reason: WaiverReason;
    note: string;
    fine_waived: boolean;
    fleet_day: string | null;
    waived_at: Date | string;
    waived_by: string;
    reversal_reason: string | null;
    reversed_at: Date | string | null;
    reversed_by: string | null;
    code_number: string | null;
    registration_number: string | null;
    lines: { date: string; amount: number; code: string | null }[] | null;
  }[];
  return rows.map((row) => {
    const lines = (row.lines ?? []).map((l) => ({ date: String(l.date).slice(0, 10), amountKobo: Number(l.amount), code: l.code }));
    return {
      id: row.id,
      operatorId: row.operator_id,
      operatorName: row.operator_name,
      phone: row.phone,
      tricycle: row.code_number ? { code: row.code_number, registration: row.registration_number! } : null,
      reason: row.reason,
      note: row.note,
      fineWaived: row.fine_waived,
      fleetDay: row.fleet_day,
      waivedAt: new Date(row.waived_at),
      waivedBy: row.waived_by,
      reversal: row.reversed_at
        ? { reason: row.reversal_reason!, at: new Date(row.reversed_at), by: row.reversed_by! }
        : null,
      lines,
      totalKobo: lines.reduce((s, l) => s + l.amountKobo, 0),
    };
  });
}

/** Waived amounts on one operator's days, for the statement. */
export async function waivedOnDays(operatorId: string) {
  const rows = (await db.execute(sql`
    SELECT e.charge_id, SUM(e.amount_kobo)::float8 AS waived
    FROM effective_waivers e WHERE e.operator_id = ${operatorId}
    GROUP BY e.charge_id
  `)) as unknown as { charge_id: string; waived: number }[];
  return new Map(rows.map((r) => [r.charge_id, r.waived]));
}
