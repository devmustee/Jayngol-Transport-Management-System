import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { loanRequests, loans, operators } from "@/db/schema";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { idField, positiveNairaField, requiredText } from "@/lib/fields";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { moneySourceField } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { payOutLoan } from "./loans";
import { notifyMany } from "./notifications";

const ONE_WAITING = {
  one_waiting_loan_request: fieldError("operatorId", "A request for this operator is already waiting for the Manager"),
  one_active_loan: fieldError("operatorId", "This operator already has a loan to clear"),
};

const requestSchema = z.object({
  operatorId: idField("operator"),
  amount: positiveNairaField("Amount"),
  reason: requiredText("Reason", 300),
});

/**
 * The Assistant Manager asks the Manager to give a loan. No money moves and
 * the operator owes nothing until the Manager approves.
 */
export async function requestLoan(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "loan.request");
  const input = parseInput(requestSchema, raw);
  const now = ctx.clock();
  try {
    return await db.transaction(async (tx) => {
      const [operator] = await tx.select().from(operators).where(eq(operators.id, input.operatorId)).for("update");
      if (!operator) throw new DomainError("Operator not found.");
      if (operator.status !== "active") throw fieldError("operatorId", "Only an active operator can be given a loan");
      const [owing] = await tx
        .select({ id: loans.id })
        .from(loans)
        .where(and(eq(loans.operatorId, operator.id), eq(loans.status, "active")));
      if (owing) throw ONE_WAITING.one_active_loan;

      const [request] = await tx
        .insert(loanRequests)
        .values({
          operatorId: operator.id,
          amountKobo: input.amount,
          reason: input.reason,
          requestedBy: ctx.actor.userId,
          requestedAt: now,
        })
        .returning({ id: loanRequests.id });
      await notifyMany(tx, [
        {
          kind: "loan_request",
          body: `${formatNaira(input.amount)} for ${operator.name}, from ${ctx.actor.name}: ${input.reason}`,
          at: now,
          link: `/loans#request-${request!.id}`,
          entity: { type: "loan_request", id: request!.id },
          dedupeKey: `loan_request:${request!.id}`,
          exceptUserId: ctx.actor.userId,
          createdBy: ctx.actor.userId,
        },
      ]);
      await auditFrom(ctx, tx, {
        action: "loan.request",
        entityType: "operator",
        entityId: operator.id,
        after: { amountKobo: input.amount },
        reason: input.reason,
      });
      return request!;
    });
  } catch (error) {
    rethrowConstraint(error, ONE_WAITING);
  }
}

/** Locks a waiting request, or says why it can no longer be decided. */
async function lockWaiting(tx: Tx, id: string) {
  const [found] = await tx.select().from(loanRequests).where(eq(loanRequests.id, id));
  if (!found) throw new DomainError("Loan request not found.");
  // Operator first, then the request: the same order as giving a loan.
  await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, found.operatorId)).for("update");
  const [request] = await tx.select().from(loanRequests).where(eq(loanRequests.id, id)).for("update");
  if (request!.status !== "waiting") {
    throw new DomainError(`This request has already been ${request!.status}.`);
  }
  return request!;
}

const approveSchema = z.object({
  /** Empty means the amount asked for. The Manager may only lower it. */
  amount: z.preprocess((value) => (value === "" ? undefined : value), positiveNairaField("Amount").optional()),
  source: moneySourceField,
});

/** Gives the loan exactly as Give loan does, from the source the Manager chooses. */
export async function approveLoanRequest(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "loan.approve");
  const id = parseInput(idField("request"), rawId);
  const input = parseInput(approveSchema, raw);
  const now = ctx.clock();
  try {
    return await db.transaction(async (tx) => {
      const request = await lockWaiting(tx, id);
      // Things may have changed while the request waited: say so plainly.
      const [operator] = await tx
        .select({ name: operators.name, status: operators.status })
        .from(operators)
        .where(eq(operators.id, request.operatorId));
      if (operator!.status !== "active") {
        throw new DomainError(`${operator!.name} is no longer working, so the loan cannot be given. Reject the request.`);
      }
      const [owing] = await tx
        .select({ id: loans.id })
        .from(loans)
        .where(and(eq(loans.operatorId, request.operatorId), eq(loans.status, "active")));
      if (owing) throw new DomainError(`${operator!.name} already has a loan to clear. Reject the request.`);
      const amount = input.amount ?? request.amountKobo;
      if (amount > request.amountKobo) {
        throw fieldError("amount", `At most the ${formatNaira(request.amountKobo)} asked for`);
      }
      const loan = await payOutLoan(
        tx,
        ctx,
        { operatorId: request.operatorId, amount, source: input.source, note: request.reason },
        request.id,
      );
      await tx
        .update(loanRequests)
        .set({ status: "approved", decidedBy: ctx.actor.userId, decidedAt: now })
        .where(eq(loanRequests.id, id));
      const lowered = amount < request.amountKobo ? ` (you asked for ${formatNaira(request.amountKobo)})` : "";
      await notifyMany(tx, [
        {
          kind: "loan_request_answered",
          body: `Approved: ${formatNaira(amount)} for ${operator!.name}${lowered}.`,
          at: now,
          link: `/loans/${loan.id}`,
          userIds: [request.requestedBy],
          entity: { type: "loan_request", id },
          dedupeKey: `loan_request_answered:${id}`,
          createdBy: ctx.actor.userId,
        },
      ]);
      return loan;
    });
  } catch (error) {
    rethrowConstraint(error, ONE_WAITING);
  }
}

export async function rejectLoanRequest(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "loan.approve");
  const id = parseInput(idField("request"), rawId);
  const { rejectReason } = parseInput(z.object({ rejectReason: requiredText("Reason", 300) }), raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const request = await lockWaiting(tx, id);
    await tx
      .update(loanRequests)
      .set({ status: "rejected", decidedBy: ctx.actor.userId, decidedAt: now, rejectReason })
      .where(eq(loanRequests.id, id));
    const [operator] = await tx.select({ name: operators.name }).from(operators).where(eq(operators.id, request.operatorId));
    await notifyMany(tx, [
      {
        kind: "loan_request_answered",
        body: `Rejected: ${formatNaira(request.amountKobo)} for ${operator!.name}. ${rejectReason}`,
        at: now,
        link: `/loans#request-${id}`,
        userIds: [request.requestedBy],
        entity: { type: "loan_request", id },
        dedupeKey: `loan_request_answered:${id}`,
        createdBy: ctx.actor.userId,
      },
    ]);
    await auditFrom(ctx, tx, {
      action: "loan.request_reject",
      entityType: "operator",
      entityId: request.operatorId,
      before: { amountKobo: request.amountKobo },
      reason: rejectReason,
    });
  });
}

/** The person who asked can take back a request the Manager has not decided. */
export async function withdrawLoanRequest(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "loan.request");
  const id = parseInput(idField("request"), rawId);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const request = await lockWaiting(tx, id);
    if (request.requestedBy !== ctx.actor.userId) throw new DomainError("Only the person who asked can withdraw it.");
    await tx
      .update(loanRequests)
      .set({ status: "withdrawn", decidedBy: ctx.actor.userId, decidedAt: now })
      .where(eq(loanRequests.id, id));
    await auditFrom(ctx, tx, {
      action: "loan.request_withdraw",
      entityType: "operator",
      entityId: request.operatorId,
      before: { amountKobo: request.amountKobo },
    });
  });
}

// The tricycle an operator holds now, if any.
const tricycle = (column: "code_number" | "registration_number") => sql<string | null>`(
  SELECT t.${sql.raw(column)} FROM assignments a JOIN tricycles t ON t.id = a.tricycle_id
  WHERE a.operator_id = ${loanRequests.operatorId} AND a.returned_on IS NULL
  ORDER BY a.issued_on DESC LIMIT 1)`;

// Unpaid balances and fines today, so the Manager sees the risk before approving.
const owedNow = sql<number>`(
  SELECT COALESCE(SUM(GREATEST(c.amount_kobo
    - COALESCE((SELECT SUM(e.amount_kobo) FROM effective_allocations e WHERE e.charge_id = c.id), 0)
    - COALESCE((SELECT SUM(w.amount_kobo) FROM effective_waivers w WHERE w.charge_id = c.id), 0), 0)), 0)::float8
  FROM valid_charges c
  WHERE c.operator_id = ${loanRequests.operatorId} AND c.type IN ('daily_balance', 'penalty'))`;

const requester = sql<string>`(SELECT u.name FROM users u WHERE u.id = ${loanRequests.requestedBy})`;
const decider = sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${loanRequests.decidedBy})`;
const loanOf = sql<string | null>`(SELECT l.id FROM loans l WHERE l.request_id = ${loanRequests.id})`;
const givenKobo = sql<number | null>`(SELECT l.principal_kobo::float8 FROM loans l WHERE l.request_id = ${loanRequests.id})`;

const requestFields = {
  id: loanRequests.id,
  operatorId: loanRequests.operatorId,
  operatorName: operators.name,
  tricycleCode: tricycle("code_number"),
  registration: tricycle("registration_number"),
  amountKobo: loanRequests.amountKobo,
  reason: loanRequests.reason,
  status: loanRequests.status,
  requestedBy: loanRequests.requestedBy,
  requestedByName: requester,
  requestedAt: loanRequests.requestedAt,
  decidedByName: decider,
  decidedAt: loanRequests.decidedAt,
  rejectReason: loanRequests.rejectReason,
  loanId: loanOf,
  givenKobo,
};

/**
 * Waiting requests, oldest first, with what each operator owes today; and the
 * latest answered ones. The Assistant Manager sees only their own answers.
 */
export async function listLoanRequests(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const mineOnly = !can(ctx.actor.role, "loan.approve");
  const [waiting, answered] = await Promise.all([
    db
      .select({ ...requestFields, owedNowKobo: owedNow })
      .from(loanRequests)
      .innerJoin(operators, eq(operators.id, loanRequests.operatorId))
      .where(eq(loanRequests.status, "waiting"))
      .orderBy(asc(loanRequests.requestedAt)),
    db
      .select(requestFields)
      .from(loanRequests)
      .innerJoin(operators, eq(operators.id, loanRequests.operatorId))
      .where(
        mineOnly
          ? and(ne(loanRequests.status, "waiting"), eq(loanRequests.requestedBy, ctx.actor.userId))
          : ne(loanRequests.status, "waiting"),
      )
      .orderBy(desc(loanRequests.decidedAt))
      .limit(20),
  ]);
  return {
    waiting,
    answered,
    canApprove: can(ctx.actor.role, "loan.approve"),
    canRequest: can(ctx.actor.role, "loan.request"),
  };
}

/** How many requests wait for the Manager, for Home. */
export async function waitingLoanRequests() {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int`, oldest: sql<string | null>`MIN(${loanRequests.requestedAt})::text` })
    .from(loanRequests)
    .where(eq(loanRequests.status, "waiting"));
  return { count: row?.count ?? 0, oldest: row?.oldest ? new Date(row.oldest) : null };
}

export type LoanRequestRow = Awaited<ReturnType<typeof listLoanRequests>>["answered"][number];
