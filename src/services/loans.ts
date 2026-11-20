import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import { charges, loans, operators, users } from "@/db/schema";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { businessDate, daysBetween } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { idField, optionalText, positiveNairaField, requiredText } from "@/lib/fields";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { lockCashHolder, moneySourceField, recordMovement, takeMoneyOut } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { voidCharge } from "./ledger";
import { notifyOperators } from "./notices";
import { notifyMany } from "./notifications";

/** The owner is told of a loan above this, as with large refunds. */
export const LARGE_LOAN_KOBO = 5_000_000;

// Written out in full: Drizzle drops the table name on single-table selects, and
// a bare column here would bind to the inner query instead.
const repaid = sql<number>`COALESCE((
  SELECT SUM(e.amount_kobo) FROM effective_allocations e WHERE e.charge_id = loans.charge_id), 0)::float8`;

const ALREADY = { one_active_loan: fieldError("operatorId", "This operator already has a loan to clear") };

const grantSchema = z.object({
  operatorId: idField("operator"),
  amount: positiveNairaField("Amount"),
  source: moneySourceField,
  note: optionalText(300),
});

/** No interest and no fee: what is owed is exactly what was given. */
export async function grantLoan(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "loan.approve");
  const input = parseInput(grantSchema, raw);
  try {
    return await db.transaction((tx) => payOutLoan(tx, ctx, input));
  } catch (error) {
    rethrowConstraint(error, ALREADY);
  }
}

type PayOut = {
  operatorId: string;
  amount: number;
  source: { custodianId: string | null; account: "bank" | "owner" };
  note?: string | null;
};

/**
 * Pays a loan out: the operator owes it and the money leaves the chosen cash
 * or bank. Used when the Manager gives a loan and when they approve a request.
 */
export async function payOutLoan(tx: Tx, ctx: Ctx, input: PayOut, requestId: string | null = null) {
  const now = ctx.clock();
  const today = businessDate(now);
  const [operator] = await tx.select().from(operators).where(eq(operators.id, input.operatorId)).for("update");
  if (!operator) throw new DomainError("Operator not found.");
  if (operator.status !== "active") throw fieldError("operatorId", "Only an active operator can be given a loan");
  const [owing] = await tx
    .select({ id: loans.id })
    .from(loans)
    .where(and(eq(loans.operatorId, operator.id), eq(loans.status, "active")));
  if (owing) throw ALREADY.one_active_loan;

  const [charge] = await tx
    .insert(charges)
    .values({ type: "loan", operatorId: operator.id, amountKobo: input.amount, businessDate: today })
    .returning({ id: charges.id });
  const [loan] = await tx
    .insert(loans)
    .values({
      operatorId: operator.id,
      chargeId: charge!.id,
      principalKobo: input.amount,
      custodianId: input.source.custodianId,
      account: input.source.account,
      note: input.note ?? null,
      disbursedOn: today,
      approvedBy: ctx.actor.userId,
      requestId,
      createdAt: now,
    })
    .returning({ id: loans.id });
  await takeMoneyOut(tx, {
    ...input.source,
    amountKobo: input.amount,
    sourceType: "loan",
    sourceId: loan!.id,
    at: now,
  });
  await notifyOperators(tx, now, [
    {
      operatorId: operator.id,
      kind: "receipt",
      body: `Loan of ${formatNaira(input.amount)} given on ${formatDate(today)}. No interest or fee: you pay back ${formatNaira(input.amount)}.`,
    },
  ]);
  if (input.amount > LARGE_LOAN_KOBO) {
    await notifyMany(tx, [
      {
        kind: "large_loan",
        body: `${formatNaira(input.amount)} lent to ${operator.name}`,
        at: now,
        link: `/loans/${loan!.id}`,
        entity: { type: "loan", id: loan!.id },
        dedupeKey: `large_loan:${loan!.id}`,
        createdBy: ctx.actor.userId,
      },
    ]);
  }
  await auditFrom(ctx, tx, {
    action: "loan.grant",
    entityType: "operator",
    entityId: operator.id,
    after: { amountKobo: input.amount, requestId },
  });
  return loan!;
}

const cancelSchema = z.object({
  reason: requiredText("Reason", 500),
  /** Where the money goes back. Empty means where it came from. */
  source: z.preprocess((value) => (value === "" ? undefined : value), moneySourceField.optional()),
});

/**
 * For a loan entered by mistake. Once anything is repaid, it stands. The money
 * goes back where it came from, unless that person no longer holds cash: then
 * the Manager says where it is now.
 */
export async function cancelLoan(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "loan.approve");
  const id = parseInput(idField("loan"), rawId);
  const { reason, source } = parseInput(cancelSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const [found] = await tx.select({ operatorId: loans.operatorId }).from(loans).where(eq(loans.id, id));
    if (!found) throw new DomainError("Loan not found.");
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, found.operatorId)).for("update");
    const [loan] = await tx.select({ row: loans, repaid }).from(loans).where(eq(loans.id, id)).for("update");
    if (loan!.row.status !== "active") throw new DomainError("Only an active loan can be cancelled.");
    if (loan!.repaid > 0) throw new DomainError("Part of this loan has been repaid, so it cannot be cancelled.");

    const back = source ?? { custodianId: loan!.row.custodianId, account: loan!.row.account };
    if (back.custodianId) {
      if (!source) {
        const [holder] = await tx
          .select({ name: users.name, status: users.status })
          .from(users)
          .where(eq(users.id, back.custodianId));
        if (holder?.status !== "active") {
          throw fieldError("source", `${holder?.name ?? "The person who gave it"} no longer holds cash. Choose where the money is now`);
        }
      }
      await lockCashHolder(tx, back.custodianId, "source");
    }

    await tx.update(loans).set({ status: "cancelled", cancelReason: reason }).where(eq(loans.id, id));
    await voidCharge(tx, loan!.row.chargeId, { userId: ctx.actor.userId, at: now }, reason);
    await recordMovement(tx, {
      custodianId: back.custodianId,
      account: back.account,
      amountKobo: loan!.row.principalKobo,
      sourceType: "loan_cancel",
      sourceId: id,
      at: now,
    });
    await notifyOperators(tx, now, [
      {
        operatorId: found.operatorId,
        kind: "receipt",
        body: `The loan of ${formatNaira(loan!.row.principalKobo)} from ${formatDate(loan!.row.disbursedOn)} was a mistake and has been cancelled. You owe nothing on it.`,
      },
    ]);
    await auditFrom(ctx, tx, {
      action: "loan.cancel",
      entityType: "operator",
      entityId: found.operatorId,
      after: source ? { returnedTo: source.custodianId ?? source.account } : undefined,
      reason,
    });
  });
}

const fields = {
  id: loans.id,
  operatorId: loans.operatorId,
  operatorName: operators.name,
  principalKobo: loans.principalKobo,
  status: loans.status,
  disbursedOn: loans.disbursedOn,
  note: loans.note,
  repaidKobo: repaid,
};

// The last day money that still counts went to this loan.
const lastRepaidOn = sql<string | null>`(
  SELECT MAX(p.business_date)::text FROM payment_allocations a
  JOIN payments p ON p.id = a.payment_id
  WHERE a.charge_id = loans.charge_id
    AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id))`;

// The tricycle the operator holds now, if any.
const heldTricycle = (column: "code_number" | "registration_number") => sql<string | null>`(
  SELECT t.${sql.raw(column)} FROM assignments a JOIN tricycles t ON t.id = a.tricycle_id
  WHERE a.operator_id = loans.operator_id AND a.returned_on IS NULL
  ORDER BY a.issued_on DESC LIMIT 1)`;

export async function listLoans(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  const select = () =>
    db
      .select({
        ...fields,
        lastRepaidOn,
        cancelReason: loans.cancelReason,
        operatorPhone: operators.phone,
        tricycleCode: heldTricycle("code_number"),
        registration: heldTricycle("registration_number"),
      })
      .from(loans)
      .innerJoin(operators, eq(operators.id, loans.operatorId));
  // Every loan still owed is listed, however old; only finished ones are cut.
  const [owed, finished] = await Promise.all([
    select().where(eq(loans.status, "active")),
    select()
      .where(ne(loans.status, "active"))
      .orderBy(desc(loans.disbursedOn), desc(loans.createdAt))
      .limit(300),
  ]);
  // Loans to collect: the one quiet for longest comes first, so slow payers stand out.
  const active = owed
    .map((row) => ({
      ...row,
      owedKobo: row.principalKobo - row.repaidKobo,
      quietDays: daysBetween(row.lastRepaidOn ?? row.disbursedOn, today),
    }))
    .sort((a, b) => b.quietDays - a.quietDays || b.owedKobo - a.owedKobo);
  return {
    active,
    cleared: finished.filter((row) => row.status === "cleared"),
    cancelled: finished.filter((row) => row.status === "cancelled"),
    outstandingKobo: active.reduce((sum, row) => sum + row.owedKobo, 0),
    canApprove: can(ctx.actor.role, "loan.approve"),
    canRequest: can(ctx.actor.role, "loan.request"),
    canCollect: can(ctx.actor.role, "payment.record"),
  };
}

/** What is still owed on loans, for the money summary. */
export async function loansToCollect(exec: Executor = db) {
  const [row] = (await exec.execute(sql`
    SELECT COUNT(*)::int AS loans,
           COALESCE(SUM(l.principal_kobo - COALESCE((
             SELECT SUM(e.amount_kobo) FROM effective_allocations e WHERE e.charge_id = l.charge_id), 0)), 0)::float8 AS owed
    FROM loans l WHERE l.status = 'active'
  `)) as unknown as { loans: number; owed: number }[];
  return { loansActive: row?.loans ?? 0, loansOwedKobo: row?.owed ?? 0 };
}

// The tricycle an operator holds now, if any, for a query on operators.
const operatorTricycle = (column: "code_number" | "registration_number") => sql<string | null>`(
  SELECT t.${sql.raw(column)} FROM assignments a JOIN tricycles t ON t.id = a.tricycle_id
  WHERE a.operator_id = ${operators.id} AND a.returned_on IS NULL
  ORDER BY a.issued_on DESC LIMIT 1)`;

/**
 * Active operators free to take a loan, with the tricycle and plate they hold
 * so the right person is picked, and how many are left out for owing a loan.
 */
export async function operatorsForLoan(ctx: Ctx) {
  if (!can(ctx.actor.role, "loan.request")) requirePermission(ctx, "loan.approve");
  const rows = await db
    .select({
      id: operators.id,
      name: operators.name,
      phone: operators.phone,
      tricycleCode: operatorTricycle("code_number"),
      registration: operatorTricycle("registration_number"),
      owing: sql<boolean>`${loans.id} IS NOT NULL OR EXISTS (
        SELECT 1 FROM loan_requests r WHERE r.operator_id = ${operators.id} AND r.status = 'waiting')`,
    })
    .from(operators)
    .leftJoin(loans, and(eq(loans.operatorId, operators.id), eq(loans.status, "active")))
    .where(eq(operators.status, "active"))
    .orderBy(asc(operators.name));
  return {
    choices: rows.filter((row) => !row.owing).map(({ owing: _, ...row }) => row),
    owingCount: rows.filter((row) => row.owing).length,
  };
}

/** Operators who still owe on a loan, for taking repayments: the oldest loan first. */
export async function operatorsOwingLoans(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const rows = await db
    .select({
      operatorId: loans.operatorId,
      name: operators.name,
      phone: operators.phone,
      tricycleCode: operatorTricycle("code_number"),
      registration: operatorTricycle("registration_number"),
      principalKobo: loans.principalKobo,
      repaidKobo: repaid,
    })
    .from(loans)
    .innerJoin(operators, eq(operators.id, loans.operatorId))
    .where(eq(loans.status, "active"))
    .orderBy(asc(loans.disbursedOn), asc(operators.name));
  return rows.map(({ principalKobo, repaidKobo, ...row }) => ({ ...row, owedKobo: principalKobo - repaidKobo }));
}

/** The operator's loan still being paid back, if any, for their page and the payment form. */
export async function activeLoanFor(ctx: Ctx, operatorId: string) {
  requirePermission(ctx, "finance.view");
  const [row] = await db
    .select({ id: loans.id, principalKobo: loans.principalKobo, disbursedOn: loans.disbursedOn, repaidKobo: repaid })
    .from(loans)
    .where(and(eq(loans.operatorId, operatorId), eq(loans.status, "active")))
    .limit(1);
  return row ? { ...row, owedKobo: row.principalKobo - row.repaidKobo } : null;
}

export async function getLoan(ctx: Ctx, id: string) {
  requirePermission(ctx, "finance.view");
  const [loan] = await db
    .select({
      ...fields,
      approvedByName: users.name,
      requestId: loans.requestId,
      requestedByName: sql<string | null>`(
        SELECT u.name FROM loan_requests r JOIN users u ON u.id = r.requested_by WHERE r.id = loans.request_id)`,
      cancelReason: loans.cancelReason,
      chargeId: loans.chargeId,
      custodianId: loans.custodianId,
      account: loans.account,
      givenFrom: sql<string | null>`(SELECT u.name FROM users u WHERE u.id = loans.custodian_id)`,
      givenFromActive: sql<boolean | null>`(SELECT u.status = 'active' FROM users u WHERE u.id = loans.custodian_id)`,
      tricycleCode: heldTricycle("code_number"),
      registration: heldTricycle("registration_number"),
    })
    .from(loans)
    .innerJoin(operators, eq(operators.id, loans.operatorId))
    .innerJoin(users, eq(users.id, loans.approvedBy))
    .where(eq(loans.id, id))
    .limit(1);
  if (!loan) return null;
  const repayments = (await db.execute(sql`
    SELECT p.id, p.receipt_number, p.method::text AS method, p.business_date::text AS date, a.amount_kobo::float8 AS amount,
           EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id) AS reversed
    FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
    WHERE a.charge_id = ${loan.chargeId}
    ORDER BY p.received_at DESC
  `)) as unknown as { id: string; receipt_number: string; method: string; date: string; amount: number; reversed: boolean }[];
  return {
    loan,
    repayments,
    owedKobo: loan.status === "cancelled" ? 0 : loan.principalKobo - loan.repaidKobo,
    canApprove: can(ctx.actor.role, "loan.approve"),
    canCollect: can(ctx.actor.role, "payment.record"),
  };
}
