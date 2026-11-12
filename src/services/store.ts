import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { stockBalances, stockItems, stockMovements, tricycles, users, workOrders } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { asPgError, DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { idField, isUuid, nairaField, optionalNairaField, optionalText, requiredText } from "@/lib/fields";
import { formatStock, MILLI, mulDiv, parseQuantity, quantityField } from "@/lib/quantity";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";

async function lockStock(tx: Tx, itemId: string) {
  const [row] = await tx
    .select({ item: stockItems, balance: stockBalances })
    .from(stockBalances)
    .innerJoin(stockItems, eq(stockItems.id, stockBalances.itemId))
    .where(eq(stockBalances.itemId, itemId))
    .for("update", { of: stockBalances });
  if (!row) throw new DomainError("Store item not found.");
  return row;
}

/** Every stock change goes through here, so the balance and its movement cannot differ. */
async function move(
  tx: Tx,
  ctx: Ctx,
  input: Omit<typeof stockMovements.$inferInsert, "performedBy" | "businessDate" | "createdAt">,
) {
  await tx
    .update(stockBalances)
    .set({
      quantityMilli: sql`${stockBalances.quantityMilli} + ${input.quantityMilli}`,
      valueKobo: sql`${stockBalances.valueKobo} + ${input.costKobo}`,
    })
    .where(eq(stockBalances.itemId, input.itemId));
  const [row] = await tx
    .insert(stockMovements)
    .values({
      ...input,
      performedBy: ctx.actor.userId,
      businessDate: businessDate(ctx.clock()),
      createdAt: ctx.clock(),
    })
    .returning({ id: stockMovements.id });
  return row!;
}

const requireWhole = (item: { wholeOnly: boolean; unit: string }, milli: number, field = "quantity") => {
  if (item.wholeOnly && milli % MILLI !== 0) throw fieldError(field, `Enter whole ${item.unit}s`);
};

const itemSchema = z.object({
  name: requiredText("Name", 80),
  unit: requiredText("Unit", 20),
  kind: z.enum(["whole", "part"], "Choose how it is counted"),
  reorderLevel: quantityField("Reorder level"),
});

const newItemSchema = itemSchema.extend({
  /** Stock already on the shelf when the item is added. */
  quantity: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), quantityField("Quantity").optional()),
  unitCost: optionalNairaField("Cost per unit"),
});

/**
 * Adds an item. When stock is already on the shelf, its quantity and cost per
 * unit are received in the same save, so the store's value is right from the start.
 */
export async function createStockItem(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "stock.move");
  const input = parseInput(newItemSchema, raw);
  const unit = input.unit.toLowerCase();
  const whole = input.kind === "whole";
  if (whole && input.reorderLevel % MILLI !== 0) throw fieldError("reorderLevel", `Enter whole ${unit}s`);
  const opening = input.quantity ?? 0;
  if (opening > 0) {
    if (whole && opening % MILLI !== 0) throw fieldError("quantity", `Enter whole ${unit}s`);
    if (!input.unitCost) throw fieldError("unitCost", `Enter the cost per ${unit}`);
  }
  try {
    return await db.transaction(async (tx) => {
      const [item] = await tx
        .insert(stockItems)
        .values({ name: input.name, unit, wholeOnly: whole, reorderLevelMilli: input.reorderLevel })
        .returning({ id: stockItems.id });
      await tx.insert(stockBalances).values({ itemId: item!.id });
      await auditFrom(ctx, tx, {
        action: "stock.item_create",
        entityType: "stock_item",
        entityId: item!.id,
        after: { name: input.name, unit },
      });
      if (opening > 0) {
        await move(tx, ctx, {
          itemId: item!.id,
          kind: "received",
          quantityMilli: opening,
          costKobo: mulDiv(opening, input.unitCost!, MILLI),
          reason: "Stock in the store when the item was added",
        });
        await auditFrom(ctx, tx, {
          action: "stock.receive",
          entityType: "stock_item",
          entityId: item!.id,
          after: { quantity: opening, unitCostKobo: input.unitCost },
          reason: "Stock in the store when the item was added",
        });
      }
      return item!;
    });
  } catch (error) {
    rethrowConstraint(error, { stock_items_name_unique: fieldError("name", "This item already exists") });
  }
}

/**
 * Changes an item's name, unit, how it is counted and its reorder alert.
 * Stock and value are not touched: those change only by receiving, taking out
 * or a count. Whole units are refused while part of a unit is in the store.
 */
export async function updateStockItem(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "stock.move");
  const itemId = parseInput(idField("item"), rawId);
  const input = parseInput(itemSchema, raw);
  const unit = input.unit.toLowerCase();
  const whole = input.kind === "whole";
  try {
    await db.transaction(async (tx) => {
      const { item, balance } = await lockStock(tx, itemId);
      if (whole && balance.quantityMilli % MILLI !== 0) {
        throw fieldError(
          "kind",
          `${formatStock(balance.quantityMilli, item.unit)} in the store is not a whole number. Keep part units, or correct the count first.`,
        );
      }
      if (whole && input.reorderLevel % MILLI !== 0) throw fieldError("reorderLevel", `Enter whole ${unit}s`);
      const after = { name: input.name, unit, wholeOnly: whole, reorderLevelMilli: input.reorderLevel };
      const before = { name: item.name, unit: item.unit, wholeOnly: item.wholeOnly, reorderLevelMilli: item.reorderLevelMilli };
      if (JSON.stringify(after) === JSON.stringify(before)) return;
      await tx.update(stockItems).set(after).where(eq(stockItems.id, itemId));
      await auditFrom(ctx, tx, { action: "stock.item_update", entityType: "stock_item", entityId: itemId, before, after });
    });
  } catch (error) {
    rethrowConstraint(error, { stock_items_name_unique: fieldError("name", "Another item already has this name") });
  }
}

const reorderSchema = z.object({ reorderLevel: quantityField("Reorder level") });

export async function setReorderLevel(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "stock.move");
  const itemId = parseInput(idField("item"), rawId);
  const { reorderLevel } = parseInput(reorderSchema, raw);
  await db.transaction(async (tx) => {
    const { item } = await lockStock(tx, itemId);
    await tx.update(stockItems).set({ reorderLevelMilli: reorderLevel }).where(eq(stockItems.id, itemId));
    await auditFrom(ctx, tx, {
      action: "stock.reorder_level",
      entityType: "stock_item",
      entityId: itemId,
      before: { reorderLevel: item.reorderLevelMilli },
      after: { reorderLevel },
    });
  });
}

const receiveSchema = z.object({
  quantity: quantityField("Quantity"),
  unitCost: nairaField("Cost per unit"),
  note: optionalText(300),
});

export async function receiveStock(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "stock.move");
  const itemId = parseInput(idField("item"), rawId);
  const input = parseInput(receiveSchema, raw);
  if (input.quantity <= 0) throw fieldError("quantity", "Quantity must be more than zero");
  await db.transaction(async (tx) => {
    const { item } = await lockStock(tx, itemId);
    requireWhole(item, input.quantity);
    await move(tx, ctx, {
      itemId,
      kind: "received",
      quantityMilli: input.quantity,
      costKobo: mulDiv(input.quantity, input.unitCost, MILLI),
      reason: input.note ?? null,
    });
    await auditFrom(ctx, tx, {
      action: "stock.receive",
      entityType: "stock_item",
      entityId: itemId,
      after: { quantity: input.quantity, unitCostKobo: input.unitCost },
      reason: input.note,
    });
  });
}

const issueSchema = z.object({
  itemId: idField("item"),
  quantity: quantityField("Quantity"),
});

/** Locks an open work order so parts can go to it. */
async function lockOpenOrder(tx: Tx, workOrderId: string) {
  const [order] = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update");
  if (!order) throw new DomainError("Work order not found.");
  if (order.status !== "checked_in") throw new DomainError("Parts can only go to a tricycle in the workshop.");
  return order;
}

/** One item out of the store to an open work order, at the store's average cost. */
async function issueLine(
  tx: Tx,
  ctx: Ctx,
  order: { id: string; tricycleId: string },
  itemId: string,
  quantity: number,
  field: string,
) {
  const { item, balance } = await lockStock(tx, itemId);
  requireWhole(item, quantity, field);
  if (quantity > balance.quantityMilli) {
    throw fieldError(
      field,
      balance.quantityMilli === 0
        ? `No ${item.name.toLowerCase()} left in the store`
        : `Only ${formatStock(balance.quantityMilli, item.unit)} of ${item.name.toLowerCase()} left in the store`,
    );
  }
  const costKobo =
    quantity === balance.quantityMilli ? balance.valueKobo : mulDiv(balance.valueKobo, quantity, balance.quantityMilli);
  await move(tx, ctx, {
    itemId: item.id,
    kind: "issued",
    quantityMilli: -quantity,
    costKobo: -costKobo,
    workOrderId: order.id,
    tricycleId: order.tricycleId,
  });
  await auditFrom(ctx, tx, {
    action: "stock.issue",
    entityType: "tricycle",
    entityId: order.tricycleId,
    after: { item: item.name, quantity, costKobo, workOrderId: order.id },
  });
}

/**
 * Stock out to an open work order. The row lock queues two people issuing at
 * once, and the database refuses a negative balance if anything gets past it.
 */
export async function issuePart(ctx: Ctx, rawOrderId: unknown, raw: unknown) {
  requirePermission(ctx, "stock.move");
  const workOrderId = parseInput(idField("work order"), rawOrderId);
  const input = parseInput(issueSchema, raw);
  if (input.quantity <= 0) throw fieldError("quantity", "Quantity must be more than zero");
  try {
    await db.transaction(async (tx) => {
      const order = await lockOpenOrder(tx, workOrderId);
      await issueLine(tx, ctx, order, input.itemId, input.quantity, "quantity");
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "stock_never_negative") {
      throw fieldError("quantity", "There is not enough left in the store");
    }
    throw error;
  }
}

/** The form field for one item's quantity on Take out items. */
export const QTY_PREFIX = "qty.";

/**
 * Several items out of the store to one open work order, all or none. Each
 * quantity comes as `qty.<itemId>`; empty ones are skipped. Items are locked
 * in a fixed order so two people taking the same items cannot deadlock.
 */
export async function takeOutItems(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "stock.move");
  const input = (raw ?? {}) as Record<string, unknown>;
  if (!input.workOrderId) throw fieldError("workOrderId", "Choose the tricycle");
  const workOrderId = parseInput(idField("work order"), input.workOrderId);

  const lines: { itemId: string; quantity: number; field: string }[] = [];
  const errors: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith(QTY_PREFIX) || typeof value !== "string" || value.trim() === "") continue;
    const itemId = key.slice(QTY_PREFIX.length);
    if (!isUuid(itemId)) continue;
    const quantity = parseQuantity(value);
    if (quantity === null) errors[key] = "Enter a number";
    else if (quantity > 0) lines.push({ itemId, quantity, field: key });
  }
  if (Object.keys(errors).length > 0) throw new DomainError("Please check the highlighted fields.", errors);
  if (lines.length === 0) throw new DomainError("Enter how much of at least one item to take out.");
  lines.sort((a, b) => (a.itemId < b.itemId ? -1 : 1));

  try {
    return await db.transaction(async (tx) => {
      const order = await lockOpenOrder(tx, workOrderId);
      for (const line of lines) await issueLine(tx, ctx, order, line.itemId, line.quantity, line.field);
      return { workOrderId: order.id, count: lines.length };
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "stock_never_negative") {
      throw new DomainError("There is not enough left in the store. Please check the quantities.");
    }
    throw error;
  }
}

/** Tricycles in the workshop now, with their open job, for Take out items. */
export async function openJobsForParts(ctx: Ctx) {
  requirePermission(ctx, "stock.move");
  return db
    .select({
      id: workOrders.id,
      type: workOrders.type,
      fault: workOrders.fault,
      checkedInAt: workOrders.checkedInAt,
      code: tricycles.codeNumber,
    })
    .from(workOrders)
    .innerJoin(tricycles, eq(tricycles.id, workOrders.tricycleId))
    .where(eq(workOrders.status, "checked_in"))
    .orderBy(asc(tricycles.codeNumber));
}

/** Undoes an issue made by mistake, while the work order is still open. */
export async function returnPart(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "stock.move");
  const id = parseInput(idField("part"), rawId);
  try {
    await db.transaction(async (tx) => {
      const [issued] = await tx.select().from(stockMovements).where(eq(stockMovements.id, id)).limit(1);
      if (!issued || issued.kind !== "issued") throw new DomainError("Part not found.");
      const [order] = await tx
        .select()
        .from(workOrders)
        .where(eq(workOrders.id, issued.workOrderId!))
        .for("update");
      if (order!.status !== "checked_in") throw new DomainError("This work order is already closed.");
      await lockStock(tx, issued.itemId);
      await move(tx, ctx, {
        itemId: issued.itemId,
        kind: "returned",
        quantityMilli: -issued.quantityMilli,
        costKobo: -issued.costKobo,
        workOrderId: issued.workOrderId,
        tricycleId: issued.tricycleId,
        reversesId: issued.id,
      });
      await auditFrom(ctx, tx, {
        action: "stock.return",
        entityType: "tricycle",
        entityId: issued.tricycleId!,
        after: { quantity: -issued.quantityMilli, workOrderId: issued.workOrderId },
      });
    });
  } catch (error) {
    rethrowConstraint(error, {
      stock_movement_reversed_once: new DomainError("This part has already been returned."),
    });
  }
}

const countSchema = z.object({
  counted: quantityField("Counted quantity"),
  reason: requiredText("Reason", 500),
});

/** A physical count. Value moves with quantity at the current average cost. */
export async function adjustStock(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "stock.adjust");
  const itemId = parseInput(idField("item"), rawId);
  const input = parseInput(countSchema, raw);
  await db.transaction(async (tx) => {
    const { item, balance } = await lockStock(tx, itemId);
    requireWhole(item, input.counted, "counted");
    const delta = input.counted - balance.quantityMilli;
    if (delta === 0) throw fieldError("counted", "This already matches the store record");
    const costKobo =
      balance.quantityMilli === 0
        ? 0
        : input.counted === 0
          ? -balance.valueKobo
          : Math.sign(delta) * mulDiv(balance.valueKobo, Math.abs(delta), balance.quantityMilli);
    await move(tx, ctx, { itemId, kind: "adjusted", quantityMilli: delta, costKobo, reason: input.reason });
    await auditFrom(ctx, tx, {
      action: "stock.adjust",
      entityType: "stock_item",
      entityId: itemId,
      before: { quantity: balance.quantityMilli },
      after: { quantity: input.counted },
      reason: input.reason,
    });
  });
}

const stockRows = () =>
  db
    .select({
      id: stockItems.id,
      name: stockItems.name,
      unit: stockItems.unit,
      wholeOnly: stockItems.wholeOnly,
      reorderLevelMilli: stockItems.reorderLevelMilli,
      quantityMilli: stockBalances.quantityMilli,
      valueKobo: stockBalances.valueKobo,
    })
    .from(stockItems)
    .innerJoin(stockBalances, eq(stockBalances.itemId, stockItems.id))
    .orderBy(asc(stockItems.name))
    .$dynamic();

export const isLow = (row: { reorderLevelMilli: number; quantityMilli: number }) =>
  row.reorderLevelMilli > 0 && row.quantityMilli <= row.reorderLevelMilli;

export async function listStock(ctx: Ctx) {
  requirePermission(ctx, "stock.view");
  return stockRows();
}

export async function lowStock(ctx: Ctx) {
  requirePermission(ctx, "stock.view");
  return (await stockRows()).filter(isLow);
}

/** What can be issued to a work order: items with stock in the store. */
export async function partsToIssue(ctx: Ctx) {
  requirePermission(ctx, "stock.move");
  return (await stockRows()).filter((row) => row.quantityMilli > 0);
}

export async function getStockItem(ctx: Ctx, id: string) {
  requirePermission(ctx, "stock.view");
  const [row] = await stockRows().where(eq(stockItems.id, id));
  if (!row) return null;
  const movements = await db
      .select({
        id: stockMovements.id,
        kind: stockMovements.kind,
        quantityMilli: stockMovements.quantityMilli,
        costKobo: stockMovements.costKobo,
        reason: stockMovements.reason,
        businessDate: stockMovements.businessDate,
        tricycleCode: tricycles.codeNumber,
        workOrderId: stockMovements.workOrderId,
      })
      .from(stockMovements)
      .leftJoin(tricycles, eq(tricycles.id, stockMovements.tricycleId))
      .where(eq(stockMovements.itemId, id))
      .orderBy(desc(stockMovements.createdAt))
      .limit(100);
  return { item: row, movements };
}

const reversal = alias(stockMovements, "usage_reversal");
export const HISTORY_LIMIT = 300;

/** What left the store, on which tricycle, when and by whom. Returned parts are left out. */
export async function listStockUsage(
  ctx: Ctx,
  filter: { itemId?: string; tricycleId?: string; from?: string; to?: string } = {},
) {
  requirePermission(ctx, "stock.view");
  const conditions: SQL[] = [eq(stockMovements.kind, "issued"), isNull(reversal.id)];
  if (filter.itemId) conditions.push(eq(stockMovements.itemId, filter.itemId));
  if (filter.tricycleId) conditions.push(eq(stockMovements.tricycleId, filter.tricycleId));
  if (filter.from) conditions.push(gte(stockMovements.businessDate, filter.from));
  if (filter.to) conditions.push(lte(stockMovements.businessDate, filter.to));
  const where = and(...conditions);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: stockMovements.id,
        usedAt: stockMovements.createdAt,
        quantityMilli: stockMovements.quantityMilli,
        costKobo: stockMovements.costKobo,
        itemName: stockItems.name,
        unit: stockItems.unit,
        tricycleId: tricycles.id,
        tricycleCode: tricycles.codeNumber,
        workOrderId: workOrders.id,
        workType: workOrders.type,
        issuedBy: users.name,
      })
      .from(stockMovements)
      .innerJoin(stockItems, eq(stockItems.id, stockMovements.itemId))
      .innerJoin(tricycles, eq(tricycles.id, stockMovements.tricycleId))
      .innerJoin(workOrders, eq(workOrders.id, stockMovements.workOrderId))
      .innerJoin(users, eq(users.id, stockMovements.performedBy))
      .leftJoin(reversal, eq(reversal.reversesId, stockMovements.id))
      .where(where)
      .orderBy(desc(stockMovements.createdAt))
      .limit(HISTORY_LIMIT + 1),
    db
      .select({
        itemName: stockItems.name,
        unit: stockItems.unit,
        quantityMilli: sql<number>`(-SUM(${stockMovements.quantityMilli}))::float8`,
        costKobo: sql<number>`(-SUM(${stockMovements.costKobo}))::float8`,
      })
      .from(stockMovements)
      .innerJoin(stockItems, eq(stockItems.id, stockMovements.itemId))
      .leftJoin(reversal, eq(reversal.reversesId, stockMovements.id))
      .where(where)
      .groupBy(stockItems.name, stockItems.unit)
      .orderBy(stockItems.name),
  ]);
  return {
    rows: rows.slice(0, HISTORY_LIMIT),
    truncated: rows.length > HISTORY_LIMIT,
    totals,
    totalCostKobo: totals.reduce((sum, row) => sum + row.costKobo, 0),
  };
}

export async function stockItemChoices(ctx: Ctx) {
  requirePermission(ctx, "stock.view");
  return db.select({ id: stockItems.id, name: stockItems.name }).from(stockItems).orderBy(asc(stockItems.name));
}
