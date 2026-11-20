import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db";
import {
  cashCloseChecks,
  cashCloseCorrections,
  cashCloses,
  cashMovements,
  dismissals,
  moneyTransfers,
  nonCollectionDays,
  operators,
  users,
  violations,
} from "@/db/schema";
import { closeRhythm, coverageLabel } from "@/lib/cash-rhythm";
import { addDays, businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { dateField, idField, nairaField, optionalText, requiredText } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { DateRange } from "@/lib/periods";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { awardsToDecide } from "./awards";
import { cashAlerts, cashPosition, cashSinceLastClose, givenOutOn, recordMovement } from "./cash-book";
import { advanceCounts } from "./expenses";
import { contributionCredit } from "./contributions";
import { openCharges, unallocatedPayments } from "./ledger";
import { lastJobDate } from "./daily-job";
import { loansToCollect } from "./loans";
import { tellCashCorrected, tellCashCounted, tellCashDifference } from "./staff-events";

/* ---------- Statements ---------- */

async function buildStatement(exec: Executor, operatorId: string) {
  const [balances, penalties, loanCharges, credits, contributionWeeks, contributionAhead, chargeRows, paymentRows, awardRows] = await Promise.all([
    openCharges(exec, operatorId, "daily_balance"),
    openCharges(exec, operatorId, "penalty"),
    openCharges(exec, operatorId, "loan"),
    unallocatedPayments(exec, operatorId),
    openCharges(exec, operatorId, "contribution"),
    contributionCredit(exec, operatorId),
    exec.execute(sql`
      SELECT c.id, c.type::text AS type, c.amount_kobo::float8 AS amount,
             c.business_date::text AS business_date,
             EXISTS (SELECT 1 FROM charge_voids v WHERE v.charge_id = c.id) AS voided,
             COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                       WHERE e.charge_id = c.id), 0)::float8 AS paid,
             COALESCE((SELECT SUM(w.amount_kobo) FROM effective_waivers w
                       WHERE w.charge_id = c.id), 0)::float8 AS waived
      FROM charges c WHERE c.operator_id = ${operatorId}
      ORDER BY c.business_date DESC, c.created_at DESC LIMIT 120
    `),
    exec.execute(sql`
      SELECT p.id, p.receipt_number, p.amount_kobo::float8 AS amount, p.method::text AS method,
             p.business_date::text AS business_date,
             EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id) AS reversed
      FROM payments p WHERE p.operator_id = ${operatorId}
      ORDER BY p.received_at DESC LIMIT 60
    `),
    exec.execute(sql`
      SELECT a.id, c.type::text AS type, a.given, a.given_on::text AS given_on
      FROM awards a JOIN award_candidates c ON c.id = a.candidate_id
      WHERE a.operator_id = ${operatorId}
      ORDER BY a.given_on DESC
    `),
  ]);
  return {
    balanceOwedKobo: balances.reduce((s, c) => s + c.outstandingKobo, 0),
    unpaidDays: balances.length,
    penaltiesOwedKobo: penalties.reduce((s, c) => s + c.outstandingKobo, 0),
    loanOwedKobo: loanCharges.reduce((s, c) => s + c.outstandingKobo, 0),
    creditKobo: credits.reduce((s, c) => s + c.free, 0),
    contributionOwedKobo: contributionWeeks.reduce((s, c) => s + c.outstandingKobo, 0),
    contributionWeeksOwed: contributionWeeks.length,
    contributionAheadKobo: contributionAhead.reduce((s, c) => s + c.free, 0),
    awards: awardRows as unknown as {
      id: string;
      type: "consistency" | "clean_vehicle" | "law_abiding";
      given: string;
      given_on: string;
    }[],
    charges: chargeRows as unknown as {
      id: string;
      type: "daily_balance" | "penalty" | "loan" | "contribution";
      amount: number;
      business_date: string;
      voided: boolean;
      paid: number;
      /** Forgiven by the Manager. What is owed is amount − waived − paid. */
      waived: number;
    }[],
    payments: paymentRows as unknown as {
      id: string;
      receipt_number: string;
      amount: number;
      method: string;
      business_date: string;
      reversed: boolean;
    }[],
  };
}

export async function getStatement(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "finance.view");
  return buildStatement(db, operatorId);
}

/** The operator's own statement. The ID comes only from the login session. */
export async function getMyStatement(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  if (!ctx.actor.operatorId) throw new DomainError("This login is not linked to an operator.");
  return buildStatement(db, ctx.actor.operatorId);
}

/* ---------- Collections and arrears ---------- */

export async function collectionsFor(ctx: Ctx, date: string) {
  requirePermission(ctx, "finance.view");
  const [expectedRows, byMethodRows] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS total FROM valid_charges
      WHERE type = 'daily_balance' AND business_date = ${date}::date
    `),
    db.execute(sql`
      SELECT p.method::text AS method, SUM(p.amount_kobo)::float8 AS total FROM payments p
      WHERE p.business_date = ${date}::date
        AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
      GROUP BY p.method
    `),
  ]);
  const methods = byMethodRows as unknown as { method: string; total: number }[];
  return {
    expectedKobo: (expectedRows as unknown as { total: number }[])[0]?.total ?? 0,
    collectedKobo: methods.reduce((s, m) => s + m.total, 0),
    byMethod: methods,
  };
}

/** Unpaid balances, optionally only for days in a range (a week or a month, for example). */
export async function listArrears(ctx: Ctx, range?: DateRange) {
  requirePermission(ctx, "finance.view");
  const inRange = range ? sql`AND c.business_date BETWEEN ${range.from}::date AND ${range.to}::date` : sql``;
  const rows = await db.execute(sql`
    WITH open AS (
      SELECT c.operator_id, c.tricycle_id, c.business_date, c.amount_kobo,
             c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                       WHERE e.charge_id = c.id), 0) AS owed
      FROM valid_charges c WHERE c.type = 'daily_balance' ${inRange}
    ), unpaid AS (
      SELECT * FROM open WHERE owed > 0
    ), latest AS (
      -- The tricycle of the most recent unpaid day, and what it charged that day.
      SELECT DISTINCT ON (operator_id) operator_id, tricycle_id, amount_kobo
      FROM unpaid ORDER BY operator_id, business_date DESC
    )
    SELECT o.id, o.name, o.phone, o.address, o.guarantor_name, o.guarantor_phone,
           o.status::text AS status,
           COUNT(*)::int AS days, SUM(unpaid.owed)::float8 AS owed,
           MIN(unpaid.business_date)::text AS oldest, MAX(unpaid.business_date)::text AS newest,
           t.id AS tricycle_id, t.code_number, t.registration_number,
           latest.amount_kobo::float8 AS daily_kobo,
           EXISTS (SELECT 1 FROM assignments a WHERE a.operator_id = o.id AND a.tricycle_id = t.id
                     AND a.returned_on IS NULL) AS holds_tricycle
    FROM unpaid
    JOIN operators o ON o.id = unpaid.operator_id
    JOIN latest ON latest.operator_id = o.id
    LEFT JOIN tricycles t ON t.id = latest.tricycle_id
    GROUP BY o.id, t.id, latest.amount_kobo
    ORDER BY days DESC, oldest
  `);
  return rows as unknown as {
    id: string;
    name: string;
    phone: string;
    address: string | null;
    guarantor_name: string | null;
    guarantor_phone: string | null;
    status: "active" | "sacked" | "left";
    days: number;
    owed: number;
    oldest: string;
    newest: string;
    tricycle_id: string | null;
    code_number: string | null;
    registration_number: string | null;
    daily_kobo: number | null;
    holds_tricycle: boolean;
  }[];
}

/* ---------- Cash close ---------- */

// Closing is one step: the person who holds the cash counts it and closes.
// cash_close_checks holds the second checks made before that, kept as history.

/**
 * Cash that reached (or left) a person after a date. A count is always of the
 * cash in hand now, so a count for an earlier day must leave this out, or that
 * cash is counted on the earlier day and again on the next.
 */
async function cashAfter(exec: Executor, custodianId: string, date: string) {
  const [row] = (await exec.execute(sql`
    SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS kobo FROM cash_movements
    WHERE custodian_id = ${custodianId} AND business_date > ${date}::date
  `)) as unknown as { kobo: number }[];
  return row?.kobo ?? 0;
}

export async function cashDay(ctx: Ctx, date: string) {
  requirePermission(ctx, "finance.view");
  const [custodians, closes, checks, corrections, latest] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, role: users.role, status: users.status })
      .from(users)
      .where(sql`${users.role} IN ('manager', 'assistant_manager')`)
      .orderBy(asc(users.name)),
    db.select().from(cashCloses).where(eq(cashCloses.businessDate, date)),
    db
      .select({ check: cashCloseChecks })
      .from(cashCloseChecks)
      .innerJoin(cashCloses, eq(cashCloses.id, cashCloseChecks.closeId))
      .where(eq(cashCloses.businessDate, date)),
    db
      .select({ correction: cashCloseCorrections, byName: users.name })
      .from(cashCloseCorrections)
      .innerJoin(cashCloses, eq(cashCloses.id, cashCloseCorrections.closeId))
      .innerJoin(users, eq(users.id, cashCloseCorrections.correctedBy))
      .where(eq(cashCloses.businessDate, date)),
    db
      .select({ custodianId: cashCloses.custodianId, date: sql<string>`MAX(${cashCloses.businessDate})::text` })
      .from(cashCloses)
      .groupBy(cashCloses.custodianId),
  ]);
  const people = await Promise.all(
    custodians.map(async (person) => {
      const [{ openingKobo, movedKobo }, covers, laterKobo] = await Promise.all([
        cashPosition(db, person.id, date),
        cashSinceLastClose(db, person.id, date),
        cashAfter(db, person.id, date),
      ]);
      const close = closes.find((c) => c.custodianId === person.id) ?? null;
      const fix = close ? (corrections.find((row) => row.correction.closeId === close.id) ?? null) : null;
      return {
        id: person.id,
        name: person.name,
        role: person.role,
        /** Disabled people stay listed while they hold cash, so it can be counted and taken over. */
        active: person.status === "active",
        rhythm: closeRhythm(person.role),
        /** The days a count on this date covers, from the last count. */
        covers,
        openingKobo,
        movedKobo,
        expectedKobo: openingKobo + movedKobo,
        /** Cash in or out after this date, which a count now includes and this day must not. */
        laterKobo,
        close,
        /** The count that stands: the correction if there is one. */
        countedKobo: close ? (fix?.correction.countedKobo ?? close.countedKobo) : null,
        correction: fix ? { ...fix.correction, byName: fix.byName } : null,
        /** Only a person's latest close can be corrected; a later one was built on it. */
        isLatestClose: close !== null && latest.find((row) => row.custodianId === person.id)?.date === date,
        check: close ? (checks.find((row) => row.check.closeId === close.id)?.check ?? null) : null,
      };
    }),
  );
  return people.filter((person) => person.active || person.close !== null || person.expectedKobo + person.laterKobo !== 0);
}

const closeSchema = z.object({
  custodianId: idField("person"),
  businessDate: dateField("Date"),
  counted: nairaField("Cash in hand"),
  explanation: optionalText(),
});

/**
 * Records a count. `counted` is the cash in hand now; for an earlier day the
 * cash that came in after it is taken off. Closing the cash of someone who has
 * left also hands it to the Manager doing the count, so it can be moved on.
 */
export async function closeCash(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "cash.close");
  const input = parseInput(closeSchema, raw);
  if (input.custodianId !== ctx.actor.userId && ctx.actor.role !== "manager") {
    throw new DomainError("You can only close your own cash.");
  }
  const today = businessDate(ctx.clock());
  if (input.businessDate > today) {
    throw fieldError("businessDate", "You cannot close a future date");
  }
  try {
    return await db.transaction(async (tx) => {
      // Holds back payments and moves for this person until the count is saved.
      const [holder] = await tx
        .select({ name: users.name, status: users.status })
        .from(users)
        .where(eq(users.id, input.custodianId))
        .for("update");
      if (!holder) throw new DomainError("This person was not found.");
      const leaving = holder.status !== "active";
      if (leaving && input.businessDate !== today) {
        throw fieldError("businessDate", `${holder.name} has left. Count their cash today to take it over.`);
      }
      const [later] = await tx
        .select({ id: cashCloses.id })
        .from(cashCloses)
        .where(and(eq(cashCloses.custodianId, input.custodianId), gt(cashCloses.businessDate, input.businessDate)))
        .limit(1);
      if (later) throw new DomainError("A later day is already closed, so this day is covered by that count.");
      const { openingKobo, movedKobo } = await cashPosition(tx, input.custodianId, input.businessDate);
      const expectedKobo = openingKobo + movedKobo;
      const laterKobo = await cashAfter(tx, input.custodianId, input.businessDate);
      const countedKobo = input.counted - laterKobo;
      if (countedKobo < 0) {
        throw fieldError(
          "counted",
          `${formatNaira(laterKobo)} came in after ${formatDate(input.businessDate)}, so the cash in hand cannot be less than that`,
        );
      }
      if (countedKobo !== expectedKobo && !input.explanation) {
        throw fieldError("explanation", "Explain why the cash does not match");
      }
      const at = ctx.clock();
      const [row] = await tx
        .insert(cashCloses)
        .values({
          custodianId: input.custodianId,
          businessDate: input.businessDate,
          expectedKobo,
          countedKobo,
          explanation: input.explanation ?? null,
          closedBy: ctx.actor.userId,
          closedAt: at,
        })
        .returning({ id: cashCloses.id });
      const event = { id: row!.id, custodianId: input.custodianId, businessDate: input.businessDate, expectedKobo, countedKobo };
      await tellCashDifference(tx, ctx, { ...event, explanation: input.explanation ?? null });
      if (!leaving) await tellCashCounted(tx, ctx, event);
      await auditFrom(ctx, tx, {
        action: "cash.close",
        entityType: "cash_close",
        entityId: row!.id,
        after: { expectedKobo, countedKobo, inHandKobo: input.counted, laterKobo },
        reason: input.explanation,
      });

      let takenOverKobo = 0;
      if (leaving && countedKobo > 0) {
        if (ctx.actor.role !== "manager" || input.custodianId === ctx.actor.userId) {
          throw new DomainError("Only the Manager can take over the cash of someone who has left.");
        }
        const [transfer] = await tx
          .insert(moneyTransfers)
          .values({
            fromPlace: "cash",
            fromCustodian: input.custodianId,
            toPlace: "cash",
            toCustodian: ctx.actor.userId,
            amountKobo: countedKobo,
            note: `Taken over from ${holder.name}, who has left`,
            status: "done",
            createdBy: ctx.actor.userId,
            createdAt: at,
            decidedBy: ctx.actor.userId,
            decidedAt: at,
          })
          .returning({ id: moneyTransfers.id });
        const base = { amountKobo: countedKobo, sourceId: transfer!.id, at };
        await recordMovement(tx, { ...base, amountKobo: -countedKobo, custodianId: input.custodianId, sourceType: "transfer_out" });
        await recordMovement(tx, { ...base, custodianId: ctx.actor.userId, sourceType: "transfer_in" });
        takenOverKobo = countedKobo;
      }
      return { countedKobo, expectedKobo, laterKobo, takenOverKobo, name: holder.name };
    });
  } catch (error) {
    rethrowConstraint(error, { one_cash_close: new DomainError("This day has already been closed.") });
  }
}

const correctionSchema = z.object({
  counted: nairaField("Correct count"),
  reason: requiredText("Reason", 500),
});

/**
 * Puts right a mistyped count, once, with a reason. The original stays on
 * record. Only a person's latest close can be corrected, since a later count
 * started from this one. The Manager can correct anyone's; others their own.
 */
export async function correctCashCount(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "cash.close");
  const id = parseInput(idField("count"), rawId);
  const input = parseInput(correctionSchema, raw);
  try {
    await db.transaction(async (tx) => {
      const [close] = await tx.select().from(cashCloses).where(eq(cashCloses.id, id));
      if (!close) throw new DomainError("This count was not found.");
      if (close.custodianId !== ctx.actor.userId && ctx.actor.role !== "manager") {
        throw new DomainError("You can only correct your own count.");
      }
      await tx.select({ id: users.id }).from(users).where(eq(users.id, close.custodianId)).for("update");
      const [later] = await tx
        .select({ id: cashCloses.id })
        .from(cashCloses)
        .where(and(eq(cashCloses.custodianId, close.custodianId), gt(cashCloses.businessDate, close.businessDate)))
        .limit(1);
      if (later) throw new DomainError("A later count has been made since, so this one can no longer be corrected.");
      if (input.counted === close.countedKobo) throw fieldError("counted", "This is the same as the count already saved");
      await tx.insert(cashCloseCorrections).values({
        closeId: close.id,
        countedKobo: input.counted,
        reason: input.reason,
        correctedBy: ctx.actor.userId,
        correctedAt: ctx.clock(),
      });
      await tellCashCorrected(tx, ctx, {
        id: close.id,
        custodianId: close.custodianId,
        businessDate: close.businessDate,
        expectedKobo: close.expectedKobo,
        fromKobo: close.countedKobo,
        toKobo: input.counted,
        reason: input.reason,
      });
      await auditFrom(ctx, tx, {
        action: "cash.correct",
        entityType: "cash_close",
        entityId: close.id,
        before: { countedKobo: close.countedKobo },
        after: { countedKobo: input.counted },
        reason: input.reason,
      });
    });
  } catch (error) {
    rethrowConstraint(error, {
      cash_close_corrections_pkey: new DomainError("This count has already been corrected once."),
    });
  }
}

/* ---------- No-balance days ---------- */

export const listNonCollectionDays = (ctx: Ctx) => {
  requirePermission(ctx, "finance.view");
  return db.select().from(nonCollectionDays).orderBy(desc(nonCollectionDays.businessDate)).limit(100);
};

const dayError = () => new DomainError("Only a future date can be changed. Today's balances are already raised.");

export async function addNonCollectionDay(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "calendar.manage");
  const input = parseInput(
    z.object({ businessDate: dateField("Date"), reason: requiredText("Reason", 200) }),
    raw,
  );
  if (input.businessDate <= businessDate(ctx.clock())) throw dayError();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(nonCollectionDays)
      .values({ ...input, createdBy: ctx.actor.userId })
      .onConflictDoNothing()
      .returning();
    if (!row) throw fieldError("businessDate", "This date is already marked");
    await auditFrom(ctx, tx, {
      action: "calendar.add",
      entityType: "calendar",
      entityId: input.businessDate,
      reason: input.reason,
    });
  });
}

export async function removeNonCollectionDay(ctx: Ctx, date: string) {
  requirePermission(ctx, "calendar.manage");
  if (date <= businessDate(ctx.clock())) throw dayError();
  await db.transaction(async (tx) => {
    await tx.delete(nonCollectionDays).where(eq(nonCollectionDays.businessDate, date));
    await auditFrom(ctx, tx, {
      action: "calendar.remove",
      entityType: "calendar",
      entityId: date,
    });
  });
}

/* ---------- Dashboard ---------- */

/** Earlier than any business date, for "every day up to". */
const OLDEST = "2000-01-01";

export async function financeOverview(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const yesterday = addDays(today, -1);
  const [collections, arrears, older, toConfirm, alerts, lastRun, trail, advances, awardsWaiting, givenOut, loansOwed] = await Promise.all([
    collectionsFor(ctx, today),
    listArrears(ctx),
    // Older debts are the days before today; today's unpaid balances are today's Remaining.
    listArrears(ctx, { from: OLDEST, to: yesterday }),
    db.select({ value: count() }).from(violations).where(eq(violations.status, "proposed")),
    db.select({ value: count() }).from(dismissals).where(eq(dismissals.status, "flagged")),
    lastJobDate(),
    cashAlerts(db, today),
    advanceCounts(ctx),
    awardsToDecide(),
    givenOutOn(db, today),
    loansToCollect(db),
  ]);
  return {
    today,
    ...collections,
    ...givenOut,
    // Everyone who owes, including operators who have left, so Home adds up with the week and month.
    overdueOperators: older.length,
    overdueOwedKobo: older.reduce((sum, a) => sum + a.owed, 0),
    overdueFrom: older.reduce<string | null>((first, a) => (first === null || a.oldest < first ? a.oldest : first), null),
    yesterday,
    owedTotalKobo: arrears.reduce((sum, a) => sum + a.owed, 0),
    ...loansOwed,
    canCollect: can(ctx.actor.role, "payment.record"),
    toConfirm: toConfirm[0]?.value ?? 0,
    sackingAlerts: alerts[0]?.value ?? 0,
    ...trail,
    advances,
    awardsWaiting,
    jobIsCurrent: lastRun === today,
  };
}

export const operatorExists = async (id: string) => {
  const [row] = await db.select({ id: operators.id }).from(operators).where(and(eq(operators.id, id))).limit(1);
  return !!row;
};
