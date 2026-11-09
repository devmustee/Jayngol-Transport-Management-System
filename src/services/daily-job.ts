import { and, eq, gte, isNull, lt, max, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  assignments,
  charges,
  dismissals,
  jobRuns,
  lateEvaluations,
  nonCollectionDays,
  operators,
  tricycles,
  violations,
} from "@/db/schema";
import { addDays, businessDate, type Clock } from "@/lib/clock";
import { rateOn } from "./assignments";
import { recordAwardProgress } from "./award-tracker";
import { recordAudit } from "./audit";
import { proposeAwards } from "./awards";
import { applyCredit, unpaidDaysAsOf } from "./ledger";
import { queueDayNotices } from "./notices";
import { ruleAmount } from "./violations";
import { closeMissedServices, scheduleServices } from "./workshop";

const JOB = "daily";
const ADVISORY_LOCK = 7_401_001;
export const SACKING_DAYS = 5;
export const MAX_FINES_PER_RUN = 3;

/**
 * Processes every business date since the last successful run, oldest first,
 * so a missed night catches up and a repeated run changes nothing.
 */
export async function runDailyJob(clock: Clock): Promise<string[]> {
  const today = businessDate(clock());
  const [row] = await db
    .select({ last: max(jobRuns.businessDate) })
    .from(jobRuns)
    .where(eq(jobRuns.job, JOB));

  const processed: string[] = [];
  let date = row?.last ? addDays(row.last, 1) : today;
  while (date <= today) {
    if (await processDay(date, clock)) processed.push(date);
    date = addDays(date, 1);
  }
  return processed;
}

export async function lastJobDate(): Promise<string | null> {
  const [row] = await db
    .select({ last: max(jobRuns.businessDate) })
    .from(jobRuns)
    .where(eq(jobRuns.job, JOB));
  return row?.last ?? null;
}

/** One transaction per date: a day is either fully processed or not at all. */
export async function processDay(date: string, clock: Clock): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`);
    const [done] = await tx
      .select({ date: jobRuns.businessDate })
      .from(jobRuns)
      .where(and(eq(jobRuns.job, JOB), eq(jobRuns.businessDate, date)));
    if (done) return false;

    const now = clock();
    await createDailyBalances(tx, date);
    await evaluateLateBalances(tx, date, now);
    await reviewDismissals(tx, date, now);
    await closeMissedServices(tx, date, now);
    await scheduleServices(tx, date, now);
    if (date.endsWith("-01")) await proposeAwards(tx, date, now);
    // A catch-up must not message people about days long past.
    const isToday = date === businessDate(now);
    const runs = await recordAwardProgress(tx, date, now, isToday);
    if (isToday) await queueDayNotices(tx, date, now, runs);
    await tx.insert(jobRuns).values({ job: JOB, businessDate: date, finishedAt: now });
    return true;
  });
}

/**
 * A balance starts the day after the tricycle is issued, because it is usually
 * handed over during the day. The day of return is still owed. This runs as a
 * day begins, so a day is free only if the tricycle began it in the workshop.
 */
async function createDailyBalances(tx: Tx, date: string) {
  const [holiday] = await tx
    .select({ date: nonCollectionDays.businessDate })
    .from(nonCollectionDays)
    .where(eq(nonCollectionDays.businessDate, date));
  if (holiday) return;

  const active = await tx
    .select({
      assignmentId: assignments.id,
      operatorId: assignments.operatorId,
      tricycleId: assignments.tricycleId,
    })
    .from(assignments)
    .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
    .innerJoin(operators, eq(operators.id, assignments.operatorId))
    .where(
      and(
        lt(assignments.issuedOn, date),
        or(isNull(assignments.returnedOn), gte(assignments.returnedOn, date)),
        sql`NOT EXISTS (
          SELECT 1 FROM off_road_periods p
          WHERE p.tricycle_id = ${tricycles.id} AND p.starts_on < ${date}
            AND (p.ends_on IS NULL OR p.ends_on >= ${date}))`,
        eq(operators.status, "active"),
      ),
    )
    .orderBy(assignments.operatorId)
    .for("update", { of: operators });

  for (const row of active) {
    const amountKobo = await rateOn(tx, row.assignmentId, date);
    if (amountKobo === null) continue;
    await tx
      .insert(charges)
      .values({
        type: "daily_balance",
        operatorId: row.operatorId,
        tricycleId: row.tricycleId,
        assignmentId: row.assignmentId,
        amountKobo,
        businessDate: date,
        dueOn: addDays(date, 1),
      })
      .onConflictDoNothing();
    await applyCredit(tx, row.operatorId);
  }
}

type LateCandidate = {
  id: string;
  operator_id: string;
  tricycle_id: string | null;
  amount: number;
  paid: number;
};

/**
 * Tests money received by each balance's own deadline, not what is outstanding
 * now, so a payment after midnight cannot clear an offence already committed.
 */
async function evaluateLateBalances(tx: Tx, date: string, now: Date) {
  const candidates = (await tx.execute(sql`
    SELECT c.id, c.operator_id, c.tricycle_id, c.amount_kobo::float8 AS amount,
      COALESCE((
        SELECT SUM(e.amount_kobo) FROM effective_allocations e
        WHERE e.charge_id = c.id
          AND e.received_at < ((c.due_on + 1)::timestamp AT TIME ZONE 'Africa/Lagos')
      ), 0)::float8 AS paid
    FROM valid_charges c
    WHERE c.type = 'daily_balance' AND c.due_on < ${date}::date
      AND NOT EXISTS (SELECT 1 FROM late_evaluations l WHERE l.charge_id = c.id)
    ORDER BY c.operator_id, c.business_date, c.id
  `)) as unknown as LateCandidate[];
  if (candidates.length === 0) return;

  const amountKobo = await ruleAmount(tx, "R1", date);
  const finedUnpaid = new Map<string, number>();

  for (const charge of candidates) {
    if (charge.paid >= charge.amount) {
      await tx.insert(lateEvaluations).values({
        chargeId: charge.id,
        outcome: "on_time",
        evaluatedOn: date,
      });
      continue;
    }

    const count =
      finedUnpaid.get(charge.operator_id) ?? (await countFinedUnpaid(tx, charge.operator_id, date));
    if (count >= MAX_FINES_PER_RUN) {
      await tx.insert(lateEvaluations).values({
        chargeId: charge.id,
        outcome: "capped",
        evaluatedOn: date,
      });
      finedUnpaid.set(charge.operator_id, count);
      continue;
    }

    const [penalty] = await tx
      .insert(charges)
      .values({
        type: "penalty",
        operatorId: charge.operator_id,
        tricycleId: charge.tricycle_id,
        amountKobo,
        businessDate: date,
      })
      .returning({ id: charges.id });
    const [violation] = await tx
      .insert(violations)
      .values({
        ruleCode: "R1",
        operatorId: charge.operator_id,
        tricycleId: charge.tricycle_id,
        occurredOn: date,
        amountKobo,
        status: "confirmed",
        occurrenceKey: `R1:${charge.id}`,
        sourceChargeId: charge.id,
        chargeId: penalty!.id,
        decidedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: violations.id });
    await tx.insert(lateEvaluations).values({
      chargeId: charge.id,
      outcome: "fined",
      evaluatedOn: date,
    });
    if (violation) {
      await recordAudit(tx, null, now, {
        action: "violation.auto_fine",
        entityType: "operator",
        entityId: charge.operator_id,
        after: { rule: "R1", amountKobo, lateBalance: charge.id },
      });
    }
    finedUnpaid.set(charge.operator_id, count + 1);
  }
}

/** R1 fines whose late balance was still unpaid at the start of the date. */
async function countFinedUnpaid(tx: Tx, operatorId: string, date: string): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM violations v
    JOIN valid_charges c ON c.id = v.source_charge_id
    WHERE v.rule_code = 'R1' AND v.status = 'confirmed' AND v.operator_id = ${operatorId}
      AND c.amount_kobo > COALESCE((
        SELECT SUM(e.amount_kobo) FROM effective_allocations e
        WHERE e.charge_id = c.id
          AND e.received_at < (${date}::date::timestamp AT TIME ZONE 'Africa/Lagos')), 0)
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** Raises the sacking alert at 5 unpaid days and closes it once money comes in. */
async function reviewDismissals(tx: Tx, date: string, now: Date) {
  const unpaid = await unpaidDaysAsOf(tx, date);

  const open = await tx
    .select({ id: dismissals.id, operatorId: dismissals.operatorId })
    .from(dismissals)
    .where(eq(dismissals.status, "flagged"));
  const flagged = new Set(open.map((row) => row.operatorId));
  for (const row of open) {
    if ((unpaid.get(row.operatorId)?.days ?? 0) < SACKING_DAYS) {
      await tx.update(dismissals).set({ status: "resolved" }).where(eq(dismissals.id, row.id));
    }
  }

  const activeRows = await tx
    .select({ id: operators.id })
    .from(operators)
    .where(eq(operators.status, "active"));

  for (const { id } of activeRows) {
    const entry = unpaid.get(id);
    if (!entry || entry.days < SACKING_DAYS || flagged.has(id)) continue;

    // A Manager who gave more time should not be asked again about the same debt.
    const [cleared] = await tx
      .select({ id: dismissals.id })
      .from(dismissals)
      .where(
        and(
          eq(dismissals.operatorId, id),
          eq(dismissals.status, "resolved"),
          sql`${dismissals.clearedBy} IS NOT NULL`,
          gte(dismissals.flaggedOn, entry.oldest),
        ),
      )
      .limit(1);
    if (cleared) continue;

    const [row] = await tx
      .insert(dismissals)
      .values({
        operatorId: id,
        status: "flagged",
        unpaidDays: entry.days,
        flaggedOn: date,
        createdAt: now,
      })
      .returning({ id: dismissals.id });
    await recordAudit(tx, null, now, {
      action: "dismissal.flagged",
      entityType: "operator",
      entityId: id,
      after: { dismissalId: row!.id, unpaidDays: entry.days },
    });
  }
}
