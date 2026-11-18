import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import { charges, contributionRates, contributionWeeks, operators } from "@/db/schema";
import { addDays, businessDate } from "@/lib/clock";
import { asPgError, DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField, idField, positiveNairaField, requiredText } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { weekStart } from "@/lib/periods";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { allocate, openCharges, voidCharge } from "./ledger";

/**
 * Weekly contributions: company income, paid every Sunday. Each one is a
 * `contribution` charge for the week ending that Sunday, and the money paid
 * for them never mixes with balances, fines or loans.
 */

/** How many weeks an operator may pay before they are raised. */
export const WEEKS_AHEAD = 4;

export const isSunday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

/** The Sunday that ends the business week holding this date. */
export const weekEnding = (date: string) => addDays(weekStart(date), 6);

/** The most recent Sunday on or before this date. */
export const lastSunday = (date: string) => (isSunday(date) ? date : addDays(weekStart(date), -1));

/** The amount in force on a Sunday, or null before contributions start. */
export async function contributionRateOn(exec: Executor, sunday: string): Promise<number | null> {
  const [row] = (await exec.execute(sql`
    SELECT amount_kobo::float8 AS amount FROM contribution_rates
    WHERE effective_from <= ${sunday}::date
    ORDER BY effective_from DESC LIMIT 1
  `)) as unknown as { amount: number }[];
  return row?.amount ?? null;
}

/** Every rate, oldest first. The first one is the day contributions start. */
export async function listContributionRates(exec: Executor) {
  return (await exec.execute(sql`
    SELECT effective_from::text AS effective_from, amount_kobo::float8 AS amount
    FROM contribution_rates ORDER BY effective_from
  `)) as unknown as { effective_from: string; amount: number }[];
}

/**
 * Raises the week's contribution for every active operator who holds a
 * tricycle as Sunday begins. A tricycle in the workshop still counts: this is
 * a membership contribution, not tied to earnings. A week is raised once.
 */
export async function createWeeklyContributions(tx: Tx, date: string, onlyOperator?: string): Promise<void> {
  if (!isSunday(date)) return;
  const amountKobo = await contributionRateOn(tx, date);
  if (amountKobo === null) return;

  const due = (await tx.execute(sql`
    SELECT o.id AS operator_id, held.assignment_id, held.tricycle_id
    FROM operators o
    JOIN LATERAL (
      SELECT a.id AS assignment_id, a.tricycle_id FROM assignments a
      WHERE a.operator_id = o.id
        AND a.issued_on < ${date}::date
        AND (a.returned_on IS NULL OR a.returned_on >= ${date}::date)
      ORDER BY a.issued_on DESC LIMIT 1
    ) held ON true
    WHERE o.status = 'active'
      ${onlyOperator ? sql`AND o.id = ${onlyOperator}` : sql``}
      AND NOT EXISTS (SELECT 1 FROM contribution_weeks w
                      WHERE w.operator_id = o.id AND w.week_ending = ${date}::date)
    ORDER BY o.id
    FOR UPDATE OF o
  `)) as unknown as { operator_id: string; assignment_id: string; tricycle_id: string }[];

  for (const row of due) {
    const [charge] = await tx
      .insert(charges)
      .values({
        type: "contribution",
        operatorId: row.operator_id,
        tricycleId: row.tricycle_id,
        assignmentId: row.assignment_id,
        amountKobo,
        businessDate: date,
        dueOn: date,
      })
      .returning({ id: charges.id });
    await tx.insert(contributionWeeks).values({ chargeId: charge!.id, operatorId: row.operator_id, weekEnding: date });
    await applyContributionCredit(tx, row.operator_id);
  }
}

/** Contribution money not yet attached to a week that still counts. */
export async function contributionCredit(exec: Executor, operatorId: string) {
  const rows = (await exec.execute(sql`
    SELECT p.id,
           (p.amount_kobo - COALESCE((
             SELECT SUM(a.amount_kobo) FROM payment_allocations a
             JOIN valid_charges c ON c.id = a.charge_id
             WHERE a.payment_id = p.id), 0))::float8 AS free
    FROM payments p
    WHERE p.operator_id = ${operatorId} AND p.purpose = 'contribution'
      AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
    ORDER BY p.received_at, p.id
  `)) as unknown as { id: string; free: number }[];
  return rows.filter((row) => row.free > 0);
}

/** Spends contribution credit on unpaid weeks, oldest first. Callers hold the operator's lock. */
export async function applyContributionCredit(tx: Tx, operatorId: string): Promise<void> {
  const credits = await contributionCredit(tx, operatorId);
  if (credits.length === 0) return;
  const weeks = await openCharges(tx, operatorId, "contribution");
  if (weeks.length === 0) return;
  for (const credit of credits) {
    await allocate(tx, credit.id, weeks, credit.free);
  }
}

/** What one operator owes in contributions, and what they have paid ahead. */
export async function contributionPosition(exec: Executor, operatorId: string, today: string) {
  const [weeks, credits, rates] = await Promise.all([
    openCharges(exec, operatorId, "contribution"),
    contributionCredit(exec, operatorId),
    listContributionRates(exec),
  ]);
  const owedKobo = weeks.reduce((s, c) => s + c.outstandingKobo, 0);
  const creditKobo = credits.reduce((s, c) => s + c.free, 0);
  const next = weekEnding(today);
  const nextRate = rates.length === 0 ? null : (rateFrom(rates, next) ?? rates[0]!.amount);
  // Pay ahead: what is owed, plus up to four weeks not yet raised.
  const maxKobo = nextRate === null ? 0 : Math.max(0, owedKobo + WEEKS_AHEAD * nextRate - creditKobo);
  return {
    started: rates.length > 0,
    startsOn: rates[0]?.effective_from ?? null,
    rateKobo: nextRate,
    owedKobo,
    weeksOwed: weeks.length,
    oldestWeek: weeks[0]?.businessDate ?? null,
    unpaidWeeks: weeks.map((w) => ({ chargeId: w.id, weekEnding: w.businessDate, outstandingKobo: w.outstandingKobo })),
    creditKobo,
    maxKobo,
  };
}

function rateFrom(rates: { effective_from: string; amount: number }[], sunday: string): number | null {
  let found: number | null = null;
  for (const rate of rates) if (rate.effective_from <= sunday) found = rate.amount;
  return found;
}

/** The checks for a contribution payment, inside the payment's transaction. */
export async function checkContributionPayment(tx: Tx, operatorId: string, today: string, amountKobo: number) {
  const position = await contributionPosition(tx, operatorId, today);
  if (!position.started) throw fieldError("amount", "Weekly contributions have not started yet");
  if (amountKobo > position.maxKobo) {
    throw fieldError(
      "amount",
      position.maxKobo === 0
        ? `This operator has already paid ${WEEKS_AHEAD} weeks ahead`
        : `At most ${formatNaira(position.maxKobo)} can be taken: what is owed and up to ${WEEKS_AHEAD} weeks ahead`,
    );
  }
  return position;
}

/* ---------- Manager actions ---------- */

const rateSchema = z.object({
  effectiveFrom: dateField("Start Sunday"),
  amount: positiveNairaField("Weekly amount"),
});

/**
 * Starts contributions, or changes the amount from a later Sunday. Past weeks
 * keep the amount they were raised with.
 */
export async function setContributionRate(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "contribution.manage");
  const input = parseInput(rateSchema, raw);
  const today = businessDate(ctx.clock());
  if (!isSunday(input.effectiveFrom)) throw fieldError("effectiveFrom", "Choose a Sunday");
  if (input.effectiveFrom <= today) throw fieldError("effectiveFrom", "Choose a Sunday after today");
  if (input.amount > 100_000_00) throw fieldError("amount", "That is more than ₦100,000 a week. Check for an extra zero.");

  await db.transaction(async (tx) => {
    const before = await contributionRateOn(tx, input.effectiveFrom);
    try {
      await tx.insert(contributionRates).values({
        effectiveFrom: input.effectiveFrom,
        amountKobo: input.amount,
        setBy: ctx.actor.userId,
      });
    } catch (error) {
      if (asPgError(error)?.code === "23505") {
        throw fieldError("effectiveFrom", `An amount is already set from ${formatDate(input.effectiveFrom)}`);
      }
      throw error;
    }
    await auditFrom(ctx, tx, {
      action: before === null ? "contribution.start" : "contribution.rate",
      entityType: "contribution_rate",
      entityId: input.effectiveFrom,
      before: before === null ? undefined : { amountKobo: before },
      after: { effectiveFrom: input.effectiveFrom, amountKobo: input.amount },
    });
  });
}

/** Waives one unpaid week. The charge is voided, never deleted. */
export async function waiveContribution(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "contribution.manage");
  const chargeId = parseInput(idField("week"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  const now = ctx.clock();

  await db.transaction(async (tx) => {
    const [week] = await tx
      .select({ operatorId: contributionWeeks.operatorId, weekEnding: contributionWeeks.weekEnding })
      .from(contributionWeeks)
      .where(eq(contributionWeeks.chargeId, chargeId));
    if (!week) throw new DomainError("Contribution week not found.");
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, week.operatorId)).for("update");

    const open = await openCharges(tx, week.operatorId, "contribution");
    const charge = open.find((c) => c.id === chargeId);
    if (!charge) throw new DomainError("This week is already paid or waived.");
    if (charge.paidKobo > 0) {
      throw new DomainError("Part of this week is paid. Reverse that payment first, or collect the rest.");
    }

    await voidCharge(tx, chargeId, { userId: ctx.actor.userId, at: now }, reason);
    await applyContributionCredit(tx, week.operatorId);
    await auditFrom(ctx, tx, {
      action: "contribution.waive",
      entityType: "charge",
      entityId: chargeId,
      before: { operatorId: week.operatorId, weekEnding: week.weekEnding, amountKobo: charge.amountKobo },
      reason,
    });
  });
}

/* ---------- Reading ---------- */

type Row = {
  operator_id: string;
  name: string;
  phone: string;
  status: string;
  tricycle_id: string | null;
  code_number: string | null;
  registration_number: string | null;
  week_charge_id: string | null;
  week_amount: number | null;
  week_paid: number | null;
  weeks_owed: number;
  owed: number;
  oldest: string | null;
  credit: number;
  total_paid: number;
  unpaid: { chargeId: string; weekEnding: string; outstanding: number; paid: number }[] | null;
};

/**
 * Everyone who pays contributions, with the chosen week, what each owes in
 * all, and what they have paid ahead. `week` is the Sunday that ends it.
 */
export async function listContributions(ctx: Ctx, wanted?: string) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const rates = await listContributionRates(db);
  const startsOn = rates[0]?.effective_from ?? null;
  // Before the start, and between Sundays, the default week is the latest one
  // charged; before anything is charged it is the first Sunday to come.
  const latest = startsOn && lastSunday(today) < startsOn ? startsOn : lastSunday(today);
  const lastAllowed = latest > weekEnding(today) ? latest : weekEnding(today);
  const week =
    wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) && isSunday(wanted) && wanted <= lastAllowed ? wanted : latest;

  const rows = (await db.execute(sql`
    WITH w AS (
      SELECT c.id, cw.operator_id, cw.week_ending, c.amount_kobo,
             COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                       WHERE e.charge_id = c.id), 0) AS paid
      FROM contribution_weeks cw JOIN valid_charges c ON c.id = cw.charge_id
    ),
    credit AS (
      SELECT p.operator_id, SUM(p.amount_kobo - COALESCE((
               SELECT SUM(a.amount_kobo) FROM payment_allocations a
               JOIN valid_charges vc ON vc.id = a.charge_id
               WHERE a.payment_id = p.id), 0)) AS free
      FROM payments p
      WHERE p.purpose = 'contribution'
        AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
      GROUP BY p.operator_id
    )
    SELECT o.id AS operator_id, o.name, o.phone, o.status::text AS status,
           held.id AS tricycle_id, held.code_number, held.registration_number,
           wk.id AS week_charge_id, wk.amount_kobo::float8 AS week_amount, wk.paid::float8 AS week_paid,
           (SELECT COUNT(*) FROM w WHERE w.operator_id = o.id AND w.paid < w.amount_kobo)::int AS weeks_owed,
           COALESCE((SELECT SUM(w.amount_kobo - w.paid) FROM w
                     WHERE w.operator_id = o.id AND w.paid < w.amount_kobo), 0)::float8 AS owed,
           (SELECT MIN(w.week_ending)::text FROM w WHERE w.operator_id = o.id AND w.paid < w.amount_kobo) AS oldest,
           COALESCE(cr.free, 0)::float8 AS credit,
           COALESCE((SELECT SUM(w.paid) FROM w WHERE w.operator_id = o.id), 0)::float8 AS total_paid,
           (SELECT json_agg(json_build_object(
                     'chargeId', w.id, 'weekEnding', w.week_ending,
                     'outstanding', w.amount_kobo - w.paid, 'paid', w.paid) ORDER BY w.week_ending)
            FROM w WHERE w.operator_id = o.id AND w.paid < w.amount_kobo) AS unpaid
    FROM operators o
    LEFT JOIN w wk ON wk.operator_id = o.id AND wk.week_ending = ${week}::date
    LEFT JOIN credit cr ON cr.operator_id = o.id
    LEFT JOIN LATERAL (
      SELECT t.id, t.code_number, t.registration_number
      FROM assignments a JOIN tricycles t ON t.id = a.tricycle_id
      WHERE a.operator_id = o.id AND a.returned_on IS NULL
      ORDER BY a.issued_on DESC LIMIT 1
    ) held ON true
    WHERE (o.status = 'active' AND held.id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM w WHERE w.operator_id = o.id)
       OR COALESCE(cr.free, 0) > 0
    ORDER BY o.name
  `)) as unknown as Row[];

  const operatorsList = rows.map((row) => {
    const weekStatus: "paid" | "part" | "unpaid" | "waiting" | "due" | "ahead" =
      row.week_amount === null
        ? week > today && row.status === "active" && row.tricycle_id
          ? row.credit > 0 && row.credit >= (rateFrom(rates, week) ?? Infinity)
            ? "ahead"
            : "due"
          : "waiting"
        : row.week_paid! >= row.week_amount
          ? "paid"
          : row.week_paid! > 0
            ? "part"
            : "unpaid";
    return {
      operatorId: row.operator_id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      tricycle: row.tricycle_id
        ? { id: row.tricycle_id, code: row.code_number!, registration: row.registration_number! }
        : null,
      week: row.week_amount === null ? null : { amountKobo: row.week_amount, paidKobo: row.week_paid! },
      weekStatus,
      weeksOwed: row.weeks_owed,
      owedKobo: row.owed,
      oldestWeek: row.oldest,
      creditKobo: row.credit,
      totalPaidKobo: row.total_paid,
      unpaid: (row.unpaid ?? []).map((u) => ({ ...u, weekEnding: String(u.weekEnding).slice(0, 10) })),
    };
  });

  const raised = operatorsList.filter((o) => o.week);
  return {
    today,
    week,
    weekRaised: week <= today && raised.length > 0,
    lastAllowed,
    started: rates.length > 0,
    startsOn,
    rates,
    rateKobo: rateFrom(rates, weekEnding(today)) ?? rates[0]?.amount ?? null,
    expectedKobo: raised.reduce((s, o) => s + o.week!.amountKobo, 0),
    collectedKobo: raised.reduce((s, o) => s + Math.min(o.week!.paidKobo, o.week!.amountKobo), 0),
    paidCount: raised.filter((o) => o.weekStatus === "paid").length,
    unpaidCount: raised.filter((o) => o.weekStatus !== "paid").length,
    owedKobo: operatorsList.reduce((s, o) => s + o.owedKobo, 0),
    owingCount: operatorsList.filter((o) => o.owedKobo > 0).length,
    operators: operatorsList,
  };
}

/** This week's figures for the Money page and Home. Null before contributions start. */
export async function contributionSummary(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const rates = await listContributionRates(db);
  if (rates.length === 0) return null;
  const week = lastSunday(today);
  const [row] = (await db.execute(sql`
    WITH w AS (
      SELECT cw.week_ending, c.amount_kobo,
             COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                       WHERE e.charge_id = c.id), 0) AS paid
      FROM contribution_weeks cw JOIN valid_charges c ON c.id = cw.charge_id
    )
    SELECT
      COALESCE(SUM(amount_kobo) FILTER (WHERE week_ending = ${week}::date), 0)::float8 AS expected,
      COALESCE(SUM(LEAST(paid, amount_kobo)) FILTER (WHERE week_ending = ${week}::date), 0)::float8 AS collected,
      COUNT(*) FILTER (WHERE week_ending = ${week}::date AND paid < amount_kobo)::int AS unpaid,
      COALESCE(SUM(amount_kobo - paid) FILTER (WHERE paid < amount_kobo), 0)::float8 AS owed,
      (SELECT COALESCE(SUM(p.amount_kobo), 0)::float8 FROM payments p
       WHERE p.purpose = 'contribution' AND p.business_date = ${today}::date
         AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)) AS today
    FROM w
  `)) as unknown as { expected: number; collected: number; unpaid: number; owed: number; today: number }[];
  return {
    week,
    started: rates[0]!.effective_from <= today,
    startsOn: rates[0]!.effective_from,
    expectedKobo: row!.expected,
    collectedKobo: row!.collected,
    unpaidCount: row!.unpaid,
    owedKobo: row!.owed,
    collectedTodayKobo: row!.today,
  };
}

/** One operator's weeks, newest first, for staff and for the operator. */
async function contributionHistory(exec: Executor, operatorId: string, today: string) {
  const [position, weeks] = await Promise.all([
    contributionPosition(exec, operatorId, today),
    exec.execute(sql`
      SELECT cw.week_ending::text AS week_ending, c.amount_kobo::float8 AS amount,
             EXISTS (SELECT 1 FROM charge_voids v WHERE v.charge_id = c.id) AS waived,
             COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                       WHERE e.charge_id = c.id), 0)::float8 AS paid
      FROM contribution_weeks cw JOIN charges c ON c.id = cw.charge_id
      WHERE cw.operator_id = ${operatorId}
      ORDER BY cw.week_ending DESC LIMIT 26
    `),
  ]);
  const list = weeks as unknown as { week_ending: string; amount: number; waived: boolean; paid: number }[];
  const [total] = (await exec.execute(sql`
    SELECT COALESCE(SUM(e.amount_kobo), 0)::float8 AS total
    FROM effective_allocations e JOIN valid_charges c ON c.id = e.charge_id
    WHERE c.operator_id = ${operatorId} AND c.type = 'contribution'
  `)) as unknown as { total: number }[];
  const thisWeek = weekEnding(today);
  const current = list.find((w) => w.week_ending === lastSunday(today)) ?? null;
  return {
    ...position,
    thisWeek,
    current,
    totalPaidKobo: total?.total ?? 0,
    weeks: list,
  };
}

export async function getContributions(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "finance.view");
  return contributionHistory(db, operatorId, businessDate(ctx.clock()));
}

/** The operator's own contributions. The ID comes only from the login session. */
export async function getMyContributions(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  if (!ctx.actor.operatorId) throw new DomainError("This login is not linked to an operator.");
  return contributionHistory(db, ctx.actor.operatorId, businessDate(ctx.clock()));
}
