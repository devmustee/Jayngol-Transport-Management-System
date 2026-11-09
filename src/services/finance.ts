import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db";
import {
  cashCloses,
  cashMovements,
  dismissals,
  nonCollectionDays,
  operators,
  smsOutbox,
  users,
  violations,
} from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { dateField, idField, nairaField, optionalText, requiredText } from "@/lib/fields";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { awardsToDecide } from "./awards";
import { expectedCash, givenOutOn } from "./cash-book";
import { advanceCounts } from "./expenses";
import { openCharges, unallocatedPayments } from "./ledger";
import { lastJobDate } from "./daily-job";

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

export async function listArrears(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const rows = await db.execute(sql`
    WITH open AS (
      SELECT c.operator_id, c.business_date,
             c.amount_kobo - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e
                                       WHERE e.charge_id = c.id), 0) AS owed
      FROM valid_charges c WHERE c.type = 'daily_balance'
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
  const [custodians, closes] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(sql`${users.role} IN ('manager', 'assistant_manager') AND ${users.status} = 'active'`)
      .orderBy(asc(users.name)),
    db.select().from(cashCloses).where(eq(cashCloses.businessDate, date)),
  ]);
  return Promise.all(
    custodians.map(async (person) => ({
      ...person,
      expectedKobo: await expectedCash(db, person.id, date),
      close: closes.find((c) => c.custodianId === person.id) ?? null,
    })),
  );
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
      const expectedKobo = await expectedCash(tx, input.custodianId, input.businessDate);
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
  const [collections, arrears, toConfirm, alerts, lastRun, pendingSms, advances, awardsWaiting, givenOut] = await Promise.all([
    collectionsFor(ctx, today),
    listArrears(ctx),
    db.select({ value: count() }).from(violations).where(eq(violations.status, "proposed")),
    db.select({ value: count() }).from(dismissals).where(eq(dismissals.status, "flagged")),
    lastJobDate(),
    db.select({ value: count() }).from(smsOutbox).where(eq(smsOutbox.status, "pending")),
    advanceCounts(),
    awardsToDecide(),
    givenOutOn(db, today),
  ]);
  return {
    today,
    ...collections,
    ...givenOut,
    overdueOperators: arrears.filter((a) => a.status === "active").length,
    canCollect: can(ctx.actor.role, "payment.record"),
    toConfirm: toConfirm[0]?.value ?? 0,
    sackingAlerts: alerts[0]?.value ?? 0,
    pendingSms: pendingSms[0]?.value ?? 0,
    advances,
    awardsWaiting,
    jobIsCurrent: lastRun === today,
  };
}

export const operatorExists = async (id: string) => {
  const [row] = await db.select({ id: operators.id }).from(operators).where(and(eq(operators.id, id))).limit(1);
  return !!row;
};
