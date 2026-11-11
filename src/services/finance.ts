import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db";
import {
  cashCloseChecks,
  cashCloses,
  cashMovements,
  dismissals,
  nonCollectionDays,
  operators,
  users,
  violations,
} from "@/db/schema";
import { closeRhythm, coverageLabel } from "@/lib/cash-rhythm";
import { addDays, businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { dateField, idField, nairaField, optionalText, requiredText } from "@/lib/fields";
import type { DateRange } from "@/lib/periods";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { awardsToDecide } from "./awards";
import { cashAlerts, cashPosition, cashSinceLastClose, givenOutOn } from "./cash-book";
import { advanceCounts } from "./expenses";
import { openCharges, unallocatedPayments } from "./ledger";
import { lastJobDate } from "./daily-job";
import { loansToCollect } from "./loans";

/* ---------- Statements ---------- */

async function buildStatement(exec: Executor, operatorId: string) {
  const [balances, penalties, loanCharges, credits, chargeRows, paymentRows, awardRows] = await Promise.all([
    openCharges(exec, operatorId, "daily_balance"),
    openCharges(exec, operatorId, "penalty"),
    openCharges(exec, operatorId, "loan"),
    unallocatedPayments(exec, operatorId),
    exec.execute(sql`
      SELECT c.id, c.type::text AS type, c.amount_kobo::float8 AS amount,
             c.business_date::text AS business_date,
             EXISTS (SELECT 1 FROM charge_voids v WHERE v.charge_id = c.id) AS voided,
             COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                       WHERE e.charge_id = c.id), 0)::float8 AS paid
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
    awards: awardRows as unknown as {
      id: string;
      type: "consistency" | "clean_vehicle" | "law_abiding";
      given: string;
      given_on: string;
    }[],
    charges: chargeRows as unknown as {
      id: string;
      type: "daily_balance" | "penalty" | "loan";
      amount: number;
      business_date: string;
      voided: boolean;
      paid: number;
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
      SELECT c.operator_id, c.business_date,
             c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                       WHERE e.charge_id = c.id), 0) AS owed
      FROM valid_charges c WHERE c.type = 'daily_balance' ${inRange}
    )
    SELECT o.id, o.name, o.phone, o.status::text AS status,
           COUNT(*)::int AS days, SUM(open.owed)::float8 AS owed,
           MIN(open.business_date)::text AS oldest
    FROM open JOIN operators o ON o.id = open.operator_id
    WHERE open.owed > 0
    GROUP BY o.id ORDER BY days DESC, oldest
  `);
  return rows as unknown as {
    id: string;
    name: string;
    phone: string;
    status: "active" | "sacked" | "left";
    days: number;
    owed: number;
    oldest: string;
  }[];
}

/* ---------- Cash close ---------- */

export async function cashDay(ctx: Ctx, date: string) {
  requirePermission(ctx, "finance.view");
  const [custodians, closes, checks] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(sql`${users.role} IN ('manager', 'assistant_manager') AND ${users.status} = 'active'`)
      .orderBy(asc(users.name)),
    db.select().from(cashCloses).where(eq(cashCloses.businessDate, date)),
    db
      .select({ check: cashCloseChecks, closeDate: cashCloses.businessDate })
      .from(cashCloseChecks)
      .innerJoin(cashCloses, eq(cashCloses.id, cashCloseChecks.closeId))
      .where(eq(cashCloses.businessDate, date)),
  ]);
  return Promise.all(
    custodians.map(async (person) => {
      const [{ openingKobo, movedKobo }, covers] = await Promise.all([
        cashPosition(db, person.id, date),
        cashSinceLastClose(db, person.id, date),
      ]);
      const close = closes.find((c) => c.custodianId === person.id) ?? null;
      return {
        ...person,
        rhythm: closeRhythm(person.role),
        /** The days a count on this date covers, from the last count. */
        covers,
        openingKobo,
        movedKobo,
        expectedKobo: openingKobo + movedKobo,
        close,
        check: close ? (checks.find((row) => row.check.closeId === close.id)?.check ?? null) : null,
      };
    }),
  );
}

/** Counts still waiting for a second person, oldest first. */
export async function uncheckedCloses(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const rows = (await db.execute(sql`
    SELECT c.id, c.business_date::text AS date, u.name, u.role::text AS role,
           (SELECT MAX(p.business_date) FROM cash_closes p
            WHERE p.custodian_id = c.custodian_id AND p.business_date < c.business_date)::text AS previous,
           (SELECT MIN(m.business_date) FROM cash_movements m
            WHERE m.custodian_id = c.custodian_id AND m.business_date <= c.business_date)::text AS first_moved
    FROM cash_closes c JOIN users u ON u.id = c.custodian_id
    WHERE NOT EXISTS (SELECT 1 FROM cash_close_checks k WHERE k.close_id = c.id)
    ORDER BY c.business_date LIMIT 60
  `)) as unknown as { id: string; date: string; name: string; role: string; previous: string | null; first_moved: string | null }[];
  return rows.map((row) => {
    const from = row.previous ? addDays(row.previous, 1) : (row.first_moved ?? row.date);
    return { id: row.id, date: row.date, name: row.name, label: coverageLabel(from, row.date, closeRhythm(row.role)) };
  });
}

const checkSchema = z.object({ recounted: nairaField("Cash recounted"), note: optionalText() });

/** The person who counted cannot also check. A different recount becomes the amount carried forward. */
export async function checkCashClose(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "cash.check");
  const id = parseInput(idField("cash count"), rawId);
  const input = parseInput(checkSchema, raw);
  await db.transaction(async (tx) => {
    const [close] = await tx.select().from(cashCloses).where(eq(cashCloses.id, id));
    if (!close) throw new DomainError("Cash count not found.");
    if (close.closedBy === ctx.actor.userId) throw new DomainError("A different person must check this count.");
    if (input.recounted !== close.countedKobo && !input.note) {
      throw fieldError("note", "Explain why the recount is different");
    }
    const [row] = await tx
      .insert(cashCloseChecks)
      .values({
        closeId: id,
        checkedBy: ctx.actor.userId,
        recountedKobo: input.recounted,
        note: input.note ?? null,
        checkedAt: ctx.clock(),
      })
      .onConflictDoNothing()
      .returning({ id: cashCloseChecks.closeId });
    if (!row) throw new DomainError("This count has already been checked.");
    await auditFrom(ctx, tx, {
      action: "cash.check",
      entityType: "cash_close",
      entityId: id,
      before: { countedKobo: close.countedKobo },
      after: { recountedKobo: input.recounted },
      reason: input.note,
    });
  });
}

const closeSchema = z.object({
  custodianId: idField("person"),
  businessDate: dateField("Date"),
  counted: nairaField("Cash counted"),
  explanation: optionalText(),
});

export async function closeCash(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "cash.close");
  const input = parseInput(closeSchema, raw);
  if (input.custodianId !== ctx.actor.userId && ctx.actor.role !== "manager") {
    throw new DomainError("You can only close your own cash.");
  }
  if (input.businessDate > businessDate(ctx.clock())) {
    throw fieldError("businessDate", "You cannot close a future date");
  }
  try {
    await db.transaction(async (tx) => {
      const [later] = await tx
        .select({ id: cashCloses.id })
        .from(cashCloses)
        .where(and(eq(cashCloses.custodianId, input.custodianId), gt(cashCloses.businessDate, input.businessDate)))
        .limit(1);
      if (later) throw new DomainError("A later day is already closed, so this day is covered by that count.");
      const { openingKobo, movedKobo } = await cashPosition(tx, input.custodianId, input.businessDate);
      const expectedKobo = openingKobo + movedKobo;
      if (input.counted !== expectedKobo && !input.explanation) {
        throw fieldError("explanation", "Explain why the cash does not match");
      }
      const [row] = await tx
        .insert(cashCloses)
        .values({
          custodianId: input.custodianId,
          businessDate: input.businessDate,
          expectedKobo,
          countedKobo: input.counted,
          explanation: input.explanation ?? null,
          closedBy: ctx.actor.userId,
          closedAt: ctx.clock(),
        })
        .returning({ id: cashCloses.id });
      await auditFrom(ctx, tx, {
        action: "cash.close",
        entityType: "cash_close",
        entityId: row!.id,
        after: { expectedKobo, countedKobo: input.counted },
        reason: input.explanation,
      });
    });
  } catch (error) {
    rethrowConstraint(error, { one_cash_close: new DomainError("This day has already been closed.") });
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

export async function financeOverview(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const [collections, arrears, toConfirm, alerts, lastRun, trail, advances, awardsWaiting, givenOut, loansOwed] = await Promise.all([
    collectionsFor(ctx, today),
    listArrears(ctx),
    db.select({ value: count() }).from(violations).where(eq(violations.status, "proposed")),
    db.select({ value: count() }).from(dismissals).where(eq(dismissals.status, "flagged")),
    lastJobDate(),
    cashAlerts(db, today),
    advanceCounts(),
    awardsToDecide(),
    givenOutOn(db, today),
    loansToCollect(db),
  ]);
  const working = arrears.filter((a) => a.status === "active");
  return {
    today,
    ...collections,
    ...givenOut,
    overdueOperators: working.length,
    overdueOwedKobo: working.reduce((sum, a) => sum + a.owed, 0),
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
