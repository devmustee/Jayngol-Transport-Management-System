import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import { bankMovements, cashCloses, cashMovements, moneyTransfers, users } from "@/db/schema";
import { closeDueBy, closeRhythm, weekOf } from "@/lib/cash-rhythm";
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
      SELECT c.business_date, COALESCE(x.counted_kobo, k.recounted_kobo, c.counted_kobo) AS held
      FROM cash_closes c LEFT JOIN cash_close_checks k ON k.close_id = c.id
        LEFT JOIN cash_close_corrections x ON x.close_id = c.id
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

/** Cash promised in handovers the receiver has not accepted yet. */
export async function waitingHandovers(exec: Executor, custodianId: string) {
  const [row] = await exec
    .select({ kobo: sql<number>`COALESCE(SUM(${moneyTransfers.amountKobo}), 0)::float8` })
    .from(moneyTransfers)
    .where(and(eq(moneyTransfers.fromCustodian, custodianId), eq(moneyTransfers.status, "pending")));
  return row?.kobo ?? 0;
}

/**
 * Cash held, less what is already promised in waiting handovers, so the same
 * cash cannot be handed over twice or spent while a handover waits.
 */
export async function freeCash(exec: Executor, custodianId: string, date: string) {
  const [heldKobo, waitingKobo] = await Promise.all([expectedCash(exec, custodianId, date), waitingHandovers(exec, custodianId)]);
  return { heldKobo, waitingKobo, freeKobo: heldKobo - waitingKobo };
}

export async function assertCashHeld(tx: Tx, custodianId: string, amountKobo: number, at: Date, field: string) {
  const date = await cashDate(tx, custodianId, businessDate(at));
  const { heldKobo, waitingKobo, freeKobo } = await freeCash(tx, custodianId, date);
  if (amountKobo > freeKobo) {
    throw fieldError(
      field,
      waitingKobo > 0
        ? `Only ${formatNaira(Math.max(freeKobo, 0))} is free. This person holds ${formatNaira(heldKobo)}, and ${formatNaira(waitingKobo)} is waiting in handovers`
        : `Only ${formatNaira(heldKobo)} in cash is held by this person`,
    );
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

/**
 * The days a count on `date` covers: everything since the person's last count
 * before that date, with the money in and out on each day that had any.
 */
export async function cashSinceLastClose(exec: Executor, custodianId: string, date: string) {
  const [lastRows, dayRows] = await Promise.all([
    exec.execute(sql`
      SELECT c.business_date::text AS date, COALESCE(x.counted_kobo, k.recounted_kobo, c.counted_kobo)::float8 AS held
      FROM cash_closes c LEFT JOIN cash_close_checks k ON k.close_id = c.id
        LEFT JOIN cash_close_corrections x ON x.close_id = c.id
      WHERE c.custodian_id = ${custodianId} AND c.business_date < ${date}::date
      ORDER BY c.business_date DESC LIMIT 1
    `),
    exec.execute(sql`
      SELECT m.business_date::text AS date,
             COALESCE(SUM(m.amount_kobo) FILTER (WHERE m.amount_kobo > 0), 0)::float8 AS money_in,
             COALESCE(-SUM(m.amount_kobo) FILTER (WHERE m.amount_kobo < 0), 0)::float8 AS money_out
      FROM cash_movements m
      WHERE m.custodian_id = ${custodianId} AND m.business_date <= ${date}::date
        AND m.business_date > COALESCE((
          SELECT MAX(c.business_date) FROM cash_closes c
          WHERE c.custodian_id = ${custodianId} AND c.business_date < ${date}::date), '-infinity'::date)
      GROUP BY m.business_date ORDER BY m.business_date
    `),
  ]);
  const last = (lastRows as unknown as { date: string; held: number }[])[0] ?? null;
  const days = (dayRows as unknown as { date: string; money_in: number; money_out: number }[]).map((row) => ({
    date: row.date,
    inKobo: row.money_in,
    outKobo: row.money_out,
  }));
  return {
    lastClose: last ? { date: last.date, heldKobo: last.held } : null,
    /** The first day this count covers. */
    from: last ? addDays(last.date, 1) : (days[0]?.date ?? date),
    days,
  };
}

/** What needs someone's attention before the cash trail can be trusted. */
export async function cashAlerts(exec: Executor, today: string) {
  const [unclosed, counts] = await Promise.all([
    exec.execute(sql`
      SELECT u.id, u.name, u.role::text AS role, MIN(m.business_date)::text AS since, u.status::text AS status
      FROM cash_movements m JOIN users u ON u.id = m.custodian_id
      WHERE m.business_date < ${today}::date
        AND m.business_date > COALESCE(
          (SELECT MAX(c.business_date) FROM cash_closes c WHERE c.custodian_id = m.custodian_id), '-infinity'::date)
      GROUP BY u.id, u.name, u.role, u.status ORDER BY u.name
    `),
    exec.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM money_transfers WHERE status = 'pending') AS handovers,
        (SELECT COUNT(*)::int FROM payment_references
          WHERE released_at IS NULL AND confirmed_at IS NULL) AS bank
    `),
  ]);
  const row = (counts as unknown as { handovers: number; bank: number }[])[0];
  // The Assistant Manager is late the morning after a day not closed. The Manager
  // closes weekly and is late from Tuesday if last week is not closed.
  // Someone who has left drops off once their cash has been taken over.
  const rows = unclosed as unknown as { id: string; name: string; role: string; since: string; status: string }[];
  const holding = await Promise.all(
    rows.map(async (person) =>
      person.status === "active" || (await expectedCash(exec, person.id, await cashDate(exec, person.id, today))) !== 0,
    ),
  );
  const cashNotClosed = rows
    .filter((_, index) => holding[index])
    .map((person) => ({ ...person, rhythm: closeRhythm(person.role) }))
    .filter((person) => person.since <= closeDueBy(person.rhythm, today))
    .map(({ id, name, since, rhythm }) => ({ id, name, since, rhythm, week: rhythm === "week" ? weekOf(since) : null }));
  return {
    cashNotClosed,
    handoversWaiting: row?.handovers ?? 0,
    bankToCheck: row?.bank ?? 0,
  };
}

/** Who money can come from, with the cash each person holds today and how much of it is free. */
export async function moneySources(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const people = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.role, ["manager", "assistant_manager"]), eq(users.status, "active")))
    .orderBy(users.name);
  return Promise.all(
    people.map(async (person) => {
      const { heldKobo, waitingKobo, freeKobo } = await freeCash(db, person.id, await cashDate(db, person.id, today));
      /** availableKobo is what can be spent: cash held less waiting handovers. */
      return { ...person, availableKobo: freeKobo, heldKobo, waitingKobo };
    }),
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

/** The kinds of movement the cash book can be narrowed to. */
export const BOOK_KINDS = {
  payments: ["payment", "payment_reversal"],
  savings: ["deposit", "deposit_reversal", "deposit_refund", "deposit_refund_undo"],
  expenses: ["expense_advance", "expense_advance_cancel", "expense_change", "expense_change_void"],
  loans: ["loan", "loan_cancel"],
  moves: ["transfer_in", "transfer_out", "transfer_void_in", "transfer_void_out"],
} as const;
export type BookKind = keyof typeof BOOK_KINDS;
const MOVES: readonly string[] = BOOK_KINDS.moves;

export type BookRow = {
  id: string;
  account: "cash" | "bank" | "owner";
  amount: number;
  /** The day it counts on, which for cash taken after a count is the next day. */
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
  /** For savings given back: whose savings, to link to them. */
  refund_operator_id: string | null;
};

type Side = {
  /** Held at the start of the first day. */
  openingKobo: number;
  /** Money that came into the business, moves left out. */
  moneyIn: number;
  /** Money that left the business, moves left out. */
  moneyOut: number;
  /** Moved here from another person, the bank or the owner. */
  movedIn: number;
  /** Moved from here to another person, the bank or the owner. */
  movedOut: number;
  /** Everything together: closing less opening. */
  net: number;
  /** Held at the end of the last day. */
  closingKobo: number;
};

/**
 * Every naira in and out over a period, with what was held at the start and
 * the end. Money moved between people, the bank and the owner is shown apart,
 * so money in and out mean takings and spending. Each line is a movement,
 * never a calculation. `whose` narrows to one person's cash, the bank or the
 * owner; `kind` to one kind of movement (the balances stay whole).
 */
export async function cashBook(
  ctx: Ctx,
  range: { from: string; to: string; whose?: string | null; kind?: BookKind | null },
) {
  requirePermission(ctx, "finance.view");
  if (range.from > range.to) throw new DomainError("The start date is after the end date.");
  const whose = range.whose ?? null;
  const person = whose && isUuid(whose) ? whose : null;
  const place = whose === "bank" || whose === "owner" ? whose : null;
  const kinds = range.kind ? (BOOK_KINDS[range.kind] as readonly string[]) : null;

  // Every movement of the place chosen, any day. Dates and kinds are applied after.
  const cash = person
    ? sql`SELECT m.id, 'cash' AS account, m.custodian_id, m.amount_kobo, m.business_date, m.source_type, m.source_id, m.at
          FROM cash_movements m WHERE m.custodian_id = ${person}`
    : sql`SELECT m.id, 'cash' AS account, m.custodian_id, m.amount_kobo, m.business_date, m.source_type, m.source_id, m.at
          FROM cash_movements m`;
  const bank = place
    ? sql`SELECT b.id, b.account::text, NULL::uuid AS custodian_id, b.amount_kobo, b.business_date, b.source_type, b.source_id, b.at
          FROM bank_movements b WHERE b.account = ${place}`
    : sql`SELECT b.id, b.account::text, NULL::uuid AS custodian_id, b.amount_kobo, b.business_date, b.source_type, b.source_id, b.at
          FROM bank_movements b`;
  const all = person ? cash : place ? bank : sql`${cash} UNION ALL ${bank}`;
  const kindFilter = kinds ? sql`AND source_type IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const inRange = sql`SELECT * FROM (${all}) x
    WHERE business_date BETWEEN ${range.from}::date AND ${range.to}::date ${kindFilter}`;
  // Ids are matched as ids, so the database can use its indexes.
  const as = (types: string) => sql.raw(`CASE WHEN b.source_type IN (${types}) THEN b.source_id::uuid END`);

  const [rows, totals, balances] = await Promise.all([
    db.execute(sql`
      WITH book AS (${inRange})
      SELECT b.id, b.account, b.amount_kobo::float8 AS amount, b.business_date::text AS date, b.at, b.source_type,
             u.name AS custodian, COALESCE(p.receipt_number, d.receipt_number) AS receipt,
             COALESCE(po.name, dpo.name, lo.name) AS operator,
             COALESCE(a.purpose, la.purpose, mt.note, mt.reference) AS purpose,
             p.id AS payment_id, d.id AS deposit_id, COALESCE(a.id, la.id) AS advance_id, l.id AS loan_id, mt.id AS transfer_id,
             ds.operator_id AS refund_operator_id
      FROM book b
      LEFT JOIN users u ON u.id = b.custodian_id
      LEFT JOIN payments p ON p.id = ${as("'payment', 'payment_reversal'")}
      LEFT JOIN operators po ON po.id = p.operator_id
      LEFT JOIN operator_deposits d ON d.id = ${as("'deposit', 'deposit_reversal'")}
      LEFT JOIN deposit_settlements ds ON ds.id = ${as("'deposit_refund', 'deposit_refund_undo'")}
      LEFT JOIN operators dpo ON dpo.id = COALESCE(d.operator_id, ds.operator_id)
      LEFT JOIN expense_advances a ON a.id = ${as("'expense_advance', 'expense_advance_cancel'")}
      LEFT JOIN expense_lines el ON el.id = ${as("'expense_change', 'expense_change_void'")}
      LEFT JOIN expense_advances la ON la.id = el.advance_id
      LEFT JOIN loans l ON l.id = ${as("'loan', 'loan_cancel'")}
      LEFT JOIN operators lo ON lo.id = l.operator_id
      LEFT JOIN money_transfers mt ON mt.id = ${as("'transfer_in', 'transfer_out', 'transfer_void_in', 'transfer_void_out'")}
      ORDER BY b.at DESC, b.id
      LIMIT ${BOOK_LIMIT + 1}
    `),
    db.execute(sql`
      WITH book AS (${inRange})
      SELECT account, source_type,
             COALESCE(SUM(amount_kobo) FILTER (WHERE amount_kobo > 0), 0)::float8 AS money_in,
             COALESCE(-SUM(amount_kobo) FILTER (WHERE amount_kobo < 0), 0)::float8 AS money_out
      FROM book GROUP BY account, source_type
    `),
    db.execute(sql`
      SELECT account,
             COALESCE(SUM(amount_kobo) FILTER (WHERE business_date < ${range.from}::date), 0)::float8 AS opening,
             COALESCE(SUM(amount_kobo) FILTER (WHERE business_date <= ${range.to}::date), 0)::float8 AS closing
      FROM (${all}) x GROUP BY account
    `),
  ]);
  const found = rows as unknown as BookRow[];
  const groups = totals as unknown as {
    account: "cash" | "bank" | "owner";
    source_type: string;
    money_in: number;
    money_out: number;
  }[];
  const held = balances as unknown as { account: "cash" | "bank" | "owner"; opening: number; closing: number }[];
  const side = (account: "cash" | "bank" | "owner"): Side => {
    const lines = groups.filter((group) => group.account === account);
    const sum = (pick: (g: (typeof lines)[number]) => number, moves: boolean) =>
      lines.filter((g) => MOVES.includes(g.source_type) === moves).reduce((total, g) => total + pick(g), 0);
    const moneyIn = sum((g) => g.money_in, false);
    const moneyOut = sum((g) => g.money_out, false);
    const movedIn = sum((g) => g.money_in, true);
    const movedOut = sum((g) => g.money_out, true);
    const balance = held.find((row) => row.account === account);
    return {
      openingKobo: balance?.opening ?? 0,
      moneyIn,
      moneyOut,
      movedIn,
      movedOut,
      net: moneyIn - moneyOut + movedIn - movedOut,
      closingKobo: balance?.closing ?? 0,
    };
  };
  return {
    rows: found.slice(0, BOOK_LIMIT),
    truncated: found.length > BOOK_LIMIT,
    cash: side("cash"),
    bank: side("bank"),
    owner: side("owner"),
    bySource: groups,
    /** True when a kind is chosen: the totals cover only that kind, the balances everything. */
    narrowed: kinds !== null,
  };
}
