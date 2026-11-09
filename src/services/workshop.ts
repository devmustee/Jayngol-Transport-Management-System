import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type Tx } from "@/db";
import {
  assignments,
  offRoadPeriods,
  stockItems,
  stockMovements,
  tricycles,
  users,
  violations,
  workOrders,
} from "@/db/schema";
import { addDays, businessDate, lagosTime } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { dateField, idField, optionalNairaField, requiredText } from "@/lib/fields";
import { can } from "@/lib/permissions";
import { nextServiceDate, serviceDatesBetween } from "@/lib/service-cycle";
import { holderOn, offRoadOn } from "./assignments";
import { auditFrom, recordAudit } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { proposeViolation, ruleAmount } from "./violations";

const LATEST_ARRIVAL = "10:00";
const PLAN_DAYS_AHEAD = 7;

/* ---------- Nightly job ---------- */

/** Plans a week ahead from each tricycle's fixed cycle. Safe to repeat. */
export async function scheduleServices(tx: Tx, date: string, now: Date) {
  const rows = await tx
    .select({
      tricycleId: tricycles.id,
      start: tricycles.serviceCycleStart,
      interval: tricycles.serviceInterval,
    })
    .from(tricycles)
    .innerJoin(assignments, and(eq(assignments.tricycleId, tricycles.id), isNull(assignments.returnedOn)));
  const values = rows.flatMap((row) =>
    serviceDatesBetween(row.start, row.interval, date, addDays(date, PLAN_DAYS_AHEAD)).map((cycleDate) => ({
      type: "service" as const,
      status: "scheduled" as const,
      tricycleId: row.tricycleId,
      cycleDate,
      scheduledFor: cycleDate,
      createdAt: now,
    })),
  );
  if (values.length > 0) await tx.insert(workOrders).values(values).onConflictDoNothing();
}

/** A service nobody brought in by the end of its day is missed, and is an R3 offence. */
export async function closeMissedServices(tx: Tx, date: string, now: Date) {
  const missed = await tx
    .update(workOrders)
    .set({ status: "missed" })
    .where(
      and(
        eq(workOrders.type, "service"),
        eq(workOrders.status, "scheduled"),
        lt(workOrders.scheduledFor, date),
      ),
    )
    .returning();
  for (const order of missed) {
    const day = order.scheduledFor!;
    if (await offRoadOn(tx, order.tricycleId, day)) continue;
    const operatorId = await holderOn(tx, order.tricycleId, day);
    if (!operatorId) continue;
    const amountKobo = await ruleAmount(tx, "R3", day);
    const [violation] = await tx
      .insert(violations)
      .values({
        ruleCode: "R3",
        operatorId,
        tricycleId: order.tricycleId,
        occurredOn: day,
        amountKobo,
        status: "proposed",
        occurrenceKey: `R3:${order.id}`,
        note: "Did not come for service",
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: violations.id });
    if (violation) {
      await recordAudit(tx, null, now, {
        action: "violation.propose",
        entityType: "operator",
        entityId: operatorId,
        after: { rule: "R3", occurredOn: day, amountKobo },
      });
    }
  }
}

/* ---------- Work orders ---------- */

async function lockOrder(tx: Tx, id: string) {
  const [order] = await tx.select().from(workOrders).where(eq(workOrders.id, id)).for("update");
  if (!order) throw new DomainError("Work order not found.");
  return order;
}

const faultSchema = z.object({
  tricycleId: idField("tricycle"),
  fault: requiredText("Fault", 500),
});

/** A repair starts when the tricycle comes in, and takes it off the road. */
export async function reportFault(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "workorder.manage");
  const input = parseInput(faultSchema, raw);
  const now = ctx.clock();
  const today = businessDate(now);
  try {
    return await db.transaction(async (tx) => {
      const [tricycle] = await tx
        .select({ status: tricycles.status })
        .from(tricycles)
        .where(eq(tricycles.id, input.tricycleId))
        .for("update");
      if (!tricycle) throw fieldError("tricycleId", "Choose a tricycle");
      if (tricycle.status === "off_road") throw fieldError("tricycleId", "This tricycle is already off the road");
      if (tricycle.status === "retired") throw fieldError("tricycleId", "This tricycle is retired");

      const [order] = await tx
        .insert(workOrders)
        .values({
          type: "maintenance",
          status: "checked_in",
          tricycleId: input.tricycleId,
          fault: input.fault,
          checkedInAt: now,
          checkedInBy: ctx.actor.userId,
          createdBy: ctx.actor.userId,
          createdAt: now,
        })
        .returning({ id: workOrders.id });
      await tx.insert(offRoadPeriods).values({
        tricycleId: input.tricycleId,
        workOrderId: order!.id,
        startsOn: today,
        reason: input.fault,
      });
      await tx.update(tricycles).set({ status: "off_road" }).where(eq(tricycles.id, input.tricycleId));
      await auditFrom(ctx, tx, {
        action: "workorder.fault",
        entityType: "tricycle",
        entityId: input.tricycleId,
        before: { status: tricycle.status },
        after: { status: "off_road", fault: input.fault },
      });
      return order!;
    });
  } catch (error) {
    rethrowConstraint(error, {
      one_open_repair: fieldError("tricycleId", "This tricycle already has an open repair"),
      one_open_off_road: fieldError("tricycleId", "This tricycle is already off the road"),
      off_road_no_overlap: fieldError("tricycleId", "This tricycle has already been off the road today"),
    });
  }
}

/** Records arrival. Arriving after 10:00 WAT, or on a later day, is R3 once. */
export async function checkInService(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "workorder.checkin");
  const id = parseInput(idField("work order"), rawId);
  const now = ctx.clock();
  const today = businessDate(now);
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (order.type !== "service") throw new DomainError("Only a service is checked in here.");
    if (order.status !== "scheduled" && order.status !== "missed") {
      throw new DomainError("This service has already been checked in or closed.");
    }
    await tx
      .update(workOrders)
      .set({ status: "checked_in", checkedInAt: now, checkedInBy: ctx.actor.userId })
      .where(eq(workOrders.id, id));
    await auditFrom(ctx, tx, {
      action: "workorder.checkin",
      entityType: "tricycle",
      entityId: order.tricycleId,
      after: { scheduledFor: order.scheduledFor, time: lagosTime(now) },
    });

    const day = order.scheduledFor!;
    const late = today > day || (today === day && lagosTime(now) > LATEST_ARRIVAL);
    if (!late || (await offRoadOn(tx, order.tricycleId, day))) return { late: false };
    const operatorId = await holderOn(tx, order.tricycleId, day);
    if (!operatorId) return { late: false };
    await proposeViolation(tx, ctx, {
      ruleCode: "R3",
      operatorId,
      tricycleId: order.tricycleId,
      occurredOn: day,
      occurrenceKey: `R3:${id}`,
      note: `Checked in at ${lagosTime(now)} on ${today}`,
    });
    return { late: true };
  });
}

const rescheduleSchema = z.object({
  scheduledFor: dateField("New date"),
  reason: requiredText("Reason", 500),
});

/** Moves this one service. The cycle date stays, so later services do not move. */
export async function rescheduleService(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "workorder.manage");
  const id = parseInput(idField("work order"), rawId);
  const input = parseInput(rescheduleSchema, raw);
  if (input.scheduledFor < businessDate(ctx.clock())) {
    throw fieldError("scheduledFor", "The new date cannot be in the past");
  }
  await db.transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (order.type !== "service" || (order.status !== "scheduled" && order.status !== "missed")) {
      throw new DomainError("Only a service that has not been checked in can be moved.");
    }
    await tx
      .update(workOrders)
      .set({ scheduledFor: input.scheduledFor, status: "scheduled" })
      .where(eq(workOrders.id, id));
    await auditFrom(ctx, tx, {
      action: "workorder.reschedule",
      entityType: "tricycle",
      entityId: order.tricycleId,
      before: { scheduledFor: order.scheduledFor },
      after: { scheduledFor: input.scheduledFor },
      reason: input.reason,
    });
  });
}

/** Puts a tricycle back on the road, with its operator if it still has one. */
async function release(tx: Tx, order: typeof workOrders.$inferSelect, today: string) {
  await tx
    .update(offRoadPeriods)
    .set({ endsOn: today })
    .where(and(eq(offRoadPeriods.workOrderId, order.id), isNull(offRoadPeriods.endsOn)));
  const [held] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.tricycleId, order.tricycleId), isNull(assignments.returnedOn)))
    .limit(1);
  await tx
    .update(tricycles)
    .set({ status: held ? "issued" : "in_stock" })
    .where(eq(tricycles.id, order.tricycleId));
}

const completeSchema = z.object({
  findings: requiredText("Findings", 1000),
  labourCost: optionalNairaField("Labour cost"),
});

export async function completeWorkOrder(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "workorder.manage");
  const id = parseInput(idField("work order"), rawId);
  const input = parseInput(completeSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (order.status !== "checked_in") throw new DomainError("Only a tricycle in the workshop can be completed.");
    await tx
      .update(workOrders)
      .set({
        status: "completed",
        findings: input.findings,
        labourCostKobo: input.labourCost ?? 0,
        completedAt: now,
        completedBy: ctx.actor.userId,
      })
      .where(eq(workOrders.id, id));
    if (order.type === "maintenance") await release(tx, order, businessDate(now));

    await auditFrom(ctx, tx, {
      action: "workorder.complete",
      entityType: "tricycle",
      entityId: order.tricycleId,
      after: { type: order.type, labourKobo: input.labourCost ?? 0 },
    });
  });
}

const reasonSchema = z.object({ reason: requiredText("Reason", 500) });

export async function cancelWorkOrder(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "workorder.manage");
  const id = parseInput(idField("work order"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  await db.transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (order.status === "completed" || order.status === "cancelled") {
      throw new DomainError("This work order is already closed.");
    }
    const parts = await partsOn(tx, id);
    if (parts.length > 0) throw new DomainError("Return the parts to the store before cancelling.");
    await tx.update(workOrders).set({ status: "cancelled", cancelReason: reason }).where(eq(workOrders.id, id));
    if (order.type === "maintenance") await release(tx, order, businessDate(ctx.clock()));
    await auditFrom(ctx, tx, {
      action: "workorder.cancel",
      entityType: "tricycle",
      entityId: order.tricycleId,
      before: { status: order.status },
      reason,
    });
  });
}

/* ---------- Reading ---------- */

const reversal = alias(stockMovements, "reversal");

/** Parts still fitted: issued and not sent back to the store. */
function partsQuery(exec: Tx | typeof db) {
  return exec
    .select({
      movementId: stockMovements.id,
      workOrderId: stockMovements.workOrderId,
      itemName: stockItems.name,
      unit: stockItems.unit,
      quantityMilli: stockMovements.quantityMilli,
      costKobo: stockMovements.costKobo,
    })
    .from(stockMovements)
    .innerJoin(stockItems, eq(stockItems.id, stockMovements.itemId))
    .leftJoin(reversal, eq(reversal.reversesId, stockMovements.id))
    .$dynamic();
}

const partsOn = (exec: Tx | typeof db, workOrderId: string) =>
  partsQuery(exec).where(
    and(
      eq(stockMovements.kind, "issued"),
      eq(stockMovements.workOrderId, workOrderId),
      isNull(reversal.id),
    ),
  );

export async function listWorkshop(ctx: Ctx) {
  requirePermission(ctx, "workorder.view");
  const today = businessDate(ctx.clock());
  const rows = await db
    .select({
      id: workOrders.id,
      type: workOrders.type,
      status: workOrders.status,
      scheduledFor: workOrders.scheduledFor,
      fault: workOrders.fault,
      checkedInAt: workOrders.checkedInAt,
      tricycleId: tricycles.id,
      code: tricycles.codeNumber,
      holder: assignments.id,
    })
    .from(workOrders)
    .innerJoin(tricycles, eq(tricycles.id, workOrders.tricycleId))
    .leftJoin(assignments, and(eq(assignments.tricycleId, tricycles.id), isNull(assignments.returnedOn)))
    .where(
      and(
        inArray(workOrders.status, ["scheduled", "missed", "checked_in"]),
        sql`(${workOrders.scheduledFor} IS NULL OR ${workOrders.scheduledFor} <= ${addDays(today, PLAN_DAYS_AHEAD)})`,
        sql`(${workOrders.status} <> 'missed' OR ${workOrders.scheduledFor} >= ${addDays(today, -30)})`,
      ),
    )
    .orderBy(asc(workOrders.scheduledFor), asc(tricycles.codeNumber))
    .limit(300);
  return {
    today,
    inWorkshop: rows.filter((row) => row.status === "checked_in"),
    overdue: rows.filter(
      // A tricycle back in stock has nobody to chase. The miss stays in its history.
      (row) => row.holder !== null && (row.status === "missed" || (row.status === "scheduled" && row.scheduledFor! < today)),
    ),
    dueToday: rows.filter((row) => row.status === "scheduled" && row.scheduledFor === today),
    upcoming: rows.filter((row) => row.status === "scheduled" && row.scheduledFor! > today),
  };
}

export async function getWorkOrder(ctx: Ctx, id: string) {
  requirePermission(ctx, "workorder.view");
  const [row] = await db
    .select({ order: workOrders, code: tricycles.codeNumber, registration: tricycles.registrationNumber })
    .from(workOrders)
    .innerJoin(tricycles, eq(tricycles.id, workOrders.tricycleId))
    .where(eq(workOrders.id, id))
    .limit(1);
  if (!row) return null;
  const showCost = can(ctx.actor.role, "workorder.cost");
  const parts = await partsOn(db, id);
  return {
    ...row,
    order: { ...row.order, labourCostKobo: showCost ? row.order.labourCostKobo : 0 },
    showCost,
    parts,
    partsCostKobo: parts.reduce((sum, part) => sum - part.costKobo, 0),
  };
}

const HISTORY_LIMIT = 300;

/** Every service and repair across the fleet, newest first. */
export async function listWorkHistory(
  ctx: Ctx,
  filter: { tricycleId?: string; type?: "service" | "maintenance"; from?: string; to?: string } = {},
) {
  requirePermission(ctx, "workorder.view");
  const day = sql`COALESCE((${workOrders.checkedInAt} AT TIME ZONE 'Africa/Lagos')::date, ${workOrders.scheduledFor})`;
  const conditions: SQL[] = [inArray(workOrders.status, ["checked_in", "completed", "missed"])];
  if (filter.tricycleId) conditions.push(eq(workOrders.tricycleId, filter.tricycleId));
  if (filter.type) conditions.push(eq(workOrders.type, filter.type));
  if (filter.from) conditions.push(sql`${day} >= ${filter.from}::date`);
  if (filter.to) conditions.push(sql`${day} <= ${filter.to}::date`);

  const rows = await db
    .select({
      order: workOrders,
      code: tricycles.codeNumber,
      completedByName: users.name,
      date: sql<string>`${day}::text`,
    })
    .from(workOrders)
    .innerJoin(tricycles, eq(tricycles.id, workOrders.tricycleId))
    .leftJoin(users, eq(users.id, workOrders.completedBy))
    .where(and(...conditions))
    .orderBy(desc(day), asc(tricycles.codeNumber))
    .limit(HISTORY_LIMIT + 1);

  const page = rows.slice(0, HISTORY_LIMIT);
  const parts =
    page.length === 0
      ? []
      : await partsQuery(db).where(
          and(
            eq(stockMovements.kind, "issued"),
            inArray(stockMovements.workOrderId, page.map((row) => row.order.id)),
            isNull(reversal.id),
          ),
        );
  const showCost = can(ctx.actor.role, "workorder.cost");
  return {
    showCost,
    truncated: rows.length > HISTORY_LIMIT,
    rows: page.map((row) => {
      const used = parts.filter((part) => part.workOrderId === row.order.id);
      return {
        id: row.order.id,
        type: row.order.type,
        status: row.order.status,
        date: row.date,
        code: row.code,
        tricycleId: row.order.tricycleId,
        fault: row.order.fault,
        findings: row.order.findings,
        completedAt: row.order.completedAt,
        completedByName: row.completedByName,
        parts: used.map((part) => ({
          id: part.movementId,
          itemName: part.itemName,
          unit: part.unit,
          quantityMilli: -part.quantityMilli,
        })),
        partsKobo: showCost ? used.reduce((sum, part) => sum - part.costKobo, 0) : 0,
        labourKobo: showCost ? row.order.labourCostKobo : 0,
      };
    }),
  };
}

/** Every service, repair, part and cost for one tricycle. */
export async function tricycleWorkHistory(ctx: Ctx, tricycleId: string) {
  requirePermission(ctx, "workorder.view");
  const [orders, parts, [tricycle], open] = await Promise.all([
    db
      .select()
      .from(workOrders)
      .where(
        and(
          eq(workOrders.tricycleId, tricycleId),
          inArray(workOrders.status, ["checked_in", "completed", "missed"]),
        ),
      )
      .orderBy(desc(sql`COALESCE(${workOrders.checkedInAt}, ${workOrders.createdAt})`))
      .limit(200),
    partsQuery(db).where(
      and(eq(stockMovements.kind, "issued"), eq(stockMovements.tricycleId, tricycleId), isNull(reversal.id)),
    ),
    db
      .select({ start: tricycles.serviceCycleStart, interval: tricycles.serviceInterval })
      .from(tricycles)
      .where(eq(tricycles.id, tricycleId))
      .limit(1),
    nextOpenService(tricycleId, businessDate(ctx.clock())),
  ]);
  const showCost = can(ctx.actor.role, "workorder.cost");
  const rows = orders.map((order) => {
    const used = parts.filter((part) => part.workOrderId === order.id);
    return {
      id: order.id,
      type: order.type,
      status: order.status,
      fault: order.fault,
      findings: order.findings,
      date: businessDate(order.checkedInAt ?? new Date(`${order.scheduledFor}T12:00:00Z`)),
      parts: used,
      partsKobo: showCost ? used.reduce((sum, part) => sum - part.costKobo, 0) : 0,
      labourKobo: showCost ? order.labourCostKobo : 0,
    };
  });
  return {
    orders: rows,
    showCost,
    nextService:
      open ??
      (tricycle ? nextServiceDate(tricycle.start, tricycle.interval, businessDate(ctx.clock())) : null),
    partsKobo: rows.reduce((sum, row) => sum + row.partsKobo, 0),
    labourKobo: rows.reduce((sum, row) => sum + row.labourKobo, 0),
  };
}

async function nextOpenService(tricycleId: string, today: string): Promise<string | null> {
  const [row] = await db
    .select({ date: workOrders.scheduledFor })
    .from(workOrders)
    .where(
      and(
        eq(workOrders.tricycleId, tricycleId),
        eq(workOrders.status, "scheduled"),
        gte(workOrders.scheduledFor, today),
      ),
    )
    .orderBy(asc(workOrders.scheduledFor))
    .limit(1);
  return row?.date ?? null;
}

/** For the portal: from the session only, and never any cost. */
export async function getMyService(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  const operatorId = ctx.actor.operatorId;
  if (!operatorId) throw new DomainError("This login is not linked to an operator.");
  const today = businessDate(ctx.clock());
  const [held] = await db
    .select({
      tricycleId: assignments.tricycleId,
      issuedOn: assignments.issuedOn,
      start: tricycles.serviceCycleStart,
      interval: tricycles.serviceInterval,
    })
    .from(assignments)
    .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
    .where(and(eq(assignments.operatorId, operatorId), isNull(assignments.returnedOn)))
    .limit(1);
  if (!held) return { nextService: null, history: [] };
  const history = await db
    .select({ id: workOrders.id, type: workOrders.type, completedAt: workOrders.completedAt })
    .from(workOrders)
    .where(
      and(
        eq(workOrders.tricycleId, held.tricycleId),
        eq(workOrders.status, "completed"),
        gte(workOrders.completedAt, new Date(`${held.issuedOn}T00:00:00+01:00`)),
        lte(workOrders.completedAt, ctx.clock()),
      ),
    )
    .orderBy(desc(workOrders.completedAt))
    .limit(10);
  return {
    nextService: (await nextOpenService(held.tricycleId, today)) ?? nextServiceDate(held.start, held.interval, today),
    history,
  };
}
