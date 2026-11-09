import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import { bankMovements, cashCloses, cashMovements, users } from "@/db/schema";
import { addDays, businessDate } from "@/lib/clock";
import { DomainError, fieldError } from "@/lib/errors";
import { isUuid } from "@/lib/fields";
import { formatNaira } from "@/lib/money";
import { requirePermission, type Ctx } from "./context";

/** Cash taken after a custodian has closed the day counts towards the next day. */
export async function cashDate(exec: Executor, custodianId: string, today: string): Promise<string> {
  const [closed] = await exec
    .select({ id: cashCloses.id })
    .from(cashCloses)
    .where(and(eq(cashCloses.custodianId, custodianId), eq(cashCloses.businessDate, today)));
  return closed ? addDays(today, 1) : today;
}

export const expectedCash = async (exec: Executor, custodianId: string, date: string) => {
  const rows = (await exec.execute(sql`
    SELECT COALESCE(SUM(amount_kobo), 0)::float8 AS total FROM cash_movements
    WHERE custodian_id = ${custodianId} AND business_date = ${date}::date
  `)) as unknown as { total: number }[];
  return rows[0]?.total ?? 0;
};

/** A person holding cash, or "bank" for money that never passed through anyone's hands. */
export const moneySourceField = z
  .string("Choose where the money came from")
  .refine((value) => value === "bank" || isUuid(value), "Choose where the money came from")
  .transform((value) => (value === "bank" ? null : value));

type Movement = {
  custodianId: string | null;
  amountKobo: number;
  sourceType: string;
  sourceId: string;
  at: Date;
};

export async function recordMovement(tx: Tx, movement: Movement) {
  const { custodianId, ...rest } = movement;
  const today = businessDate(movement.at);
  if (custodianId) {
    await tx.insert(cashMovements).values({
      ...rest,
      custodianId,
      businessDate: await cashDate(tx, custodianId, today),
    });
  } else {
    await tx.insert(bankMovements).values({ ...rest, businessDate: today });
  }
}

/** Refuses to hand out cash the person does not hold today, so a count can never go negative. */
export async function takeMoneyOut(tx: Tx, movement: Movement) {
  if (movement.custodianId) {
    const [holder] = await tx
      .select({ role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, movement.custodianId))
      .for("update");
    if (!holder || holder.status !== "active" || !["manager", "assistant_manager"].includes(holder.role)) {
      throw fieldError("source", "Choose where the money came from");
    }
    const date = await cashDate(tx, movement.custodianId, businessDate(movement.at));
    const available = await expectedCash(tx, movement.custodianId, date);
    if (movement.amountKobo > available) {
      throw fieldError("source", `Only ${formatNaira(available)} in cash is available from this person today`);
    }
  }
  await recordMovement(tx, { ...movement, amountKobo: -movement.amountKobo });
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
  account: "cash" | "bank";
  amount: number;
  date: string;
  at: Date;
  source_type: string;
  custodian: string | null;
  receipt: string | null;
  operator: string | null;
  purpose: string | null;
  payment_id: string | null;
  advance_id: string | null;
  loan_id: string | null;
};

/** Every naira in and out over a period. Each line is a movement, never a calculation. */
export async function cashBook(ctx: Ctx, range: { from: string; to: string }) {
  requirePermission(ctx, "finance.view");
  if (range.from > range.to) throw new DomainError("The start date is after the end date.");
  const book = sql`
    SELECT m.id, 'cash' AS account, m.custodian_id, m.amount_kobo, m.business_date, m.source_type, m.source_id, m.at
    FROM cash_movements m WHERE m.business_date BETWEEN ${range.from}::date AND ${range.to}::date
    UNION ALL
    SELECT b.id, 'bank', NULL, b.amount_kobo, b.business_date, b.source_type, b.source_id, b.at
    FROM bank_movements b WHERE b.business_date BETWEEN ${range.from}::date AND ${range.to}::date
  `;
  const [rows, totals] = await Promise.all([
    db.execute(sql`
      WITH book AS (${book})
      SELECT b.id, b.account, b.amount_kobo::float8 AS amount, b.business_date::text AS date, b.at, b.source_type,
             u.name AS custodian, p.receipt_number AS receipt,
             COALESCE(po.name, lo.name) AS operator,
             COALESCE(a.purpose, la.purpose) AS purpose,
             p.id AS payment_id, COALESCE(a.id, la.id) AS advance_id, l.id AS loan_id
      FROM book b
      LEFT JOIN users u ON u.id = b.custodian_id
      LEFT JOIN payments p ON b.source_type IN ('payment', 'payment_reversal') AND p.id::text = b.source_id
      LEFT JOIN operators po ON po.id = p.operator_id
      LEFT JOIN expense_advances a ON b.source_type IN ('expense_advance', 'expense_advance_cancel') AND a.id::text = b.source_id
      LEFT JOIN expense_lines el ON b.source_type IN ('expense_change', 'expense_change_void') AND el.id::text = b.source_id
      LEFT JOIN expense_advances la ON la.id = el.advance_id
      LEFT JOIN loans l ON b.source_type IN ('loan', 'loan_cancel') AND l.id::text = b.source_id
      LEFT JOIN operators lo ON lo.id = l.operator_id
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
    account: "cash" | "bank";
    source_type: string;
    money_in: number;
    money_out: number;
  }[];
  const side = (account: "cash" | "bank") => {
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
    bySource: groups,
  };
}
