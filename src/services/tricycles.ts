import { and, asc, count, desc, eq, gte, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { assignments, operators, tricycleBalances, tricycles, workOrders } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import {
  dailyBalanceField,
  dateField,
  tricycleCodeField,
  tricycleRegistrationField,
  idField,
  optionalIdentifier,
  optionalNairaField,
  requiredText,
} from "@/lib/fields";
import { auditFrom } from "./audit";
import { likePattern, requirePermission, type Ctx } from "./context";
import { balanceOn, currentRate, ratesFor, tricycleBalanceHistory } from "./assignments";

const tricycleSchema = z.object({
  registrationNumber: tricycleRegistrationField,
  codeNumber: tricycleCodeField,
  chassisNumber: optionalIdentifier(),
  engineNumber: optionalIdentifier(),
  purchasedOn: dateField("Date purchased"),
  purchaseCost: optionalNairaField("Purchase cost"),
  serviceInterval: z.enum(["fortnightly", "monthly"], "Choose a service cycle"),
  serviceCycleStart: dateField("Service cycle start"),
});

const createSchema = z.object({ dailyBalance: dailyBalanceField });

const DUPLICATES = {
  tricycles_registration_unique: fieldError(
    "registrationNumber",
    "A tricycle with this registration number already exists",
  ),
  tricycles_code_unique: fieldError("codeNumber", "A tricycle with this code number already exists"),
  tricycles_chassis_unique: fieldError(
    "chassisNumber",
    "A tricycle with this chassis number already exists",
  ),
};

function validated(ctx: Ctx, raw: unknown) {
  const { purchaseCost, ...input } = parseInput(tricycleSchema, raw);
  if (input.purchasedOn > businessDate(ctx.clock())) {
    throw fieldError("purchasedOn", "Date purchased cannot be in the future");
  }
  return {
    ...input,
    chassisNumber: input.chassisNumber ?? null,
    engineNumber: input.engineNumber ?? null,
    purchaseCostKobo: purchaseCost ?? null,
  };
}

export async function createTricycle(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "tricycle.manage");
  const values = validated(ctx, raw);
  const { dailyBalance } = parseInput(createSchema, raw);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(tricycles).values(values).returning({ id: tricycles.id });
      // From the purchase date, so an issue recorded late still has an amount.
      await tx.insert(tricycleBalances).values({
        tricycleId: row!.id,
        amountKobo: dailyBalance,
        effectiveFrom: values.purchasedOn,
        reason: "Set when the tricycle was added",
        createdBy: ctx.actor.userId,
      });
      await auditFrom(ctx, tx, {
        action: "tricycle.create",
        entityType: "tricycle",
        entityId: row!.id,
        after: { ...values, dailyBalanceKobo: dailyBalance },
      });
      return row!;
    });
  } catch (error) {
    rethrowConstraint(error, DUPLICATES);
  }
}

export async function updateTricycle(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "tricycle.manage");
  const id = parseInput(idField("tricycle"), rawId);
  const values = validated(ctx, raw);
  try {
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(tricycles).where(eq(tricycles.id, id)).for("update");
      if (!before) throw new DomainError("Tricycle not found.");

      const [first] = await tx
        .select({ issuedOn: assignments.issuedOn })
        .from(assignments)
        .where(eq(assignments.tricycleId, id))
        .orderBy(asc(assignments.issuedOn))
        .limit(1);
      if (first && values.purchasedOn > first.issuedOn) {
        throw fieldError("purchasedOn", "Date purchased cannot be after the first issue date");
      }

      await tx.update(tricycles).set(values).where(eq(tricycles.id, id));
      if (
        before.serviceInterval !== values.serviceInterval ||
        before.serviceCycleStart !== values.serviceCycleStart
      ) {
        // The nightly job plans the new cycle. Services on the old cycle no longer apply.
        await tx
          .delete(workOrders)
          .where(
            and(
              eq(workOrders.tricycleId, id),
              eq(workOrders.type, "service"),
              eq(workOrders.status, "scheduled"),
              gte(workOrders.scheduledFor, businessDate(ctx.clock())),
            ),
          );
      }
      await auditFrom(ctx, tx, {
        action: "tricycle.update",
        entityType: "tricycle",
        entityId: id,
        before,
        after: values,
      });
    });
  } catch (error) {
    rethrowConstraint(error, DUPLICATES);
  }
}

export async function retireTricycle(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "tricycle.manage");
  const id = parseInput(idField("tricycle"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(tricycles).where(eq(tricycles.id, id)).for("update");
    if (!before) throw new DomainError("Tricycle not found.");
    if (before.status !== "in_stock") {
      throw new DomainError("Only a tricycle that is in stock can be retired. Return it first.");
    }
    await tx
      .update(tricycles)
      .set({ status: "retired", retiredReason: reason })
      .where(eq(tricycles.id, id));
    await auditFrom(ctx, tx, {
      action: "tricycle.retire",
      entityType: "tricycle",
      entityId: id,
      before: { status: before.status },
      after: { status: "retired" },
      reason,
    });
  });
}

/**
 * Each tricycle's daily balance today, for lists. The tricycle id is written
 * out in full: in a query without joins Drizzle leaves it unqualified, and
 * "id" would then mean the balance row's own id.
 */
const balanceToday = (ctx: Ctx) => sql<number | null>`(
  SELECT b.amount_kobo::float8 FROM tricycle_balances b
  WHERE b.tricycle_id = "tricycles"."id" AND b.effective_from <= ${businessDate(ctx.clock())}
  ORDER BY b.effective_from DESC, b.created_at DESC LIMIT 1
)`;

export const LIST_LIMIT = 200;
const STATUSES = ["in_stock", "issued", "off_road", "retired"] as const;

export async function listTricycles(ctx: Ctx, filter: { q?: string; status?: string } = {}) {
  requirePermission(ctx, "tricycle.view");
  const conditions: (SQL | undefined)[] = [];
  if (filter.q?.trim()) {
    const pattern = likePattern(filter.q);
    conditions.push(
      or(
        ilike(tricycles.registrationNumber, pattern),
        ilike(tricycles.codeNumber, pattern),
        ilike(operators.name, pattern),
      ),
    );
  }
  const status = STATUSES.find((s) => s === filter.status);
  if (status) conditions.push(eq(tricycles.status, status));

  return db
    .select({
      id: tricycles.id,
      registrationNumber: tricycles.registrationNumber,
      codeNumber: tricycles.codeNumber,
      status: tricycles.status,
      purchasedOn: tricycles.purchasedOn,
      operatorName: operators.name,
      issuedOn: assignments.issuedOn,
      dailyBalanceKobo: balanceToday(ctx),
    })
    .from(tricycles)
    .leftJoin(
      assignments,
      and(eq(assignments.tricycleId, tricycles.id), isNull(assignments.returnedOn)),
    )
    .leftJoin(operators, eq(operators.id, assignments.operatorId))
    .where(and(...conditions))
    .orderBy(asc(tricycles.codeNumber))
    .limit(LIST_LIMIT);
}

export async function getTricycle(ctx: Ctx, id: string) {
  requirePermission(ctx, "tricycle.view");
  const [tricycle] = await db.select().from(tricycles).where(eq(tricycles.id, id)).limit(1);
  if (!tricycle) return null;

  const history = await db
    .select({ assignment: assignments, operatorName: operators.name })
    .from(assignments)
    .innerJoin(operators, eq(operators.id, assignments.operatorId))
    .where(eq(assignments.tricycleId, id))
    .orderBy(desc(assignments.issuedOn), desc(assignments.createdAt));

  const open = history.find((h) => h.assignment.returnedOn === null);
  const today = businessDate(ctx.clock());
  const current = open
    ? {
        ...open,
        dailyBalanceKobo: await currentRate(open.assignment.id, today),
        rates: await ratesFor(open.assignment.id),
      }
    : null;

  const balances = await tricycleBalanceHistory(id);
  const balance = {
    today: await balanceOn(db, id, today),
    upcoming: balances.filter((b) => b.effectiveFrom > today).reverse(),
    history: balances,
  };

  return { tricycle, current, history, balance };
}

/** Tricycles that can be issued right now. */
export async function listInStockTricycles(ctx: Ctx) {
  requirePermission(ctx, "assignment.manage");
  return db
    .select({
      id: tricycles.id,
      codeNumber: tricycles.codeNumber,
      registrationNumber: tricycles.registrationNumber,
      dailyBalanceKobo: balanceToday(ctx),
    })
    .from(tricycles)
    .where(eq(tricycles.status, "in_stock"))
    .orderBy(asc(tricycles.codeNumber));
}

/** Every tricycle, for filter lists. Not capped, unlike the searchable list. */
export async function tricycleChoices(ctx: Ctx) {
  requirePermission(ctx, "tricycle.view");
  return db
    .select({ id: tricycles.id, code: tricycles.codeNumber })
    .from(tricycles)
    .orderBy(asc(tricycles.codeNumber));
}

export async function dashboardCounts(ctx: Ctx) {
  requirePermission(ctx, "dashboard.view");
  const [byStatus, activeOperators, withTricycle] = await Promise.all([
    db.select({ status: tricycles.status, value: count() }).from(tricycles).groupBy(tricycles.status),
    db.select({ value: count() }).from(operators).where(eq(operators.status, "active")),
    db.select({ value: count() }).from(assignments).where(isNull(assignments.returnedOn)),
  ]);
  const of = (status: (typeof STATUSES)[number]) =>
    byStatus.find((row) => row.status === status)?.value ?? 0;
  const active = activeOperators[0]?.value ?? 0;
  return {
    issued: of("issued"),
    inStock: of("in_stock"),
    offRoad: of("off_road"),
    retired: of("retired"),
    activeOperators: active,
    operatorsWithoutTricycle: Math.max(active - (withTricycle[0]?.value ?? 0), 0),
  };
}
