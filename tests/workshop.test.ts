import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  charges,
  jobRuns,
  offRoadPeriods,
  stockBalances,
  stockItems,
  stockMovements,
  tricycles,
  violations,
  workOrders,
} from "@/db/schema";
import { addDays } from "@/lib/clock";
import { DomainError, ForbiddenError } from "@/lib/errors";
import { nextServiceDate, serviceDatesBetween } from "@/lib/service-cycle";
import { issueTricycle, returnTricycle } from "@/services/assignments";
import { assignments } from "@/db/schema";
import type { Ctx } from "@/services/context";
import { runDailyJob } from "@/services/daily-job";
import {
  adjustStock,
  createStockItem,
  issuePart,
  listStock,
  listStockUsage,
  lowStock,
  receiveStock,
  returnPart,
  setReorderLevel,
} from "@/services/store";
import {
  cancelWorkOrder,
  checkInService,
  completeWorkOrder,
  getMyService,
  getWorkOrder,
  listWorkHistory,
  listWorkshop,
  reportFault,
  rescheduleService,
  tricycleWorkHistory,
} from "@/services/workshop";
import { makeOperator, makeTricycle, makeUser, nextSerial } from "./helpers";

let manager: Ctx;
let assistant: Ctx;
let supervisor: Ctx;
let owner: Ctx;

beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  assistant = (await makeUser("assistant_manager")).ctx;
  supervisor = (await makeUser("supervisor")).ctx;
  owner = (await makeUser("owner")).ctx;
});

const MON = "2026-11-16";
const TUE = "2026-11-17";
const WED = "2026-11-18";
const THU = "2026-11-19";

const wat = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`);
const on = (ctx: Ctx, date: string, time = "09:00"): Ctx => ({ ...ctx, clock: () => wat(date, time) });

/** Runs the job for exactly these dates, as it does just after midnight. */
async function job(from: string, to = from) {
  await db.delete(jobRuns);
  await db.insert(jobRuns).values({ job: "daily", businessDate: addDays(from, -1), finishedAt: new Date() });
  return runDailyJob(() => wat(to, "00:05"));
}

async function held(serviceCycleStart = "2026-02-01", serviceInterval = "fortnightly") {
  const tricycle = await makeTricycle(manager, { serviceCycleStart, serviceInterval });
  const operator = await makeOperator(manager);
  await issueTricycle(manager, {
    tricycleId: tricycle.id,
    operatorId: operator.id,
    issuedOn: "2026-11-01",
    dailyBalance: "10,000",
  });
  return { tricycle, operator };
}

const statusOf = async (id: string) =>
  (await db.select({ s: tricycles.status }).from(tricycles).where(eq(tricycles.id, id)))[0]!.s;
const balanceDays = async (operatorId: string) =>
  (await db.select().from(charges).where(and(eq(charges.operatorId, operatorId), eq(charges.type, "daily_balance"))))
    .map((c) => c.businessDate)
    .sort();
const offences = (operatorId: string) =>
  db.select().from(violations).where(and(eq(violations.operatorId, operatorId), eq(violations.ruleCode, "R3")));
const service = async (tricycleId: string, cycleDate: string) =>
  (await db.select().from(workOrders).where(and(eq(workOrders.tricycleId, tricycleId), eq(workOrders.cycleDate, cycleDate))))[0]!;
const repair = (tricycleId: string, date = MON) =>
  reportFault(on(manager, date), { tricycleId, fault: "Will not start" }).then((o) => o!);
const finish = (id: string, date: string, labourCost = "5,000") =>
  completeWorkOrder(on(manager, date), id, { findings: "Replaced worn parts", labourCost });
const newItem = (kind = "whole", unit = "tyre") =>
  createStockItem(manager, { name: `Item ${nextSerial()}`, unit, kind, reorderLevel: "0" }).then((i) => i!);
const stock = async (itemId: string) => (await db.select().from(stockBalances).where(eq(stockBalances.itemId, itemId)))[0]!;

describe("the fixed service cycle", () => {
  it("repeats every 14 days", () => {
    expect(serviceDatesBetween("2026-11-02", "fortnightly", "2026-11-02", "2026-11-30")).toEqual([
      "2026-11-02",
      "2026-11-16",
      "2026-11-30",
    ]);
  });

  it("keeps the same day each month, and a short month does not shift later dates", () => {
    expect(serviceDatesBetween("2026-01-31", "monthly", "2026-02-01", "2026-04-30")).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("finds the next date on or after a day", () => {
    expect(nextServiceDate("2026-11-02", "fortnightly", "2026-11-03")).toBe("2026-11-16");
    expect(nextServiceDate("2026-11-02", "fortnightly", "2026-11-16")).toBe("2026-11-16");
  });

  it("plans a service once however often the job runs", async () => {
    const { tricycle } = await held(MON);
    await job(MON);
    await job(MON);
    const rows = await db.select().from(workOrders).where(eq(workOrders.tricycleId, tricycle.id));
    expect(rows.filter((r) => r.cycleDate === MON)).toHaveLength(1);
  });

  it("is not moved by a late service or a rescheduled one", async () => {
    const { tricycle } = await held(MON);
    await job(MON);
    const first = await service(tricycle.id, MON);
    await rescheduleService(on(manager, MON), first.id, { scheduledFor: WED, reason: "Workshop full" });
    await checkInService(on(supervisor, WED, "15:00"), first.id);
    await job(addDays(MON, 14));
    expect((await service(tricycle.id, addDays(MON, 14))).scheduledFor).toBe(addDays(MON, 14));
    expect((await service(tricycle.id, MON)).cycleDate).toBe(MON);
  });

  it("drops planned services when the cycle is changed", async () => {
    const { tricycle } = await held(MON);
    await job(MON);
    const { updateTricycle } = await import("@/services/tricycles");
    const [row] = await db.select().from(tricycles).where(eq(tricycles.id, tricycle.id));
    await updateTricycle(on(manager, MON), tricycle.id, {
      registrationNumber: row!.registrationNumber,
      codeNumber: row!.codeNumber,
      purchasedOn: row!.purchasedOn,
      serviceInterval: "monthly",
      serviceCycleStart: TUE,
    });
    expect(await db.select().from(workOrders).where(eq(workOrders.tricycleId, tricycle.id))).toHaveLength(0);
  });
});

describe("R3 late for service", () => {
  async function due() {
    const { tricycle, operator } = await held(MON);
    await job(MON);
    return { tricycle, operator, order: await service(tricycle.id, MON) };
  }

  it.each(["08:00", "09:59", "10:00"])("is on time at %s", async (time) => {
    const { operator, order } = await due();
    await checkInService(on(supervisor, MON, time), order.id);
    expect(await offences(operator.id)).toHaveLength(0);
  });

  it("proposes ₦3,000 at 10:01, dated to the service day", async () => {
    const { operator, order } = await due();
    await checkInService(on(supervisor, MON, "10:01"), order.id);
    expect(await offences(operator.id)).toMatchObject([{ amountKobo: 300_000, status: "proposed", occurredOn: MON }]);
  });

  it("is late if they come on a later day, even early in the morning", async () => {
    const { operator, order } = await due();
    await checkInService(on(supervisor, TUE, "08:30"), order.id);
    expect(await offences(operator.id)).toHaveLength(1);
  });

  it("is raised once for not coming, and not again when they come late", async () => {
    const { operator, order } = await due();
    await job(TUE);
    const rows = await offences(operator.id);
    expect(rows).toMatchObject([{ status: "proposed", raisedBy: null }]);
    expect((await service(order.tricycleId, MON)).status).toBe("missed");
    await checkInService(on(supervisor, WED), order.id);
    expect(await offences(operator.id)).toHaveLength(1);
  });

  it("is not raised twice if the job runs twice", async () => {
    const { operator } = await due();
    await job(TUE);
    await job(TUE);
    expect(await offences(operator.id)).toHaveLength(1);
  });

  it("uses the new date after a reschedule", async () => {
    const { operator, order } = await due();
    await rescheduleService(on(manager, MON), order.id, { scheduledFor: WED, reason: "Workshop full" });
    await job(TUE);
    await checkInService(on(supervisor, WED, "09:00"), order.id);
    expect(await offences(operator.id)).toHaveLength(0);
  });

  it("exempts a tricycle in the workshop on the service day", async () => {
    const { tricycle, operator, order } = await due();
    await repair(tricycle.id, MON);
    await job(TUE);
    expect(await offences(operator.id)).toHaveLength(0);
    await checkInService(on(supervisor, WED), order.id);
    expect(await offences(operator.id)).toHaveLength(0);
  });

  it("does not fine anyone when nobody held the tricycle", async () => {
    const tricycle = await makeTricycle(manager, { serviceCycleStart: MON });
    const [order] = await db
      .insert(workOrders)
      .values({ type: "service", status: "scheduled", tricycleId: tricycle.id, cycleDate: MON, scheduledFor: MON, createdAt: new Date() })
      .returning();
    await expect(checkInService(on(supervisor, TUE), order!.id)).resolves.toEqual({ late: false });
  });

  it("cannot be checked in twice", async () => {
    const { order } = await due();
    await checkInService(on(supervisor, MON), order.id);
    await expect(checkInService(on(supervisor, MON), order.id)).rejects.toThrow(/already/);
  });

  it("does not stop the balance on a service day", async () => {
    const { operator, order } = await due();
    await checkInService(on(supervisor, MON), order.id);
    await job(TUE);
    expect(await balanceDays(operator.id)).toContain(TUE);
  });
});

describe("repairs and the balance", () => {
  it("meets the Phase 4 exit: parts, stock, balance and cost", async () => {
    const { tricycle, operator } = await held();
    const item = await newItem();
    await receiveStock(on(manager, MON), item.id, { quantity: "4", unitCost: "20,000" });

    await job(MON);
    const order = await repair(tricycle.id);
    expect(await statusOf(tricycle.id)).toBe("off_road");

    await issuePart(on(assistant, MON, "11:00"), order.id, { itemId: item.id, quantity: "2" });
    expect(await stock(item.id)).toMatchObject({ quantityMilli: 2000, valueKobo: 4_000_000 });

    await job(TUE);
    await finish(order.id, WED);
    await job(WED);
    expect(await statusOf(tricycle.id)).toBe("issued");
    await job(THU);

    const days = (await balanceDays(operator.id)).filter((d) => d >= MON);
    expect(days).toEqual([MON, THU]);

    const history = await tricycleWorkHistory(on(manager, THU), tricycle.id);
    expect(history).toMatchObject({ partsKobo: 4_000_000, labourKobo: 500_000 });
    expect(history.orders.find((o) => o.id === order.id)!.parts).toHaveLength(1);
  });

  it("charges as normal for a repair finished the same day", async () => {
    const { tricycle, operator } = await held();
    const order = await repair(tricycle.id, MON);
    await finish(order.id, MON);
    await job(TUE);
    expect(await balanceDays(operator.id)).toContain(TUE);
  });

  it("gets a skipped night right after the tricycle is back on the road", async () => {
    const { tricycle, operator } = await held();
    const order = await repair(tricycle.id, MON);
    await finish(order.id, WED);
    await job(TUE, THU);
    const days = (await balanceDays(operator.id)).filter((d) => d >= TUE);
    expect(days).toEqual([THU]);
  });

  it("refuses a second repair while one is open", async () => {
    const { tricycle } = await held();
    await repair(tricycle.id);
    await expect(repair(tricycle.id)).rejects.toBeInstanceOf(DomainError);
  });

  it("cannot be issued while in the workshop", async () => {
    const tricycle = await makeTricycle(manager);
    await repair(tricycle.id);
    const operator = await makeOperator(manager);
    await expect(
      issueTricycle(on(manager, MON), { tricycleId: tricycle.id, operatorId: operator.id, issuedOn: MON, dailyBalance: "10,000" }),
    ).rejects.toThrow(/off the road/);
  });

  it("returns a spare tricycle to stock when repaired", async () => {
    const tricycle = await makeTricycle(manager);
    const order = await repair(tricycle.id);
    await finish(order.id, TUE);
    expect(await statusOf(tricycle.id)).toBe("in_stock");
  });

  it("stays off-road if the operator returns it mid-repair", async () => {
    const { tricycle } = await held();
    const order = await repair(tricycle.id);
    const [assignment] = await db.select().from(assignments).where(eq(assignments.tricycleId, tricycle.id));
    await returnTricycle(on(manager, TUE), assignment!.id, { returnedOn: TUE, reason: "reassigned" });
    expect(await statusOf(tricycle.id)).toBe("off_road");
    await finish(order.id, WED);
    expect(await statusOf(tricycle.id)).toBe("in_stock");
  });

  it("needs findings to complete, and completes once", async () => {
    const { tricycle } = await held();
    const order = await repair(tricycle.id);
    await expect(completeWorkOrder(on(manager, TUE), order.id, { findings: " " })).rejects.toBeInstanceOf(DomainError);
    await finish(order.id, TUE);
    await expect(finish(order.id, WED)).rejects.toThrow(/workshop/);
  });

  it("puts a tricycle back on the road when a repair is cancelled", async () => {
    const { tricycle } = await held();
    const order = await repair(tricycle.id);
    await cancelWorkOrder(on(manager, MON), order.id, { reason: "Wrong tricycle" });
    expect(await statusOf(tricycle.id)).toBe("issued");
  });

  it("will not cancel while parts are on it", async () => {
    const { tricycle } = await held();
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "1", unitCost: "1,000" });
    const order = await repair(tricycle.id);
    await issuePart(manager, order.id, { itemId: item.id, quantity: "1" });
    await expect(cancelWorkOrder(manager, order.id, { reason: "x" })).rejects.toThrow(/Return the parts/);
  });

  it("lets a Supervisor check in but nothing else", async () => {
    const { tricycle } = await held();
    await expect(repair(tricycle.id).then((o) => o)).resolves.toBeDefined();
    const other = await held();
    await expect(reportFault(on(supervisor, MON), { tricycleId: other.tricycle.id, fault: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(checkInService(owner, randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides costs from a Supervisor", async () => {
    const { tricycle } = await held();
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "1", unitCost: "1,000" });
    const order = await repair(tricycle.id);
    await issuePart(manager, order.id, { itemId: item.id, quantity: "1" });
    await finish(order.id, TUE);
    const history = await tricycleWorkHistory(on(supervisor, WED), tricycle.id);
    expect(history).toMatchObject({ showCost: false, partsKobo: 0, labourKobo: 0 });
    expect((await getWorkOrder(on(supervisor, WED), order.id))!.order.labourCostKobo).toBe(0);
  });

  it("gives an operator their next service and no costs", async () => {
    const { tricycle, operator } = await held(MON);
    const portal: Ctx = { actor: { userId: randomUUID(), name: "Op", role: "operator", operatorId: operator.id }, clock: () => wat(TUE, "09:00") };
    const order = await repair(tricycle.id, MON);
    await finish(order.id, TUE);
    const mine = await getMyService(portal);
    expect(mine.nextService).toBe(addDays(MON, 14));
    expect(mine.history).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toMatch(/kobo/i);
  });

  it("keeps one off-road period per repair", async () => {
    const { tricycle } = await held();
    const order = await repair(tricycle.id, MON);
    await finish(order.id, WED);
    expect(await db.select().from(offRoadPeriods).where(eq(offRoadPeriods.workOrderId, order.id))).toMatchObject([
      { startsOn: MON, endsOn: WED },
    ]);
  });
});

describe("the store", () => {
  const open = async () => {
    const { tricycle } = await held();
    return { tricycle, order: await repair(tricycle.id) };
  };

  it("values stock at average cost and empties to exactly zero", async () => {
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "1", unitCost: "10,000" });
    await receiveStock(manager, item.id, { quantity: "2", unitCost: "10,001" });
    const { order } = await open();
    await issuePart(manager, order.id, { itemId: item.id, quantity: "1" });
    await issuePart(manager, order.id, { itemId: item.id, quantity: "2" });
    expect(await stock(item.id)).toEqual(expect.objectContaining({ quantityMilli: 0, valueKobo: 0 }));
    const detail = await getWorkOrder(manager, order.id);
    expect(detail!.partsCostKobo).toBe(3_000_200);
  });

  it("lets only one person take the last tyre", async () => {
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "1", unitCost: "20,000" });
    const a = await open();
    const b = await open();
    const results = await Promise.allSettled([
      issuePart(manager, a.order.id, { itemId: item.id, quantity: "1" }),
      issuePart(assistant, b.order.id, { itemId: item.id, quantity: "1" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await stock(item.id)).toMatchObject({ quantityMilli: 0 });
  });

  it("refuses more than is in the store", async () => {
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "1", unitCost: "1,000" });
    const { order } = await open();
    await expect(issuePart(manager, order.id, { itemId: item.id, quantity: "2" })).rejects.toBeInstanceOf(DomainError);
  });

  it("has the database refuse a negative balance", async () => {
    const item = await newItem();
    await expect(db.update(stockBalances).set({ quantityMilli: -1 }).where(eq(stockBalances.itemId, item.id))).rejects.toThrow();
  });

  it("issues only to a tricycle in the workshop", async () => {
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "2", unitCost: "1,000" });
    const { order } = await open();
    await finish(order.id, TUE);
    await expect(issuePart(manager, order.id, { itemId: item.id, quantity: "1" })).rejects.toThrow(/workshop/);
  });

  it("allows part quantities only where the item does", async () => {
    const oil = await newItem("part", "litre");
    const tyre = await newItem();
    await receiveStock(manager, oil.id, { quantity: "5", unitCost: "4,000" });
    await receiveStock(manager, tyre.id, { quantity: "5", unitCost: "4,000" });
    const { order } = await open();
    await issuePart(manager, order.id, { itemId: oil.id, quantity: "1.25" });
    expect(await stock(oil.id)).toMatchObject({ quantityMilli: 3750, valueKobo: 1_500_000 });
    await expect(issuePart(manager, order.id, { itemId: tyre.id, quantity: "1.5" })).rejects.toBeInstanceOf(DomainError);
  });

  it("starts with engine oil, gear oil and tyres, and no engines", async () => {
    const names = (await db.select({ name: stockItems.name, unit: stockItems.unit, wholeOnly: stockItems.wholeOnly }).from(stockItems)).filter(
      (row) => !row.name.startsWith("Item "),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        { name: "Engine oil", unit: "litre", wholeOnly: false },
        { name: "Gear oil", unit: "litre", wholeOnly: false },
        { name: "Tyre", unit: "tyre", wholeOnly: true },
      ]),
    );
    expect(names.some((row) => row.name === "Engine")).toBe(false);
  });

  it("takes a part back once, at what it cost", async () => {
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "2", unitCost: "5,000" });
    const { order, tricycle } = await open();
    await issuePart(manager, order.id, { itemId: item.id, quantity: "1" });
    const [issued] = await db.select().from(stockMovements).where(and(eq(stockMovements.workOrderId, order.id), eq(stockMovements.kind, "issued")));
    await returnPart(manager, issued!.id);
    await expect(returnPart(manager, issued!.id)).rejects.toThrow(/already/);
    expect(await stock(item.id)).toMatchObject({ quantityMilli: 2000, valueKobo: 1_000_000 });
    expect((await tricycleWorkHistory(manager, tricycle.id)).partsKobo).toBe(0);
  });

  it("cannot change a movement after it is written", async () => {
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "1", unitCost: "1,000" });
    await expect(db.update(stockMovements).set({ reason: "x" }).where(eq(stockMovements.itemId, item.id))).rejects.toThrow();
    await expect(db.delete(stockMovements).where(eq(stockMovements.itemId, item.id))).rejects.toThrow();
  });

  it("lets only the Manager adjust after a count, with a reason", async () => {
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "4", unitCost: "1,000" });
    await expect(adjustStock(assistant, item.id, { counted: "3", reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adjustStock(manager, item.id, { counted: "3", reason: " " })).rejects.toBeInstanceOf(DomainError);
    await adjustStock(manager, item.id, { counted: "3", reason: "One missing" });
    expect(await stock(item.id)).toMatchObject({ quantityMilli: 3000, valueKobo: 300_000 });
    await expect(adjustStock(manager, item.id, { counted: "3", reason: "again" })).rejects.toBeInstanceOf(DomainError);
  });

  it("alerts at or below the reorder level", async () => {
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "3", unitCost: "1,000" });
    await setReorderLevel(manager, item.id, { reorderLevel: "2" });
    expect((await lowStock(manager)).some((r) => r.id === item.id)).toBe(false);
    await adjustStock(manager, item.id, { counted: "2", reason: "Count" });
    expect((await lowStock(manager)).some((r) => r.id === item.id)).toBe(true);
  });

  it("keeps the store from Supervisors and stock changes from the owner", async () => {
    await expect(listStock(supervisor)).rejects.toBeInstanceOf(ForbiddenError);
    const item = await newItem();
    await expect(receiveStock(owner, item.id, { quantity: "1", unitCost: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listStock(owner)).resolves.toBeDefined();
  });
});

describe("company-wide records", () => {
  it("records what was used, on which tricycle, when and by whom", async () => {
    const a = await held();
    const b = await held();
    const oil = await newItem("part", "litre");
    const tyre = await newItem();
    await receiveStock(manager, oil.id, { quantity: "10", unitCost: "5,000" });
    await receiveStock(manager, tyre.id, { quantity: "4", unitCost: "20,000" });
    const first = await repair(a.tricycle.id, MON);
    const second = await repair(b.tricycle.id, MON);
    await issuePart(on(manager, MON, "11:30"), first.id, { itemId: oil.id, quantity: "1.5" });
    await issuePart(on(assistant, WED, "14:00"), second.id, { itemId: tyre.id, quantity: "2" });

    const oilOnly = await listStockUsage(manager, { itemId: oil.id });
    expect(oilOnly.rows).toMatchObject([
      { tricycleCode: expect.any(String), tricycleId: a.tricycle.id, quantityMilli: -1500, costKobo: -750_000, issuedBy: manager.actor.name, workType: "maintenance" },
    ]);
    expect(oilOnly.rows[0]!.usedAt).toEqual(wat(MON, "11:30"));
    expect(oilOnly.totals).toMatchObject([{ quantityMilli: 1500, costKobo: 750_000 }]);

    expect((await listStockUsage(manager, { tricycleId: b.tricycle.id })).rows).toMatchObject([{ issuedBy: assistant.actor.name }]);
    expect((await listStockUsage(manager, { tricycleId: a.tricycle.id, from: TUE })).rows).toHaveLength(0);
    expect((await listStockUsage(manager, { tricycleId: b.tricycle.id, from: TUE, to: WED })).rows).toHaveLength(1);
  });

  it("leaves returned parts out of the usage record and totals", async () => {
    const { tricycle } = await held();
    const item = await newItem();
    await receiveStock(manager, item.id, { quantity: "2", unitCost: "5,000" });
    const order = await repair(tricycle.id);
    await issuePart(manager, order.id, { itemId: item.id, quantity: "1" });
    const [issued] = await db.select().from(stockMovements).where(and(eq(stockMovements.workOrderId, order.id), eq(stockMovements.kind, "issued")));
    await returnPart(manager, issued!.id);
    const usage = await listStockUsage(manager, { itemId: item.id });
    expect(usage.rows).toHaveLength(0);
    expect(usage.totals).toHaveLength(0);
  });

  it("keeps the usage record from Supervisors", async () => {
    await expect(listStockUsage(supervisor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listStockUsage(owner)).resolves.toBeDefined();
  });

  it("lists services and repairs by tricycle, type and date", async () => {
    const { tricycle } = await held(MON);
    await job(MON);
    const visit = await service(tricycle.id, MON);
    await checkInService(on(supervisor, MON), visit.id);
    await completeWorkOrder(on(manager, MON, "12:00"), visit.id, { findings: "Oil changed" });
    const fix = await repair(tricycle.id, WED);
    await finish(fix.id, THU);

    const all = await listWorkHistory(manager, { tricycleId: tricycle.id });
    expect(all.rows.map((r) => [r.type, r.date])).toEqual([
      ["maintenance", WED],
      ["service", MON],
    ]);
    expect(all.rows[1]).toMatchObject({ findings: "Oil changed", completedByName: manager.actor.name });
    expect((await listWorkHistory(manager, { tricycleId: tricycle.id, type: "service" })).rows).toHaveLength(1);
    expect((await listWorkHistory(manager, { tricycleId: tricycle.id, from: TUE, to: THU })).rows).toHaveLength(1);
  });

  it("shows missed services but not planned or cancelled ones", async () => {
    const { tricycle } = await held(MON);
    await job(MON);
    expect((await listWorkHistory(manager, { tricycleId: tricycle.id })).rows).toHaveLength(0);
    await job(TUE);
    expect((await listWorkHistory(manager, { tricycleId: tricycle.id })).rows).toMatchObject([{ status: "missed", date: MON }]);
  });

  it("hides costs from a Supervisor", async () => {
    const { tricycle } = await held();
    const order = await repair(tricycle.id);
    await finish(order.id, TUE);
    const history = await listWorkHistory(supervisor, { tricycleId: tricycle.id });
    expect(history).toMatchObject({ showCost: false });
    expect(history.rows[0]).toMatchObject({ labourKobo: 0, partsKobo: 0, fault: "Will not start" });
  });
});

describe("a tricycle that comes back with no operator", () => {
  const giveBack = async (tricycleId: string, date: string) => {
    const [open] = await db.select().from(assignments).where(eq(assignments.tricycleId, tricycleId));
    await returnTricycle(on(manager, date), open!.id, { returnedOn: date, reason: "other" });
  };

  it("drops its booked services", async () => {
    const { tricycle } = await held(WED);
    await job(MON);
    expect((await service(tricycle.id, WED)).status).toBe("scheduled");
    await giveBack(tricycle.id, MON);
    expect(await db.select().from(workOrders).where(eq(workOrders.tricycleId, tricycle.id))).toHaveLength(0);
  });

  it("stops chasing a missed service but keeps it in the history", async () => {
    const { tricycle } = await held(MON);
    await job(MON);
    await job(TUE);
    const overdue = async () => (await listWorkshop(on(manager, TUE))).overdue.map((row) => row.tricycleId);
    expect(await overdue()).toContain(tricycle.id);
    await giveBack(tricycle.id, TUE);
    expect(await overdue()).not.toContain(tricycle.id);
    expect((await listWorkHistory(manager, { tricycleId: tricycle.id })).rows).toMatchObject([{ status: "missed" }]);
  });
});
