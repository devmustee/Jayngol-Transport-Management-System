import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Executor, type Tx } from "@/db";
import { awardMilestones } from "@/db/schema";
import { addMonths, businessDate } from "@/lib/clock";
import { AWARD_LABELS, formatDate } from "@/lib/format";
import { honourBoard, justEndedRun, operatorProgress, type AwardType, type OperatorHistory, type OperatorProgress } from "@/lib/award-progress";
import { DomainError } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { LATE_BALANCE } from "./awards";
import { requirePermission, type Ctx } from "./context";
import { notifyOperators, unpaidDueOn } from "./notices";

/** Working days older than this cannot fall inside any upcoming award's 6 months. */
const COVERAGE_LOOKBACK_MONTHS = 7;

type Row<T> = T & { operator_id: string };

function groupBy<T>(rows: Row<T>[]) {
  const groups = new Map<string, Row<T>[]>();
  for (const row of rows) {
    const group = groups.get(row.operator_id);
    if (group) group.push(row);
    else groups.set(row.operator_id, [row]);
  }
  return groups;
}

/** One set of queries for the whole list, however many operators it holds. */
async function loadRecords(
  scope: ReturnType<typeof sql>,
  today: string,
  { exec = db, coverage = true }: { exec?: Executor; coverage?: boolean } = {},
) {
  const list = <T>(query: ReturnType<typeof sql>) => exec.execute(query) as unknown as Promise<Row<T>[]>;
  const [people, stints, late, offences, decisions, days] = await Promise.all([
    exec.execute(sql`
      SELECT o.id AS operator_id, o.name, o.status::text AS status,
        (SELECT t.code_number FROM assignments a JOIN tricycles t ON t.id = a.tricycle_id
          WHERE a.operator_id = o.id AND a.returned_on IS NULL LIMIT 1) AS tricycle_code
      FROM operators o WHERE o.id IN ${scope}
    `) as unknown as Promise<Row<{ name: string; status: string; tricycle_code: string | null }>[]>,
    list<{ issued_on: string; returned_on: string | null; return_reason: string | null }>(sql`
      SELECT operator_id, issued_on::text, returned_on::text, return_reason::text
      FROM assignments WHERE operator_id IN ${scope}
    `),
    list<{ on_date: string }>(sql`
      SELECT c.operator_id, c.business_date::text AS on_date
      FROM valid_charges c
      WHERE c.operator_id IN ${scope} AND c.type = 'daily_balance' AND c.due_on < ${today}::date
        AND (
          c.id NOT IN (SELECT charge_id FROM late_evaluations WHERE outcome = 'on_time')
          OR c.id IN (SELECT a.charge_id FROM payment_allocations a JOIN payment_reversals r ON r.payment_id = a.payment_id)
        )
        AND ${LATE_BALANCE}
    `),
    list<{ on_date: string; rule_code: string; rule_name: string | null; status: string }>(sql`
      SELECT v.operator_id, v.occurred_on::text AS on_date, v.rule_code, v.status::text,
        (SELECT r.name FROM rules r WHERE r.code = v.rule_code AND r.effective_from <= v.occurred_on
          ORDER BY r.effective_from DESC LIMIT 1) AS rule_name
      FROM violations v WHERE v.operator_id IN ${scope} AND v.status IN ('confirmed', 'proposed')
    `),
    list<{ type: AwardType; period_to: string; status: string; given_on: string | null }>(sql`
      SELECT c.operator_id, c.type::text, c.period_to::text, c.status::text, a.given_on::text
      FROM award_candidates c LEFT JOIN awards a ON a.candidate_id = c.id
      WHERE c.operator_id IN ${scope}
    `),
    coverage
      ? list<{ on_date: string; inspected: boolean }>(sql`
          SELECT DISTINCT c.operator_id, c.business_date::text AS on_date,
            EXISTS (SELECT 1 FROM inspections i WHERE i.operator_id = c.operator_id AND i.business_date = c.business_date) AS inspected
          FROM valid_charges c
          WHERE c.operator_id IN ${scope} AND c.type = 'daily_balance'
            AND c.business_date >= ${addMonths(today, -COVERAGE_LOOKBACK_MONTHS)}::date
        `)
      : Promise.resolve([] as Row<{ on_date: string; inspected: boolean }>[]),
  ]);

  const byStint = groupBy(stints);
  const byLate = groupBy(late);
  const byOffence = groupBy(offences);
  const byDecision = groupBy(decisions);
  const byDay = groupBy(days);

  return people.map((person) => {
    const id = person.operator_id;
    const offencesOf = (status: string) =>
      (byOffence.get(id) ?? [])
        .filter((row) => row.status === status)
        .map((row) => ({ on: row.on_date, ruleCode: row.rule_code, ruleName: row.rule_name }));
    const history: OperatorHistory = {
      status: person.status,
      stints: (byStint.get(id) ?? []).map((row) => ({
        issuedOn: row.issued_on,
        returnedOn: row.returned_on,
        returnReason: row.return_reason,
      })),
      lateBalances: (byLate.get(id) ?? []).map((row) => row.on_date),
      confirmedOffences: offencesOf("confirmed"),
      undecidedOffences: offencesOf("proposed"),
      decisions: (byDecision.get(id) ?? []).map((row) => ({
        type: row.type,
        periodTo: row.period_to,
        status: row.status,
        givenOn: row.given_on,
      })),
      workingDays: (byDay.get(id) ?? []).map((row) => ({ on: row.on_date, inspected: row.inspected })),
    };
    return {
      operatorId: id,
      name: person.name,
      tricycleCode: person.tricycle_code,
      history,
      progress: operatorProgress(history, today),
    };
  });
}

/** What leaves this file: the raw history is never handed to a screen. */
async function loadHistories(scope: ReturnType<typeof sql>, today: string, coverage = true) {
  const rows = await loadRecords(scope, today, { coverage });
  return rows.map(({ operatorId, name, tricycleCode, progress }) => ({ operatorId, name, tricycleCode, progress }));
}

/** Why a run ended is finance detail, so Supervisors see only the stage. */
const visibleTo = (ctx: Ctx, progress: OperatorProgress): OperatorProgress =>
  can(ctx.actor.role, "finance.view") ? progress : { ...progress, lastBreak: null, breaks: [], recentDays: [] };

/** Every active operator's progress. It holds no money, so Supervisors can see it. */
export async function getAwardRace(ctx: Ctx) {
  requirePermission(ctx, "awards.track");
  const today = businessDate(ctx.clock());
  const rows = await loadHistories(sql`(SELECT id FROM operators WHERE status = 'active')`, today);
  return { today, operators: rows.map((row) => ({ ...row, progress: visibleTo(ctx, row.progress) })) };
}

/** One operator's journey, for staff. Null if there is no such operator. */
export async function getOperatorJourney(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "awards.track");
  const today = businessDate(ctx.clock());
  const [row] = await loadHistories(sql`(SELECT ${operatorId}::uuid)`, today);
  return row ? { ...row, today, progress: visibleTo(ctx, row.progress) } : null;
}

/** The operator comes only from the login session. */
export async function getMyAwardJourney(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  const operatorId = ctx.actor.operatorId;
  if (!operatorId) throw new DomainError("This login is not linked to an operator.");
  const [mine] = await loadHistories(sql`(SELECT ${operatorId}::uuid)`, businessDate(ctx.clock()));
  if (!mine) throw new DomainError("Operator not found.");
  return mine.progress;
}

/** The top 5 only, with only the fields safe to show every operator. */
export async function getHonourBoard(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  const operatorId = ctx.actor.operatorId;
  if (!operatorId) throw new DomainError("This login is not linked to an operator.");
  const today = businessDate(ctx.clock());
  return honourBoard(await loadHistories(sql`(SELECT id FROM operators WHERE status = 'active')`, today, false), operatorId);
}

/** The portal's warning: what must be paid by midnight to keep the current run. */
export async function getMyRunAtRisk(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  const operatorId = ctx.actor.operatorId;
  if (!operatorId) throw new DomainError("This login is not linked to an operator.");
  const [row] = await unpaidDueOn(db, businessDate(ctx.clock()), operatorId);
  return row ? { owedKobo: row.owed } : null;
}

const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

function milestoneNotice(code: string, label: string, progress: OperatorProgress): string {
  if (code === "comeback") return "Comeback! 30 clean days since your last slip. Well done.";
  if (code === "new_best") return "New Best! You have beaten your longest clean run.";
  if (code === "clean_six") return "Clean Six! 6 months with no offence.";
  const consistency = progress.awards.find((award) => award.type === "consistency");
  const toGo = consistency?.daysToGo != null ? ` ${days(consistency.daysToGo)} to go for the ${AWARD_LABELS.consistency} award.` : "";
  return `${label}! ${days(progress.currentRunDays)} clean.${toGo}`;
}

/** Awards are judged monthly, so stages only move forward on the 1st. */
function nearAwardNotice(progress: OperatorProgress): string | null {
  const near = progress.awards.filter((award) => award.stage === "ready" || award.stage === "close");
  const soonest = near.map((award) => award.nextAwardOn!).sort()[0];
  if (!soonest) return null;
  const names = near.filter((award) => award.nextAwardOn === soonest).map((award) => AWARD_LABELS[award.type]);
  const award = near.find((row) => row.nextAwardOn === soonest)!;
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} awards` : `${names[0]} award`;
  return `You are ${days(award.daysToGo!)} from the ${list}. Keep it clean.`;
}

/**
 * Runs inside the nightly job, even for a catch-up, so the record stays right.
 * Messages go out only when `notify` is set, and each one only ever once.
 * Returns each operator's current run, for the balance reminder.
 */
export async function recordAwardProgress(tx: Tx, date: string, now: Date, notify: boolean) {
  const rows = await loadRecords(sql`(SELECT id FROM operators WHERE status = 'active')`, date, {
    exec: tx,
    coverage: false,
  });
  const held = await tx
    .select({ id: awardMilestones.id, operatorId: awardMilestones.operatorId, code: awardMilestones.code })
    .from(awardMilestones)
    .where(isNull(awardMilestones.voidedAt));
  const heldKey = new Set(held.map((row) => `${row.operatorId}:${row.code}`));
  const earnedKey = new Set(rows.flatMap((row) => row.progress.milestones.map((item) => `${row.operatorId}:${item.code}`)));

  const inScope = new Set(rows.map((row) => row.operatorId));
  for (const row of held) {
    if (!inScope.has(row.operatorId) || earnedKey.has(`${row.operatorId}:${row.code}`)) continue;
    await tx
      .update(awardMilestones)
      .set({ voidedAt: now, voidReason: "The record behind this milestone was corrected." })
      .where(and(eq(awardMilestones.id, row.id), isNull(awardMilestones.voidedAt)));
  }

  const fresh = rows.flatMap((row) =>
    row.progress.milestones
      .filter((item) => !heldKey.has(`${row.operatorId}:${item.code}`))
      .map((item) => ({ row, item })),
  );
  if (fresh.length > 0) {
    await tx.insert(awardMilestones).values(
      fresh.map(({ row, item }) => ({
        operatorId: row.operatorId,
        code: item.code,
        reachedOn: item.reachedOn,
        evidence: { runStartedOn: row.progress.runStartedOn, currentRunDays: row.progress.currentRunDays },
        createdAt: now,
      })),
    );
  }

  if (notify) {
    // Only what happened today: the first run must not announce old milestones.
    const reached = fresh
      .filter(({ item }) => item.reachedOn === date && !item.code.startsWith("winner_"))
      .map(({ row, item }) => ({
        operatorId: row.operatorId,
        kind: "milestone",
        body: milestoneNotice(item.code, item.label, row.progress),
        dedupeKey: `milestone:${item.code}`,
      }));

    const ended = rows.flatMap((row) => {
      const run = justEndedRun(row.history, date);
      if (!run) return [];
      const next = row.progress.awards.find((award) => award.type === "consistency")?.nextAwardOn;
      const aim = next ? ` Your next award date is ${formatDate(next)}.` : "";
      return [
        {
          operatorId: row.operatorId,
          kind: "run_ended",
          body: `Your ${run.days}-day run has ended.${aim} You can do this.`,
          dedupeKey: `run_ended:${run.endedOn}`,
        },
      ];
    });

    const near = date.endsWith("-01")
      ? rows.flatMap((row) => {
          const body = nearAwardNotice(row.progress);
          return body ? [{ operatorId: row.operatorId, kind: "award_near", body, dedupeKey: `award_near:${date}` }] : [];
        })
      : [];

    await notifyOperators(tx, now, [...reached, ...ended, ...near]);
  }

  return new Map(rows.map((row) => [row.operatorId, row.progress.currentRunDays]));
}
