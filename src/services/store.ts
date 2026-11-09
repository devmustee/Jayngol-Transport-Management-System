import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { stockBalances, stockItems, stockMovements, tricycles, users, workOrders } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { asPgError, DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { idField, nairaField, optionalText, requiredText } from "@/lib/fields";
import { formatQuantity, MILLI, mulDiv, quantityField } from "@/lib/quantity";
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

export async function createStockItem(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "stock.move");
  const input = parseInput(itemSchema, raw);
  try {
    return await db.transaction(async (tx) => {
      const [item] = await tx
        .insert(stockItems)
        .values({
          name: input.name,
          unit: input.unit.toLowerCase(),
          wholeOnly: input.kind === "whole",
          reorderLevelMilli: input.reorderLevel,
        })
        .returning({ id: stockItems.id });
      await tx.insert(stockBalances).values({ itemId: item!.id });
      await auditFrom(ctx, tx, {
        action: "stock.item_create",
        entityType: "stock_item",
        entityId: item!.id,
        after: { name: input.name, unit: input.unit },
      });
      return item!;
    });
  } catch (error) {
    rethrowConstraint(error, { stock_items_name_unique: fieldError("name", "This item already exists") });
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
      const [order] = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update");
      if (!order) throw new DomainError("Work order not found.");
      if (order.status !== "checked_in") throw new DomainError("Parts can only go to a tricycle in the workshop.");

      const { item, balance } = await lockStock(tx, input.itemId);
      requireWhole(item, input.quantity);
      if (input.quantity > balance.quantityMilli) {
        throw fieldError("quantity", `Only ${formatQuantity(balance.quantityMilli)} left in the store`);
      }
      const costKobo =
        input.quantity === balance.quantityMilli
          ? balance.valueKobo
          : mulDiv(balance.valueKobo, input.quantity, balance.quantityMilli);
      await move(tx, ctx, {
        itemId: item.id,
        kind: "issued",
        quantityMilli: -input.quantity,
        costKobo: -costKobo,
        workOrderId,
        tricycleId: order.tricycleId,
      });
      await auditFrom(ctx, tx, {
        action: "stock.issue",
        entityType: "tricycle",
        entityId: order.tricycleId,
        after: { item: item.name, quantity: input.quantity, costKobo, workOrderId },
      });
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "stock_never_negative") {
      throw fieldError("quantity", "There is not enough left in the store");
    }
    throw error;
  }
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
