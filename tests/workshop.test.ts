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
  openJobsForParts,
  setReorderLevel,
  takeOutItems,
  updateStockItem,
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
  fleetWorkshopReport,
  tricycleWorkshopReport,
} from "@/services/workshop";
import { readReportPeriod } from "@/lib/report-period";
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
const itemName = async (itemId: string) => (await db.select().from(stockItems).where(eq(stockItems.id, itemId)))[0]!.name;
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
      issueTricycle(on(manager, MON), { tricycleId: tricycle.id, operatorId: operator.id, issuedOn: MON }),
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

describe("adding and editing store items", () => {
  const name = () => `Item ${nextSerial()}`;

  it("adds an item with the stock already on the shelf at its cost", async () => {
    const item = (await createStockItem(manager, { name: name(), unit: "Litre", kind: "part", reorderLevel: "2", quantity: "12.5", unitCost: "4,650" }))!;
    expect(await stock(item.id)).toMatchObject({ quantityMilli: 12_500, valueKobo: 5_812_500 });
    const [row] = await db.select().from(stockItems).where(eq(stockItems.id, item.id));
    expect(row).toMatchObject({ unit: "litre", wholeOnly: false, reorderLevelMilli: 2000 });
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.itemId, item.id));
    expect(moves).toEqual([expect.objectContaining({ kind: "received", quantityMilli: 12_500, costKobo: 5_812_500 })]);
  });

  it("adds an item with nothing in the store when quantity is left empty", async () => {
    const item = (await createStockItem(manager, { name: name(), unit: "piece", kind: "whole", reorderLevel: "0", quantity: "", unitCost: "" }))!;
    expect(await stock(item.id)).toMatchObject({ quantityMilli: 0, valueKobo: 0 });
  });

  it("asks for the cost when stock is entered, and refuses part of a whole item", async () => {
    await expect(createStockItem(manager, { name: name(), unit: "tyre", kind: "whole", reorderLevel: "0", quantity: "4" })).rejects.toMatchObject({
      fieldErrors: { unitCost: "Enter the cost per tyre" },
    });
    await expect(
      createStockItem(manager, { name: name(), unit: "tyre", kind: "whole", reorderLevel: "0", quantity: "1.5", unitCost: "28,000" }),
    ).rejects.toMatchObject({ fieldErrors: { quantity: "Enter whole tyres" } });
  });

  it("edits the name, unit, counting and alert, leaving stock and value alone", async () => {
    const item = await newItem("whole", "piece");
    await receiveStock(manager, item.id, { quantity: "3", unitCost: "1,000" });
    const newName = name();
    await updateStockItem(assistant, item.id, { name: newName, unit: "Pack", kind: "part", reorderLevel: "1.5" });
    const [row] = await db.select().from(stockItems).where(eq(stockItems.id, item.id));
    expect(row).toMatchObject({ name: newName, unit: "pack", wholeOnly: false, reorderLevelMilli: 1500 });
    expect(await stock(item.id)).toMatchObject({ quantityMilli: 3000, valueKobo: 300_000 });
  });

  it("refuses whole units while part of a unit is in the store, and a name already used", async () => {
    const oil = await newItem("part", "litre");
    await receiveStock(manager, oil.id, { quantity: "2.5", unitCost: "4,000" });
    const [row] = await db.select().from(stockItems).where(eq(stockItems.id, oil.id));
    await expect(updateStockItem(manager, oil.id, { name: row!.name, unit: "litre", kind: "whole", reorderLevel: "0" })).rejects.toMatchObject({
      fieldErrors: { kind: expect.stringMatching(/2\.5 litres/) },
    });
    const other = await newItem();
    const [taken] = await db.select().from(stockItems).where(eq(stockItems.id, other.id));
    await expect(updateStockItem(manager, oil.id, { name: taken!.name, unit: "litre", kind: "part", reorderLevel: "0" })).rejects.toMatchObject({
      fieldErrors: { name: "Another item already has this name" },
    });
  });

  it("is for office staff only", async () => {
    const item = await newItem();
    await expect(updateStockItem(supervisor, item.id, { name: name(), unit: "tyre", kind: "whole", reorderLevel: "0" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("taking several items out of the store at once", () => {
  const open = async () => {
    const { tricycle } = await held();
    return { tricycle, order: await repair(tricycle.id) };
  };
  const stocked = async () => {
    const oil = await newItem("part", "litre");
    const tyre = await newItem();
    await receiveStock(manager, oil.id, { quantity: "10", unitCost: "4,000" });
    await receiveStock(manager, tyre.id, { quantity: "2", unitCost: "28,000" });
    return { oil, tyre };
  };
  const issuedOn = (workOrderId: string) =>
    db.select().from(stockMovements).where(and(eq(stockMovements.workOrderId, workOrderId), eq(stockMovements.kind, "issued")));

  it("takes every item out to the job in one save", async () => {
    const { oil, tyre } = await stocked();
    const { order, tricycle } = await open();
    const result = await takeOutItems(assistant, {
      workOrderId: order.id,
      [`qty.${oil.id}`]: "1.5",
      [`qty.${tyre.id}`]: "1",
      "qty.not-an-item": "4",
    });
    expect(result).toEqual({ workOrderId: order.id, count: 2 });
    expect(await stock(oil.id)).toMatchObject({ quantityMilli: 8500, valueKobo: 3_400_000 });
    expect(await stock(tyre.id)).toMatchObject({ quantityMilli: 1000, valueKobo: 2_800_000 });
    const moved = await issuedOn(order.id);
    expect(moved).toHaveLength(2);
    expect(moved.every((m) => m.tricycleId === tricycle.id)).toBe(true);
    expect((await getWorkOrder(manager, order.id))!.partsCostKobo).toBe(600_000 + 2_800_000);
  });

  it("skips empty quantities and refuses a save with none", async () => {
    const { oil, tyre } = await stocked();
    const { order } = await open();
    await takeOutItems(manager, { workOrderId: order.id, [`qty.${oil.id}`]: "", [`qty.${tyre.id}`]: "1" });
    expect(await issuedOn(order.id)).toHaveLength(1);
    await expect(takeOutItems(manager, { workOrderId: order.id, [`qty.${oil.id}`]: " " })).rejects.toThrow(/at least one item/);
    await expect(takeOutItems(manager, { [`qty.${oil.id}`]: "1" })).rejects.toMatchObject({
      fieldErrors: { workOrderId: expect.any(String) },
    });
  });

  it("takes nothing out when one item is more than what is left, naming it", async () => {
    const { oil, tyre } = await stocked();
    const { order } = await open();
    await expect(
      takeOutItems(manager, { workOrderId: order.id, [`qty.${oil.id}`]: "1", [`qty.${tyre.id}`]: "3" }),
    ).rejects.toMatchObject({ fieldErrors: { [`qty.${tyre.id}`]: expect.stringMatching(/Only 2 tyres of item .* left/) } });
    expect(await stock(oil.id)).toMatchObject({ quantityMilli: 10_000 });
    expect(await issuedOn(order.id)).toHaveLength(0);
  });

  it("refuses part of a whole item and words that are not numbers", async () => {
    const { oil, tyre } = await stocked();
    const { order } = await open();
    await expect(takeOutItems(manager, { workOrderId: order.id, [`qty.${tyre.id}`]: "1.5" })).rejects.toMatchObject({
      fieldErrors: { [`qty.${tyre.id}`]: "Enter whole tyres" },
    });
    await expect(takeOutItems(manager, { workOrderId: order.id, [`qty.${oil.id}`]: "two" })).rejects.toMatchObject({
      fieldErrors: { [`qty.${oil.id}`]: "Enter a number" },
    });
  });

  it("goes only to a tricycle in the workshop, and only for office staff", async () => {
    const { oil } = await stocked();
    const { order } = await open();
    await finish(order.id, TUE);
    await expect(takeOutItems(manager, { workOrderId: order.id, [`qty.${oil.id}`]: "1" })).rejects.toThrow(/workshop/);
    await expect(takeOutItems(supervisor, { workOrderId: order.id, [`qty.${oil.id}`]: "1" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await openJobsForParts(manager)).some((j) => j.id === order.id)).toBe(false);
  });

  it("lists tricycles in the workshop to choose from", async () => {
    const { order, tricycle } = await open();
    const [row] = await db.select({ code: tricycles.codeNumber }).from(tricycles).where(eq(tricycles.id, tricycle.id));
    const jobs = await openJobsForParts(manager);
    expect(jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: order.id, code: row!.code, type: "maintenance" })]));
  });

  it("lets one item from a several-item save be returned on its own", async () => {
    const { oil, tyre } = await stocked();
    const { order } = await open();
    await takeOutItems(manager, { workOrderId: order.id, [`qty.${oil.id}`]: "2", [`qty.${tyre.id}`]: "1" });
    const tyreOut = (await issuedOn(order.id)).find((m) => m.itemId === tyre.id)!;
    await returnPart(manager, tyreOut.id);
    expect(await stock(tyre.id)).toMatchObject({ quantityMilli: 2000 });
    expect(await stock(oil.id)).toMatchObject({ quantityMilli: 8000 });
  });
});

describe("the workshop report for one tricycle", () => {
  async function history() {
    const { tricycle, operator } = await held(MON);
    const oil = await newItem("part", "litre");
    const tyre = await newItem();
    await receiveStock(manager, oil.id, { quantity: "10", unitCost: "4,000" });
    await receiveStock(manager, tyre.id, { quantity: "2", unitCost: "28,000" });

    await job(MON);
    const serviced = await service(tricycle.id, MON);
    await checkInService(on(supervisor, MON, "09:00"), serviced.id);
    await takeOutItems(on(manager, MON), { workOrderId: serviced.id, [`qty.${oil.id}`]: "1.5" });
    await finish(serviced.id, MON);

    const repaired = await repair(tricycle.id, TUE);
    await takeOutItems(on(manager, TUE), { workOrderId: repaired.id, [`qty.${tyre.id}`]: "1", [`qty.${oil.id}`]: "1" });
    const oilOut = (
      await db.select().from(stockMovements).where(and(eq(stockMovements.workOrderId, repaired.id), eq(stockMovements.itemId, oil.id)))
    )[0]!;
    await returnPart(on(manager, TUE), oilOut.id);
    await finish(repaired.id, THU);
    return { tricycle, operator, oil, tyre, serviced, repaired };
  }

  it("sums up cost, parts, services, repairs and days off the road", async () => {
    const { tricycle, operator, oil, tyre, repaired } = await history();
    const report = (await tricycleWorkshopReport(on(manager, THU), tricycle.id, { from: "2026-11-01", to: THU }))!;
    expect(report.summary).toMatchObject({
      servicesDone: 1,
      servicesMissed: 0,
      repairs: 1,
      offRoadDays: 2,
      partsKobo: 600_000 + 2_800_000,
      labourKobo: 1_000_000,
      totalKobo: 4_400_000,
      lastService: MON,
      inWorkshop: false,
    });
    expect(report.partsByItem).toEqual([
      expect.objectContaining({ itemName: (await itemName(tyre.id)), quantityMilli: 1000, costKobo: 2_800_000 }),
      expect.objectContaining({ itemName: (await itemName(oil.id)), quantityMilli: 1500, costKobo: 600_000 }),
    ]);
    const [newest, oldest] = report.jobs;
    expect(newest).toMatchObject({ id: repaired.id, type: "maintenance", date: TUE, offRoadDays: 2, holder: { id: operator.id } });
    expect(newest!.parts).toHaveLength(1);
    expect(oldest).toMatchObject({ type: "service", date: MON, holder: null, partsKobo: 600_000 });
  });

  it("covers only the chosen period", async () => {
    const { tricycle } = await history();
    const report = (await tricycleWorkshopReport(on(manager, THU), tricycle.id, { from: WED, to: THU }))!;
    expect(report.jobs).toHaveLength(0);
    expect(report.summary).toMatchObject({ repairs: 0, offRoadDays: 0, totalKobo: 0, lastService: MON });
  });

  it("shows the Supervisor no money", async () => {
    const { tricycle } = await history();
    const report = (await tricycleWorkshopReport(on(supervisor, THU), tricycle.id, { to: THU }))!;
    expect(report.showCost).toBe(false);
    expect(report.summary).toMatchObject({ totalKobo: 0, partsKobo: 0, labourKobo: 0, repairs: 1 });
    expect(report.jobs.flatMap((j) => j.parts).every((p) => p.costKobo === 0)).toBe(true);
  });

  it("counts a repair still open up to today", async () => {
    const { tricycle } = await held(MON);
    const order = await repair(tricycle.id, MON);
    const report = (await tricycleWorkshopReport(on(manager, THU), tricycle.id, { to: THU }))!;
    expect(report.jobs[0]).toMatchObject({ id: order.id, status: "checked_in", offRoadDays: 3 });
    expect(report.summary.inWorkshop).toBe(true);
  });

  it("returns nothing for an unknown tricycle", async () => {
    expect(await tricycleWorkshopReport(manager, randomUUID(), { to: THU })).toBeNull();
  });
});

describe("the workshop report for all tricycles", () => {
  // Far from other tests' dates, so the period holds only this test's work.
  const D1 = "2031-03-03";
  const D2 = "2031-03-05";
  const D3 = "2031-03-08";
  const period = { from: "2031-03-01", to: "2031-03-31" };

  async function fleet() {
    const busy = (await held()).tricycle;
    const quiet = (await held()).tricycle;
    const tyre = await newItem();
    await receiveStock(manager, tyre.id, { quantity: "3", unitCost: "28,000" });
    const first = await repair(busy.id, D1);
    await takeOutItems(on(manager, D1), { workOrderId: first.id, [`qty.${tyre.id}`]: "2" });
    await finish(first.id, D2);
    const second = await repair(busy.id, D3);
    await finish(second.id, D3, "1,000");
    const other = await repair(quiet.id, D2);
    await finish(other.id, D3, "2,000");
    return { busy, quiet };
  }

  it("ranks tricycles by cost, with fleet totals and the most repairs marked", async () => {
    const { busy, quiet } = await fleet();
    const report = await fleetWorkshopReport(on(manager, "2031-03-31"), period);
    const mine = report.rows.filter((row) => row.tricycleId === busy.id || row.tricycleId === quiet.id);
    expect(mine.map((row) => row.tricycleId)).toEqual([busy.id, quiet.id]);
    expect(mine[0]).toMatchObject({ repairs: 2, mostRepairs: true, offRoadDays: 2, partsKobo: 5_600_000, labourKobo: 600_000, totalKobo: 6_200_000 });
    expect(mine[1]).toMatchObject({ repairs: 1, offRoadDays: 3, partsKobo: 0, labourKobo: 200_000, mostRepairs: false });
    expect(report.totals.totalKobo).toBe(report.rows.reduce((sum, row) => sum + row.totalKobo, 0));
    expect(report.totals.repairs).toBeGreaterThanOrEqual(3);
    const top = Math.max(...report.rows.map((row) => row.repairs));
    expect(report.rows.filter((row) => row.mostRepairs).every((row) => row.repairs === top)).toBe(true);
  });

  it("lists tricycles with no work, and keeps out work from other periods", async () => {
    const { busy } = await fleet();
    const april = await fleetWorkshopReport(on(manager, "2031-04-30"), { from: "2031-04-01", to: "2031-04-30" });
    expect(april.rows.find((row) => row.tricycleId === busy.id)).toMatchObject({ repairs: 0, totalKobo: 0, mostRepairs: false });
  });

  it("shows the Supervisor no money", async () => {
    await fleet();
    const report = await fleetWorkshopReport(on(supervisor, "2031-03-31"), period);
    expect(report.showCost).toBe(false);
    expect(report.totals).toMatchObject({ totalKobo: 0, partsKobo: 0, labourKobo: 0 });
    expect(report.totals.repairs).toBeGreaterThan(0);
  });
});

describe("report periods", () => {
  const today = "2026-11-13";
  it("defaults to this month", () => {
    expect(readReportPeriod({}, today)).toMatchObject({ key: "month", from: "2026-11-01", to: today });
    expect(readReportPeriod({ period: "nonsense" }, today).key).toBe("month");
  });
  it("reads the set periods", () => {
    expect(readReportPeriod({ period: "3m" }, today)).toMatchObject({ from: "2026-08-14", to: today });
    expect(readReportPeriod({ period: "year" }, today)).toMatchObject({ from: "2026-01-01", to: today });
    expect(readReportPeriod({ period: "all" }, today)).toEqual(expect.objectContaining({ key: "all", to: today }));
  });
  it("takes chosen dates, never past today", () => {
    expect(readReportPeriod({ from: "2026-10-01", to: "2026-10-31" }, today)).toMatchObject({ key: "custom", from: "2026-10-01", to: "2026-10-31" });
    expect(readReportPeriod({ from: "2026-10-01", to: "2027-01-01" }, today).to).toBe(today);
    expect(readReportPeriod({ from: "2026-12-01", to: "2026-10-01" }, today).from).toBeUndefined();
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
