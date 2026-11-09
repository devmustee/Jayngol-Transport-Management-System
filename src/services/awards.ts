import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import { awardCandidates, awards, operators, smsOutbox } from "@/db/schema";
import { addDays, addMonths, businessDate } from "@/lib/clock";
import { DomainError, parseInput } from "@/lib/errors";
import { idField, positiveNairaField, requiredText } from "@/lib/fields";
import { AWARD_LABELS } from "@/lib/format";
import { can } from "@/lib/permissions";
import { auditFrom, recordAudit } from "./audit";
import { requirePermission, type Ctx } from "./context";

export type AwardType = keyof typeof AWARD_LABELS;
export const AWARD_TYPES = Object.keys(AWARD_LABELS) as AwardType[];

const SERVICE_MONTHS = 6;
const MIN_COVERAGE_PERCENT = 80;

export type AwardFacts = {
  status: string;
  firstIssuedOn: string | null;
  periodFrom: string;
  periodTo: string;
  workingDays: number;
  inspectedDays: number;
  coveragePercent: number;
  lateBalances: number;
  offencesInPeriod: number;
  offencesEver: number;
  washingOffencesEver: number;
  undecidedInPeriod: number;
  undecidedEver: number;
  undecidedWashing: number;
};

/**
 * The record behind an award, for the 6 months before `run`. Only confirmed
 * offences count. Balances are judged at their own deadline, using money that
 * was not later reversed. `lateBefore` keeps a balance still within its
 * deadline from being called late.
 */
export async function awardFacts(
  exec: Executor,
  operatorId: string,
  run: string,
  lateBefore = run,
): Promise<AwardFacts> {
  const periodFrom = addMonths(run, -SERVICE_MONTHS);
  const periodTo = addDays(run, -1);
  const inPeriod = sql`BETWEEN ${periodFrom}::date AND ${periodTo}::date`;
  const offences = (extra: ReturnType<typeof sql>) =>
    sql`(SELECT COUNT(*)::int FROM violations v WHERE v.operator_id = o.id AND v.occurred_on <= ${periodTo}::date AND ${extra})`;
  const rows = (await exec.execute(sql`
    SELECT o.status::text AS status,
      (SELECT MIN(a.issued_on)::text FROM assignments a WHERE a.operator_id = o.id) AS first_issued,
      (SELECT COUNT(DISTINCT c.business_date)::int FROM valid_charges c
        WHERE c.operator_id = o.id AND c.type = 'daily_balance' AND c.business_date ${inPeriod}) AS working_days,
      (SELECT COUNT(DISTINCT i.business_date)::int FROM inspections i
        WHERE i.operator_id = o.id AND i.business_date ${inPeriod}
          AND EXISTS (SELECT 1 FROM valid_charges c WHERE c.operator_id = o.id
                      AND c.type = 'daily_balance' AND c.business_date = i.business_date)) AS inspected_days,
      (SELECT COUNT(*)::int FROM valid_charges c
        WHERE c.operator_id = o.id AND c.type = 'daily_balance' AND c.business_date ${inPeriod}
          AND c.due_on < ${lateBefore}::date
          AND c.amount_kobo > COALESCE((
            SELECT SUM(e.amount_kobo) FROM effective_allocations e WHERE e.charge_id = c.id
              AND e.received_at < ((c.due_on + 1)::timestamp AT TIME ZONE 'Africa/Lagos')), 0)) AS late,
      ${offences(sql`v.status = 'confirmed' AND v.occurred_on >= ${periodFrom}::date`)} AS in_period,
      ${offences(sql`v.status = 'confirmed'`)} AS ever,
      ${offences(sql`v.status = 'confirmed' AND v.rule_code = 'R2'`)} AS washing,
      ${offences(sql`v.status = 'proposed' AND v.occurred_on >= ${periodFrom}::date`)} AS undecided_period,
      ${offences(sql`v.status = 'proposed'`)} AS undecided_ever,
      ${offences(sql`v.status = 'proposed' AND v.rule_code = 'R2'`)} AS undecided_washing
    FROM operators o WHERE o.id = ${operatorId}
  `)) as unknown as {
    status: string;
    first_issued: string | null;
    working_days: number;
    inspected_days: number;
    late: number;
    in_period: number;
    ever: number;
    washing: number;
    undecided_period: number;
    undecided_ever: number;
    undecided_washing: number;
  }[];
  const row = rows[0];
  if (!row) throw new DomainError("Operator not found.");
  return {
    status: row.status,
    firstIssuedOn: row.first_issued,
    periodFrom,
    periodTo,
    workingDays: row.working_days,
    inspectedDays: row.inspected_days,
    coveragePercent: row.working_days === 0 ? 0 : Math.floor((row.inspected_days * 100) / row.working_days),
    lateBalances: row.late,
    offencesInPeriod: row.in_period,
    offencesEver: row.ever,
    washingOffencesEver: row.washing,
    undecidedInPeriod: row.undecided_period,
    undecidedEver: row.undecided_ever,
    undecidedWashing: row.undecided_washing,
  };
}

/** Why this operator does not qualify, in plain words. Empty means they do. */
export function awardBlockers(type: AwardType, facts: AwardFacts): string[] {
  const reasons: string[] = [];
  if (facts.status !== "active") reasons.push("Only active operators can win awards.");
  if (!facts.firstIssuedOn || facts.firstIssuedOn > facts.periodFrom) reasons.push("Needs at least 6 months of service.");
  // Compared in whole numbers so exactly 80% passes and 79.9% does not.
  if (facts.inspectedDays * 100 < facts.workingDays * MIN_COVERAGE_PERCENT || facts.workingDays === 0) {
    reasons.push(`Inspected on ${facts.coveragePercent}% of working days. Needs at least ${MIN_COVERAGE_PERCENT}%.`);
  }
  if (type === "consistency") {
    if (facts.lateBalances > 0) reasons.push(`${facts.lateBalances} balance(s) late in the last 6 months.`);
    if (facts.offencesInPeriod > 0) reasons.push(`${facts.offencesInPeriod} offence(s) in the last 6 months.`);
  }
  if (type === "clean_vehicle" && facts.washingOffencesEver > 0) {
    reasons.push(`${facts.washingOffencesEver} washing offence(s) on record.`);
  }
  if (type === "law_abiding" && facts.offencesEver > 0) reasons.push(`${facts.offencesEver} offence(s) on record.`);
  return reasons;
}

const undecided = (type: AwardType, facts: AwardFacts) =>
  type === "consistency" ? facts.undecidedInPeriod : type === "clean_vehicle" ? facts.undecidedWashing : facts.undecidedEver;

/** Runs on the 1st of each month, inside the nightly job. */
export async function proposeAwards(tx: Tx, run: string, now: Date) {
  const active = await tx.select({ id: operators.id }).from(operators).where(eq(operators.status, "active"));
  for (const { id: operatorId } of active) {
    const facts = await awardFacts(tx, operatorId, run);
    for (const type of AWARD_TYPES) {
      if (awardBlockers(type, facts).length > 0) continue;
      // A decision covers its 6 months, so each period is judged once.
      const [taken] = (await tx.execute(sql`
        SELECT 1 FROM award_candidates
        WHERE type = ${type}::award_type AND operator_id = ${operatorId}
          AND (status = 'proposed' OR period_to >= ${facts.periodFrom}::date)
        LIMIT 1
      `)) as unknown as unknown[];
      if (taken) continue;
      const [candidate] = await tx
        .insert(awardCandidates)
        .values({
          type,
          operatorId,
          runOn: run,
          periodFrom: facts.periodFrom,
          periodTo: facts.periodTo,
          evidence: facts,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: awardCandidates.id });
      if (candidate) {
        await recordAudit(tx, null, now, {
          action: "award.propose",
          entityType: "operator",
          entityId: operatorId,
          after: { type, periodFrom: facts.periodFrom, periodTo: facts.periodTo },
        });
      }
    }
  }
}

async function lockCandidate(tx: Tx, id: string) {
  const [candidate] = await tx.select().from(awardCandidates).where(eq(awardCandidates.id, id)).for("update");
  if (!candidate) throw new DomainError("Award not found.");
  if (candidate.status !== "proposed") throw new DomainError("This award has already been decided.");
  return candidate;
}

const approveSchema = z.object({
  given: requiredText("What was given", 200),
  cost: positiveNairaField("Cost"),
});

/** The record is checked again now: an offence may have been confirmed since the proposal. */
export async function approveAward(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "award.approve");
  const id = parseInput(idField("award"), rawId);
  const input = parseInput(approveSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const candidate = await lockCandidate(tx, id);
    const facts = await awardFacts(tx, candidate.operatorId, candidate.runOn);
    const waiting = undecided(candidate.type, facts);
    if (waiting > 0) throw new DomainError(`${waiting} offence(s) must be decided first.`);
    const [blocker] = awardBlockers(candidate.type, facts);
    if (blocker) throw new DomainError(`This operator no longer qualifies. ${blocker}`);

    await tx
      .update(awardCandidates)
      .set({ status: "approved", decidedBy: ctx.actor.userId, decidedAt: now })
      .where(eq(awardCandidates.id, id));
    await tx.insert(awards).values({
      candidateId: id,
      operatorId: candidate.operatorId,
      given: input.given,
      costKobo: input.cost,
      givenOn: businessDate(now),
      approvedBy: ctx.actor.userId,
      createdAt: now,
    });
    const [operator] = await tx.select({ phone: operators.phone }).from(operators).where(eq(operators.id, candidate.operatorId));
    await tx.insert(smsOutbox).values({
      toPhone: operator!.phone,
      kind: "award",
      createdAt: now,
      body: `Jayngol: Congratulations! You have won the ${AWARD_LABELS[candidate.type]} award: ${input.given}.`,
    });
    await auditFrom(ctx, tx, {
      action: "award.approve",
      entityType: "operator",
      entityId: candidate.operatorId,
      after: { type: candidate.type, given: input.given, costKobo: input.cost },
    });
  });
}

export async function rejectAward(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "award.approve");
  const id = parseInput(idField("award"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  await db.transaction(async (tx) => {
    const candidate = await lockCandidate(tx, id);
    await tx
      .update(awardCandidates)
      .set({ status: "rejected", decidedBy: ctx.actor.userId, decidedAt: ctx.clock(), rejectReason: reason })
      .where(eq(awardCandidates.id, id));
    await auditFrom(ctx, tx, {
      action: "award.reject",
      entityType: "operator",
      entityId: candidate.operatorId,
      after: { type: candidate.type },
      reason,
    });
  });
}

export async function awardsToDecide() {
  const [row] = await db.select({ value: count() }).from(awardCandidates).where(eq(awardCandidates.status, "proposed"));
  return row?.value ?? 0;
}

export async function listAwards(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const [waiting, given] = await Promise.all([
    db
      .select({ candidate: awardCandidates, operatorName: operators.name })
      .from(awardCandidates)
      .innerJoin(operators, eq(operators.id, awardCandidates.operatorId))
      .where(eq(awardCandidates.status, "proposed"))
      .orderBy(desc(awardCandidates.runOn), operators.name),
    db
      .select({
        id: awards.id,
        type: awardCandidates.type,
        given: awards.given,
        costKobo: awards.costKobo,
        givenOn: awards.givenOn,
        operatorName: operators.name,
      })
      .from(awards)
      .innerJoin(awardCandidates, eq(awardCandidates.id, awards.candidateId))
      .innerJoin(operators, eq(operators.id, awards.operatorId))
      .orderBy(desc(awards.givenOn))
      .limit(200),
  ]);
  return {
    waiting: waiting.map((row) => ({ ...row, facts: row.candidate.evidence as AwardFacts })),
    given,
    canApprove: can(ctx.actor.role, "award.approve"),
  };
}

/** The operator comes only from the login session. */
export async function getMyAwardProgress(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  const operatorId = ctx.actor.operatorId;
  if (!operatorId) throw new DomainError("This login is not linked to an operator.");
  const today = businessDate(ctx.clock());
  const facts = await awardFacts(db, operatorId, addDays(today, 1), today);
  const won = await db
    .select({ type: awardCandidates.type, periodTo: awardCandidates.periodTo })
    .from(awardCandidates)
    .where(and(eq(awardCandidates.operatorId, operatorId), eq(awardCandidates.status, "approved")));
  return AWARD_TYPES.map((type) => {
    const blockers = awardBlockers(type, facts);
    if (won.some((row) => row.type === type && row.periodTo >= facts.periodFrom)) {
      blockers.push("You won this recently. The next 6 months are counting.");
    }
    return { type, blockers };
  });
}
