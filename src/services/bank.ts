import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db";
import {
  bankMovements,
  bankOpeningCorrections,
  bankReconciliationCorrections,
  bankReconciliations,
  moneyTransfers,
  operatorDeposits,
  paymentReferences,
  payments,
} from "@/db/schema";
import { addMonths, businessDate } from "@/lib/clock";
import { asPgError, DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField, idField, optionalText, requiredText, signedNairaField } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { formatNaira, parseNairaToKobo } from "@/lib/money";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";

/** Keeps two bank changes from both seeing the same book. */
const lockBank = (tx: Executor) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bank_book'))`);

/** The opening balance in force: the latest correction, else the figure first set. */
const OPENING = sql`(SELECT o.id, o.account, o.at, o.source_type, o.source_id,
    COALESCE(c.amount_kobo, o.amount_kobo) AS amount_kobo, COALESCE(c.as_of, o.business_date) AS as_of
  FROM bank_movements o
  LEFT JOIN LATERAL (SELECT amount_kobo, as_of FROM bank_opening_corrections ORDER BY corrected_at DESC, id DESC LIMIT 1) c ON true
  WHERE o.source_type = 'opening_balance')`;

/** The first day the bank book counts. Bank money before it is already in the opening balance. */
const BOOK_STARTS = sql`COALESCE((SELECT fo.as_of FROM ${OPENING} fo), '-infinity'::date)`;

/**
 * Every bank and owner movement as the books count it: bank money from the
 * opening date on, with the opening balance in force. Shared with the cash
 * book so both show the same bank balance.
 */
export const BANK_BOOK = sql`(
  SELECT b.id, b.account, b.amount_kobo, b.business_date, b.source_type, b.source_id, b.at FROM bank_movements b
  WHERE b.source_type <> 'opening_balance' AND (b.account <> 'bank' OR b.business_date >= ${BOOK_STARTS})
  UNION ALL
  SELECT op.id, op.account, op.amount_kobo, op.as_of, op.source_type, op.source_id, op.at FROM ${OPENING} op)`;

/** A payment or saving by transfer or POS, or a teller deposit of cash into the bank. */
type Kind = "payment" | "deposit" | "transfer";

const LINK = {
  payment: paymentReferences.paymentId,
  deposit: paymentReferences.depositId,
  transfer: paymentReferences.transferId,
} as const;
const NOUN = { payment: "payment", deposit: "saving", transfer: "teller deposit" } as const;
const ENTITY = { payment: "payment", deposit: "operator_deposit", transfer: "money_transfer" } as const;

async function lockReference(tx: Executor, kind: Kind, id: string) {
  const link = LINK[kind];
  const state = { released: paymentReferences.releasedAt, confirmed: paymentReferences.confirmedAt };
  if (kind === "transfer") {
    const [row] = await tx
      .select({ ...state, receivedBy: moneyTransfers.createdBy, receipt: sql<string>`'teller ' || ${paymentReferences.reference}` })
      .from(paymentReferences)
      .innerJoin(moneyTransfers, eq(moneyTransfers.id, link))
      .where(eq(link, id))
      .for("update", { of: paymentReferences });
    return row;
  }
  const owner = kind === "payment" ? payments : operatorDeposits;
  const [row] = await tx
    .select({ ...state, receivedBy: owner.receivedBy, receipt: owner.receiptNumber })
    .from(paymentReferences)
    .innerJoin(owner, eq(owner.id, link))
    .where(eq(link, id))
    .for("update", { of: paymentReferences });
  return row;
}

/** Confirms one transfer, POS or teller deposit against the statement. Returns false when it was already confirmed. */
async function confirmOne(tx: Executor, ctx: Ctx, kind: Kind, id: string, now: Date) {
  const link = LINK[kind];
  const row = await lockReference(tx, kind, id);
  const noun = NOUN[kind];
  if (!row || row.released) throw new DomainError(`This ${noun} is no longer on record.`);
  if (row.confirmed) return false;
  if (row.receivedBy === ctx.actor.userId) {
    throw new DomainError(`A different person must confirm ${row.receipt}, which you recorded.`);
  }
  await tx
    .update(paymentReferences)
    .set({ confirmedBy: ctx.actor.userId, confirmedAt: now })
    .where(and(eq(link, id), isNull(paymentReferences.confirmedAt)));
  await auditFrom(ctx, tx, { action: "bank.confirm", entityType: ENTITY[kind], entityId: id });
  return true;
}

async function confirmSingle(ctx: Ctx, kind: Kind, rawId: unknown) {
  requirePermission(ctx, "bank.reconcile");
  const id = parseInput(idField(kind), rawId);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    if (!(await confirmOne(tx, ctx, kind, id, now))) {
      throw new DomainError(`This ${NOUN[kind]} has already been confirmed.`);
    }
  });
}

/** Only "the other person" can confirm money against the statement. */
export const confirmBankPayment = (ctx: Ctx, rawId: unknown) => confirmSingle(ctx, "payment", rawId);
export const confirmBankDeposit = (ctx: Ctx, rawId: unknown) => confirmSingle(ctx, "deposit", rawId);
export const confirmBankTeller = (ctx: Ctx, rawId: unknown) => confirmSingle(ctx, "transfer", rawId);

const ITEM = /^(payment|deposit|transfer):([0-9a-f-]{36})$/i;
const itemsSchema = z.object({
  items: z
    .array(z.string().regex(ITEM, "Choose what was seen on the statement"), "Tick what was seen on the statement")
    .min(1, "Tick what was seen on the statement")
    .max(200, "Confirm at most 200 at a time"),
});

/** Confirms several at once, all or none. Ones someone else confirmed meanwhile are skipped. */
export async function confirmBankItems(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "bank.reconcile");
  const { items } = parseInput(itemsSchema, raw);
  const now = ctx.clock();
  const unique = [...new Set(items.map((item) => item.toLowerCase()))];
  return db.transaction(async (tx) => {
    let confirmed = 0;
    for (const item of unique) {
      const [, kind, id] = ITEM.exec(item)!;
      if (await confirmOne(tx, ctx, kind as Kind, parseInput(idField(kind!), id), now)) confirmed += 1;
    }
    return { confirmed };
  });
}

const undoSchema = z.object({ kind: z.enum(["payment", "deposit", "transfer"], "Choose what to undo"), id: idField("item") });

/** Undoes a confirmation made by mistake, by the same person, the same day. */
export async function undoBankConfirm(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "bank.reconcile");
  const { kind, id } = parseInput(undoSchema, raw);
  const link = LINK[kind];
  const today = businessDate(ctx.clock());
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ by: paymentReferences.confirmedBy, at: paymentReferences.confirmedAt, released: paymentReferences.releasedAt })
      .from(paymentReferences)
      .where(eq(link, id))
      .for("update");
    if (!row || row.released) throw new DomainError("This is no longer on record.");
    if (!row.at) throw new DomainError("This has not been confirmed.");
    if (row.by !== ctx.actor.userId) throw new DomainError("Only the person who confirmed it can undo it.");
    if (businessDate(row.at) !== today) throw new DomainError("Only a confirmation made today can be undone.");
    await tx.update(paymentReferences).set({ confirmedBy: null, confirmedAt: null }).where(eq(link, id));
    await auditFrom(ctx, tx, {
      action: "bank.unconfirm",
      entityType: ENTITY[kind],
      entityId: id,
    });
  });
}

async function openingNow(exec: Executor) {
  const rows = (await exec.execute(sql`SELECT amount_kobo::float8 AS amount, as_of::text AS as_of FROM ${OPENING} op`)) as unknown as {
    amount: number;
    as_of: string;
  }[];
  return rows[0] ? { amountKobo: rows[0].amount, asOf: rows[0].as_of } : null;
}

const openingSchema = z.object({ amount: signedNairaField("Opening balance"), date: dateField("Date") });

export async function setOpeningBalance(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "bank.opening");
  const input = parseInput(openingSchema, raw);
  if (input.date > businessDate(ctx.clock())) throw fieldError("date", "The date cannot be in the future");
  try {
    await db.transaction(async (tx) => {
      await lockBank(tx);
      await tx.insert(bankMovements).values({
        amountKobo: input.amount,
        businessDate: input.date,
        sourceType: "opening_balance",
        sourceId: "opening",
        at: ctx.clock(),
      });
      await auditFrom(ctx, tx, {
        action: "bank.opening",
        entityType: "bank",
        entityId: "opening",
        after: { amountKobo: input.amount, date: input.date },
      });
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "one_opening_balance") {
      throw new DomainError("The opening balance has already been set.");
    }
    throw error;
  }
}

const correctOpeningSchema = z.object({
  amount: signedNairaField("Opening balance"),
  date: dateField("Date"),
  reason: requiredText("Reason", 500),
});

/**
 * Corrects a mistyped opening balance. Only until a month is reconciled:
 * after that the books have been checked against the bank, and a mistake is
 * corrected on the month instead. Every figure stays on record.
 */
export async function correctOpeningBalance(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "bank.opening");
  const input = parseInput(correctOpeningSchema, raw);
  if (input.date > businessDate(ctx.clock())) throw fieldError("date", "The date cannot be in the future");
  await db.transaction(async (tx) => {
    await lockBank(tx);
    const before = await openingNow(tx);
    if (!before) throw new DomainError("Set the opening balance first.");
    const [reconciled] = await tx.select({ id: bankReconciliations.id }).from(bankReconciliations).limit(1);
    if (reconciled) {
      throw new DomainError("A month has been reconciled, so the opening balance is fixed. Correct that month's statement figure instead.");
    }
    if (before.amountKobo === input.amount && before.asOf === input.date) {
      throw fieldError("amount", "This is the opening balance already");
    }
    // The latest correction counts, so each one is stamped after the one before, even within the same millisecond.
    const [last] = await tx
      .select({ at: bankOpeningCorrections.correctedAt })
      .from(bankOpeningCorrections)
      .orderBy(desc(bankOpeningCorrections.correctedAt))
      .limit(1);
    const now = ctx.clock();
    await tx.insert(bankOpeningCorrections).values({
      amountKobo: input.amount,
      asOf: input.date,
      reason: input.reason,
      correctedBy: ctx.actor.userId,
      correctedAt: last && last.at >= now ? new Date(last.at.getTime() + 1) : now,
    });
    await auditFrom(ctx, tx, {
      action: "bank.opening_correct",
      entityType: "bank",
      entityId: "opening",
      before: { amountKobo: before.amountKobo, date: before.asOf },
      after: { amountKobo: input.amount, date: input.date },
      reason: input.reason,
    });
  });
}

/** What each bank reference belongs to: a payment, a saving, or a teller deposit from staff cash. */
const REFERENCE_OWNERS = sql`
  LEFT JOIN payments p ON p.id = r.payment_id
  LEFT JOIN operator_deposits d ON d.id = r.deposit_id
  LEFT JOIN money_transfers t ON t.id = r.transfer_id
  LEFT JOIN operators o ON o.id = COALESCE(p.operator_id, d.operator_id)
  LEFT JOIN users tu ON tu.id = t.created_by`;
const REF_AMOUNT = sql`COALESCE(p.amount_kobo, d.amount_kobo, t.amount_kobo)`;
const REF_DATE = sql`COALESCE(p.business_date, d.business_date, (t.created_at AT TIME ZONE 'Africa/Lagos')::date)`;
/** For a teller deposit, the person who paid it in stands where the operator would. */
const REF_WHO = sql`COALESCE(o.name, tu.name)`;

/** The bank book before a date: the balance, and how much of it the statement has not yet shown. */
export async function bookAt(exec: Executor, before: string) {
  const rows = (await exec.execute(sql`
    SELECT
      (SELECT COALESCE(SUM(amount_kobo), 0)::float8 FROM ${BANK_BOOK} b
        WHERE account = 'bank' AND business_date < ${before}::date) AS book,
      (SELECT COALESCE(SUM(${REF_AMOUNT}), 0)::float8 FROM payment_references r ${REFERENCE_OWNERS}
        WHERE r.released_at IS NULL AND r.confirmed_at IS NULL
          AND ${REF_DATE} >= ${BOOK_STARTS}
          AND ${REF_DATE} < ${before}::date) AS unconfirmed
  `)) as unknown as { book: number; unconfirmed: number }[];
  return { bookKobo: rows[0]?.book ?? 0, unconfirmedKobo: rows[0]?.unconfirmed ?? 0 };
}

/** What the bank book and the Owner hold now, for the move form. The bank figure is null until an opening balance is set. */
export async function bankAndOwnerHeld(exec: Executor) {
  const [opening, { bookKobo }, rows] = await Promise.all([
    openingNow(exec),
    bookAt(exec, "infinity"),
    exec.execute(sql`SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS held FROM ${BANK_BOOK} b WHERE account = 'owner'`),
  ]);
  return { bankKobo: opening ? bookKobo : null, ownerKobo: (rows as unknown as { held: number }[])[0]?.held ?? 0 };
}

/**
 * Refuses to take more out of the bank than the book shows, once an opening
 * balance makes the book worth trusting. Before that, says the book could not
 * be checked. The lock keeps two moves from both seeing the same balance.
 */
export async function checkBankHolds(tx: Executor, amountKobo: number, field: string) {
  await lockBank(tx);
  if (!(await openingNow(tx))) return { checked: false as const };
  const { bookKobo } = await bookAt(tx, "infinity");
  if (amountKobo > bookKobo) throw fieldError(field, `The bank book shows only ${formatNaira(Math.max(bookKobo, 0))}`);
  return { checked: true as const };
}

const reconcileSchema = z.object({
  month: z.string("Choose the month").regex(/^\d{4}-\d{2}$/, "Choose the month"),
  statement: signedNairaField("Statement balance"),
  explanation: optionalText(),
});

/** Compares the month-end book balance with the bank's own figure and freezes the result. */
export async function recordReconciliation(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "bank.reconcile");
  const input = parseInput(reconcileSchema, raw);
  const first = `${input.month}-01`;
  const next = addMonths(first, 1);
  if (next > businessDate(ctx.clock())) throw fieldError("month", "You can only reconcile a month that has ended");
  try {
    await db.transaction(async (tx) => {
      await lockBank(tx);
      const opening = await openingNow(tx);
      if (!opening) throw new DomainError("Set the opening bank balance first, so the books have somewhere to start.");
      if (first < `${opening.asOf.slice(0, 7)}-01`) {
        throw fieldError("month", `The books start on ${formatDate(opening.asOf)}. Choose that month or later`);
      }
      const { bookKobo, unconfirmedKobo } = await bookAt(tx, next);
      if (input.statement !== bookKobo && !input.explanation) {
        throw fieldError("explanation", "Explain the difference");
      }
      await tx.insert(bankReconciliations).values({
        month: first,
        statementKobo: input.statement,
        bookKobo,
        unconfirmedKobo,
        explanation: input.explanation ?? null,
        recordedBy: ctx.actor.userId,
        createdAt: ctx.clock(),
      });
      await auditFrom(ctx, tx, {
        action: "bank.reconcile",
        entityType: "bank",
        entityId: first,
        after: { statementKobo: input.statement, bookKobo, unconfirmedKobo },
        reason: input.explanation,
      });
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "bank_reconciliations_month_unique") {
      throw fieldError("month", "This month has already been reconciled");
    }
    throw error;
  }
}

const correctReconciliationSchema = z.object({
  statement: signedNairaField("Statement balance"),
  explanation: optionalText(),
  reason: requiredText("Reason", 500),
});

/**
 * Corrects a mistyped statement figure, once. The books' figures stay frozen,
 * and the first statement figure stays on record beside the correction.
 */
export async function correctReconciliation(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "bank.reconcile");
  const id = parseInput(idField("reconciliation"), rawId);
  const input = parseInput(correctReconciliationSchema, raw);
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(bankReconciliations).where(eq(bankReconciliations.id, id));
      if (!row) throw new DomainError("This reconciliation is no longer on record.");
      if (input.statement === row.statementKobo) throw fieldError("statement", "This is the statement figure already");
      if (input.statement !== row.bookKobo && !input.explanation) {
        throw fieldError("explanation", "Explain the difference");
      }
      await tx.insert(bankReconciliationCorrections).values({
        reconciliationId: id,
        statementKobo: input.statement,
        explanation: input.explanation ?? null,
        reason: input.reason,
        correctedBy: ctx.actor.userId,
        correctedAt: ctx.clock(),
      });
      await auditFrom(ctx, tx, {
        action: "bank.reconcile_correct",
        entityType: "bank",
        entityId: row.month,
        before: { statementKobo: row.statementKobo, explanation: row.explanation },
        after: { statementKobo: input.statement, explanation: input.explanation ?? null },
        reason: input.reason,
      });
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "bank_reconciliation_corrections_pkey") {
      throw new DomainError("This month has already been corrected once.");
    }
    throw error;
  }
}

export type ToConfirm = {
  id: string;
  kind: Kind;
  receipt: string;
  amount: number;
  method: string;
  date: string;
  received_by: string;
  reference: string;
  operator: string;
  confirmed_by?: string | null;
  confirmed_by_name?: string | null;
};

const TO_CONFIRM_LIMIT = 60;

const ITEMS = sql`
  SELECT COALESCE(p.id, d.id, t.id) AS id,
         CASE WHEN r.payment_id IS NOT NULL THEN 'payment' WHEN r.deposit_id IS NOT NULL THEN 'deposit' ELSE 'transfer' END AS kind,
         COALESCE(p.receipt_number, d.receipt_number, 'Teller') AS receipt,
         ${REF_AMOUNT}::float8 AS amount,
         COALESCE(p.method::text, d.method::text, 'teller') AS method,
         ${REF_DATE}::text AS date,
         COALESCE(p.received_by, d.received_by, t.created_by) AS received_by, r.reference, ${REF_WHO} AS operator,
         r.confirmed_by, cu.name AS confirmed_by_name
  FROM payment_references r ${REFERENCE_OWNERS}
  LEFT JOIN users cu ON cu.id = r.confirmed_by
  WHERE r.released_at IS NULL`;

export async function bankPosition(ctx: Ctx, options: { q?: string | null } = {}) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const q = options.q?.trim().slice(0, 60) || null;
  const qKobo = q ? parseNairaToKobo(q) : null;
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const match = like
    ? sql`AND (r.reference ILIKE ${like} OR COALESCE(p.receipt_number, d.receipt_number) ILIKE ${like} OR ${REF_WHO} ILIKE ${like}
          ${qKobo !== null ? sql`OR ${REF_AMOUNT} = ${qKobo}` : sql``})`
    : sql``;
  const [toConfirm, waiting, confirmedToday, opening, openingFirst, openingCorrections, history, months, position] = await Promise.all([
    db.execute(sql`${ITEMS} AND r.confirmed_at IS NULL ${match} ORDER BY date, receipt LIMIT ${TO_CONFIRM_LIMIT}`),
    db.execute(sql`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(${REF_AMOUNT}), 0)::float8 AS amount,
             COUNT(*) FILTER (WHERE true ${match})::int AS matched
      FROM payment_references r ${REFERENCE_OWNERS}
      WHERE r.released_at IS NULL AND r.confirmed_at IS NULL
    `),
    db.execute(sql`${ITEMS} AND r.confirmed_at IS NOT NULL
      AND (r.confirmed_at AT TIME ZONE 'Africa/Lagos')::date = ${today}::date
      ORDER BY r.confirmed_at DESC LIMIT 100`),
    openingNow(db),
    db.select({ amountKobo: bankMovements.amountKobo, date: bankMovements.businessDate, at: bankMovements.at })
      .from(bankMovements)
      .where(eq(bankMovements.sourceType, "opening_balance"))
      .limit(1),
    db.execute(sql`
      SELECT c.id, c.amount_kobo::float8 AS amount, c.as_of::text AS as_of, c.reason, c.corrected_at, u.name AS by
      FROM bank_opening_corrections c JOIN users u ON u.id = c.corrected_by
      ORDER BY c.corrected_at DESC, c.id DESC
    `),
    db.execute(sql`
      SELECT r.id, r.month::text AS month, r.statement_kobo::float8 AS statement, r.book_kobo::float8 AS book,
             r.unconfirmed_kobo::float8 AS unconfirmed, r.explanation, r.created_at, ru.name AS recorded_by,
             c.statement_kobo::float8 AS corrected_statement, c.explanation AS corrected_explanation, c.reason AS correction_reason,
             c.corrected_at, cu.name AS corrected_by
      FROM bank_reconciliations r
      JOIN users ru ON ru.id = r.recorded_by
      LEFT JOIN bank_reconciliation_corrections c ON c.reconciliation_id = r.id
      LEFT JOIN users cu ON cu.id = c.corrected_by
      ORDER BY r.month DESC LIMIT 24
    `),
    db.execute(sql`SELECT to_char(month, 'YYYY-MM') AS month FROM bank_reconciliations`),
    bookAt(db, "infinity"),
  ]);
  const totals = (waiting as unknown as { count: number; amount: number; matched: number }[])[0]!;
  const lastMonth = addMonths(today, -1).slice(0, 7);
  const done = new Set((months as unknown as { month: string }[]).map((row) => row.month));

  // The first month from the opening on that has ended and is not reconciled.
  let nextMonth: string | null = null;
  if (opening) {
    for (let month = opening.asOf.slice(0, 7); month <= lastMonth; month = addMonths(`${month}-01`, 1).slice(0, 7)) {
      if (!done.has(month)) {
        nextMonth = month;
        break;
      }
    }
  }

  return {
    today,
    ...position,
    q,
    toConfirm: toConfirm as unknown as ToConfirm[],
    /** Everything waiting, whatever the search. */
    waitingCount: totals.count,
    waitingKobo: totals.amount,
    /** How many the search matches. */
    matchedCount: totals.matched,
    confirmedToday: confirmedToday as unknown as ToConfirm[],
    hasOpening: opening !== null,
    opening: opening && openingFirst[0]
      ? {
          ...opening,
          first: openingFirst[0],
          corrections: openingCorrections as unknown as {
            id: string;
            amount: number;
            as_of: string;
            reason: string;
            corrected_at: Date;
            by: string;
          }[],
        }
      : null,
    history: history as unknown as {
      id: string;
      month: string;
      statement: number;
      book: number;
      unconfirmed: number;
      explanation: string | null;
      created_at: Date;
      recorded_by: string;
      corrected_statement: number | null;
      corrected_explanation: string | null;
      correction_reason: string | null;
      corrected_at: Date | null;
      corrected_by: string | null;
    }[],
    userId: ctx.actor.userId,
    canReconcile: can(ctx.actor.role, "bank.reconcile"),
    canSetOpening: can(ctx.actor.role, "bank.opening"),
    /** The opening can be corrected until the first month is reconciled. */
    canCorrectOpening: can(ctx.actor.role, "bank.opening") && opening !== null && done.size === 0,
    lastMonth,
    nextMonth,
  };
}
