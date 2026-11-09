import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import { bankMovements, cashCloses, cashMovements, users } from "@/db/schema";
import { addDays, businessDate } from "@/lib/clock";
import { DomainError, fieldError } from "@/lib/errors";
import { isUuid } from "@/lib/fields";
import { formatNaira } from "@/lib/money";
import { requirePermission, type Ctx } from "./context";

export type BankSide = "bank" | "owner";

/** Cash taken after a custodian has closed the day counts towards the next day. */
export async function cashDate(exec: Executor, custodianId: string, today: string): Promise<string> {
  const [closed] = await exec
    .select({ id: cashCloses.id })
    .from(cashCloses)
    .where(and(eq(cashCloses.custodianId, custodianId), eq(cashCloses.businessDate, today)));
  return closed ? addDays(today, 1) : today;
}

/**
 * Cash stays with a person until it is recorded leaving. The day starts from the
 * last count, plus anything that moved on days nobody closed.
 */
export async function cashPosition(exec: Executor, custodianId: string, date: string) {
  const rows = (await exec.execute(sql`
    WITH last AS (
      SELECT c.business_date, COALESCE(k.recounted_kobo, c.counted_kobo) AS held
      FROM cash_closes c LEFT JOIN cash_close_checks k ON k.close_id = c.id
      WHERE c.custodian_id = ${custodianId} AND c.business_date < ${date}::date
      ORDER BY c.business_date DESC LIMIT 1
    )
    SELECT
      (COALESCE((SELECT held FROM last), 0)
        + COALESCE(SUM(m.amount_kobo) FILTER (WHERE m.business_date < ${date}::date), 0))::float8 AS opening,
      COALESCE(SUM(m.amount_kobo) FILTER (WHERE m.business_date = ${date}::date), 0)::float8 AS moved
    FROM cash_movements m
    WHERE m.custodian_id = ${custodianId} AND m.business_date <= ${date}::date
      AND m.business_date > COALESCE((SELECT business_date FROM last), '-infinity'::date)
  `)) as unknown as { opening: number; moved: number }[];
  return { openingKobo: rows[0]?.opening ?? 0, movedKobo: rows[0]?.moved ?? 0 };
}

export const expectedCash = async (exec: Executor, custodianId: string, date: string) => {
  const { openingKobo, movedKobo } = await cashPosition(exec, custodianId, date);
  return openingKobo + movedKobo;
};

/** Cash held by a person, or money from the bank or the owner. */
export const moneySourceField = z
  .string("Choose where the money came from")
  .refine((value) => value === "bank" || value === "owner" || isUuid(value), "Choose where the money came from")
  .transform((value) =>
    isUuid(value)
      ? { custodianId: value as string | null, account: "bank" as BankSide }
      : { custodianId: null as string | null, account: value as BankSide },
  );

type Movement = {
  custodianId: string | null;
  /** Used only when no person holds the money. */
  account?: BankSide;
  amountKobo: number;
  sourceType: string;
  sourceId: string;
  at: Date;
};

export async function recordMovement(tx: Tx, movement: Movement) {
  const { custodianId, account = "bank", ...rest } = movement;
  const today = businessDate(movement.at);
  if (custodianId) {
    await tx.insert(cashMovements).values({
      ...rest,
      custodianId,
      businessDate: await cashDate(tx, custodianId, today),
    });
  } else {
    await tx.insert(bankMovements).values({ ...rest, account, businessDate: today });
  }
}

/** Only active office staff can hold company cash. */
export async function lockCashHolder(tx: Tx, custodianId: string, field: string) {
  const [holder] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, custodianId))
    .for("update");
  if (!holder || holder.status !== "active" || !["manager", "assistant_manager"].includes(holder.role)) {
    throw fieldError(field, "Choose a Manager or Assistant Manager");
  }
}

export async function assertCashHeld(tx: Tx, custodianId: string, amountKobo: number, at: Date, field: string) {
  const date = await cashDate(tx, custodianId, businessDate(at));
  const available = await expectedCash(tx, custodianId, date);
  if (amountKobo > available) {
    throw fieldError(field, `Only ${formatNaira(available)} in cash is held by this person`);
  }
}

/** Refuses to hand out cash the person does not hold, so a count can never go negative. */
export async function takeMoneyOut(tx: Tx, movement: Movement, field = "source") {
  if (movement.custodianId) {
    await lockCashHolder(tx, movement.custodianId, field);
    await assertCashHeld(tx, movement.custodianId, movement.amountKobo, movement.at, field);
  }
  await recordMovement(tx, { ...movement, amountKobo: -movement.amountKobo });
}

/** What needs someone's attention before the cash trail can be trusted. */
export async function cashAlerts(exec: Executor, today: string) {
  const [notClosed, counts] = await Promise.all([
    exec.execute(sql`
      SELECT u.name, MIN(m.business_date)::text AS since
      FROM cash_movements m JOIN users u ON u.id = m.custodian_id
      WHERE m.business_date < ${today}::date
        AND m.business_date > COALESCE(
          (SELECT MAX(c.business_date) FROM cash_closes c WHERE c.custodian_id = m.custodian_id), '-infinity'::date)
      GROUP BY u.id, u.name ORDER BY u.name
    `),
    exec.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM cash_closes c
          WHERE NOT EXISTS (SELECT 1 FROM cash_close_checks k WHERE k.close_id = c.id)) AS closes,
        (SELECT COUNT(*)::int FROM money_transfers WHERE status = 'pending') AS handovers,
        (SELECT COUNT(*)::int FROM payment_references
          WHERE released_at IS NULL AND confirmed_at IS NULL) AS bank
    `),
  ]);
  const row = (counts as unknown as { closes: number; handovers: number; bank: number }[])[0];
  return {
    cashNotClosed: notClosed as unknown as { name: string; since: string }[],
    closesToCheck: row?.closes ?? 0,
    handoversWaiting: row?.handovers ?? 0,
    bankToCheck: row?.bank ?? 0,
  };
}

/** Who money can come from, with the cash each person holds today. */
export async function moneySources(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const people = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.role, ["manager", "assistant_manager"]), eq(users.status, "active")))
    .orderBy(users.name);
  return Promise.all(
    people.map(async (person) => ({
      ...person,
      availableKobo: await expectedCash(db, person.id, await cashDate(db, person.id, today)),
    })),
  );
}

/**
 * Loans and expense funds paid on a date out of collected cash. Money from the
 * bank or owner is left out. Change handed back and cancellations reduce the total.
 */
export async function givenOutOn(exec: Executor, date: string) {
  const rows = (await exec.execute(sql`
    SELECT
      COALESCE(-SUM(amount_kobo) FILTER (WHERE source_type IN ('loan', 'loan_cancel')), 0)::float8 AS loans,
      COALESCE(-SUM(amount_kobo) FILTER (WHERE source_type LIKE 'expense_%'), 0)::float8 AS expenses
    FROM cash_movements
    WHERE (at AT TIME ZONE 'Africa/Lagos')::date = ${date}::date
  `)) as unknown as { loans: number; expenses: number }[];
  return { loansKobo: rows[0]?.loans ?? 0, expensesKobo: rows[0]?.expenses ?? 0 };
}

const BOOK_LIMIT = 400;

export type BookRow = {
  id: string;
  account: "cash" | "bank" | "owner";
  amount: number;
  date: string;
  at: Date;
  source_type: string;
  custodian: string | null;
  receipt: string | null;
  operator: string | null;
  purpose: string | null;
  payment_id: string | null;
  deposit_id: string | null;
  advance_id: string | null;
  loan_id: string | null;
  transfer_id: string | null;
};

/** Every naira in and out over a period. Each line is a movement, never a calculation. */
export async function cashBook(ctx: Ctx, range: { from: string; to: string }) {
  requirePermission(ctx, "finance.view");
  if (range.from > range.to) throw new DomainError("The start date is after the end date.");
  const book = sql`
    SELECT m.id, 'cash' AS account, m.custodian_id, m.amount_kobo, m.business_date, m.source_type, m.source_id, m.at
    FROM cash_movements m WHERE m.business_date BETWEEN ${range.from}::date AND ${range.to}::date
    UNION ALL
    SELECT b.id, b.account::text, NULL, b.amount_kobo, b.business_date, b.source_type, b.source_id, b.at
    FROM bank_movements b WHERE b.business_date BETWEEN ${range.from}::date AND ${range.to}::date
  `;
  const [rows, totals] = await Promise.all([
    db.execute(sql`
      WITH book AS (${book})
      SELECT b.id, b.account, b.amount_kobo::float8 AS amount, b.business_date::text AS date, b.at, b.source_type,
             u.name AS custodian, COALESCE(p.receipt_number, d.receipt_number) AS receipt,
             COALESCE(po.name, dpo.name, lo.name) AS operator,
             COALESCE(a.purpose, la.purpose, mt.note, mt.reference) AS purpose,
             p.id AS payment_id, d.id AS deposit_id, COALESCE(a.id, la.id) AS advance_id, l.id AS loan_id, mt.id AS transfer_id
      FROM book b
      LEFT JOIN users u ON u.id = b.custodian_id
      LEFT JOIN payments p ON b.source_type IN ('payment', 'payment_reversal') AND p.id::text = b.source_id
      LEFT JOIN operators po ON po.id = p.operator_id
      LEFT JOIN operator_deposits d ON b.source_type IN ('deposit', 'deposit_reversal') AND d.id::text = b.source_id
      LEFT JOIN operators dpo ON dpo.id = d.operator_id
      LEFT JOIN expense_advances a ON b.source_type IN ('expense_advance', 'expense_advance_cancel') AND a.id::text = b.source_id
      LEFT JOIN expense_lines el ON b.source_type IN ('expense_change', 'expense_change_void') AND el.id::text = b.source_id
      LEFT JOIN expense_advances la ON la.id = el.advance_id
      LEFT JOIN loans l ON b.source_type IN ('loan', 'loan_cancel') AND l.id::text = b.source_id
      LEFT JOIN operators lo ON lo.id = l.operator_id
      LEFT JOIN money_transfers mt ON b.source_type LIKE 'transfer_%' AND mt.id::text = b.source_id
      ORDER BY b.at DESC, b.id
      LIMIT ${BOOK_LIMIT + 1}
    `),
    db.execute(sql`
      WITH book AS (${book})
      SELECT account, source_type,
             COALESCE(SUM(amount_kobo) FILTER (WHERE amount_kobo > 0), 0)::float8 AS money_in,
             COALESCE(-SUM(amount_kobo) FILTER (WHERE amount_kobo < 0), 0)::float8 AS money_out
      FROM book GROUP BY account, source_type
    `),
  ]);
  const all = rows as unknown as BookRow[];
  const groups = totals as unknown as {
    account: "cash" | "bank" | "owner";
    source_type: string;
    money_in: number;
    money_out: number;
  }[];
  const side = (account: "cash" | "bank" | "owner") => {
    const lines = groups.filter((group) => group.account === account);
    const moneyIn = lines.reduce((sum, group) => sum + group.money_in, 0);
    const moneyOut = lines.reduce((sum, group) => sum + group.money_out, 0);
    return { moneyIn, moneyOut, net: moneyIn - moneyOut };
  };
  return {
    rows: all.slice(0, BOOK_LIMIT),
    truncated: all.length > BOOK_LIMIT,
    cash: side("cash"),
    bank: side("bank"),
    owner: side("owner"),
    bySource: groups,
  };
}
