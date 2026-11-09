/**
 * Fills the jayngol_sample database with 32 days of made-up records for 12
 * tricycles. Every record goes through the real services on a simulated clock,
 * so balances, fines, stock and cash follow the same rules as live use.
 *
 * Sample logins use the seed Manager's password:
 *   Owner 08000001900, Assistant Manager 08000001901, Supervisors 08000001902 and 08000001903.
 * Operator portal: 08000001001 with PIN 482615.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, pgClient } from "./index";
import { assignments, tricycles as tricycleTable, users, violations, workOrders } from "./schema";
import { addDays, businessDate } from "../lib/clock";
import { formatNaira } from "../lib/money";
import type { Role } from "../lib/permissions";
import { serviceDatesBetween } from "../lib/service-cycle";
import { issueTricycle } from "../services/assignments";
import type { Ctx } from "../services/context";
import { runDailyJob } from "../services/daily-job";
import {
  addExpenseLine,
  countersignAdvance,
  createAdvance,
  submitAdvance,
} from "../services/expenses";
import { cashDay, closeCash } from "../services/finance";
import { recordInspection } from "../services/inspections";
import {
  closeMeeting,
  getMeeting,
  recordAttendance,
  scheduleMeeting,
} from "../services/meetings";
import { grantLoan } from "../services/loans";
import { createOperator } from "../services/operators";
import { paymentContext, recordPayment } from "../services/payments";
import { issuePart, receiveStock, setReorderLevel } from "../services/store";
import { createTricycle } from "../services/tricycles";
import { createStaff, setOperatorPin } from "../services/users";
import { confirmViolation, raiseLateWork, rejectViolation } from "../services/violations";
import { checkInService, completeWorkOrder, reportFault } from "../services/workshop";

const SAMPLE_DATABASE = "jayngol_sample";
const OPERATOR_PIN = "482615";
const DAYS = 32;
const PHOTO =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

type Habit = "steady" | "sometimes" | "part" | "late" | "stops";
type Bike = { code: string; reg: string; rate: number; interval: "fortnightly" | "monthly"; firstService: number; name: string; habit: Habit };

const FLEET: Bike[] = [
  { code: "JT-001", reg: "GME 101 TX", rate: 12_000, interval: "fortnightly", firstService: 2, name: "Musa Abdullahi", habit: "steady" },
  { code: "JT-002", reg: "GME 102 TX", rate: 10_000, interval: "monthly", firstService: 5, name: "Ibrahim Sani", habit: "steady" },
  { code: "JT-003", reg: "GME 103 TX", rate: 12_000, interval: "fortnightly", firstService: 3, name: "Sadiq Bello", habit: "sometimes" },
  { code: "JT-004", reg: "GME 104 TX", rate: 15_000, interval: "fortnightly", firstService: 4, name: "Yakubu Danjuma", habit: "steady" },
  { code: "JT-005", reg: "GME 105 TX", rate: 12_000, interval: "monthly", firstService: 9, name: "Aliyu Umar", habit: "steady" },
  { code: "JT-006", reg: "GME 106 TX", rate: 10_000, interval: "fortnightly", firstService: 6, name: "Haruna Isa", habit: "part" },
  { code: "JT-007", reg: "GME 107 TX", rate: 12_000, interval: "fortnightly", firstService: 7, name: "Nasiru Lawal", habit: "sometimes" },
  { code: "JT-008", reg: "GME 108 TX", rate: 15_000, interval: "monthly", firstService: 11, name: "Tijjani Adamu", habit: "steady" },
  { code: "JT-009", reg: "GME 109 TX", rate: 10_000, interval: "fortnightly", firstService: 8, name: "Sani Garba", habit: "late" },
  { code: "JT-010", reg: "GME 110 TX", rate: 12_000, interval: "fortnightly", firstService: 10, name: "Bashir Ahmed", habit: "steady" },
  { code: "JT-011", reg: "GME 111 TX", rate: 15_000, interval: "monthly", firstService: 13, name: "Kabiru Yahaya", habit: "sometimes" },
  { code: "JT-012", reg: "GME 112 TX", rate: 12_000, interval: "fortnightly", firstService: 12, name: "Abubakar Tanko", habit: "stops" },
];

type Part = "engine" | "gear" | "tyre";
const REPAIRS: { bike: number; day: number; days: number | null; fault: string; parts: [Part, string][]; done: string; labour: string }[] = [
  { bike: 2, day: 7, days: 2, fault: "Rear tyre burst on the road", parts: [["tyre", "2"]], done: "Replaced both rear tyres and checked the rims", labour: "4,000" },
  { bike: 5, day: 11, days: 3, fault: "Engine oil leaking from the sump", parts: [["engine", "2"]], done: "Replaced the sump gasket and refilled the oil", labour: "12,000" },
  { bike: 8, day: 17, days: 1, fault: "Gear will not engage", parts: [["gear", "1.5"]], done: "Adjusted the linkage and changed the gear oil", labour: "6,500" },
  { bike: 1, day: 21, days: 2, fault: "Front tyre worn through", parts: [["tyre", "1"]], done: "Fitted a new front tyre", labour: "2,000" },
  { bike: 10, day: 25, days: 1, fault: "Engine running rough and smoking", parts: [["engine", "1.5"]], done: "Cleaned the carburettor and topped up the oil", labour: "8,000" },
  { bike: 6, day: 30, days: null, fault: "Engine overheats and cuts off", parts: [["engine", "1"]], done: "", labour: "" },
];

type Category = "store_purchase" | "workshop_labour" | "transport" | "office";
const ADVANCES: {
  day: number;
  purpose: string;
  amount: string;
  fromCash: boolean;
  spent: [Category, string, string][];
  change?: string;
  end: "countersigned" | "submitted" | "open";
}[] = [
  {
    day: 2,
    purpose: "Store stock for the month",
    amount: "460,000",
    fromCash: false,
    spent: [
      ["store_purchase", "Engine oil, 40 litres", "180,000"],
      ["store_purchase", "Gear oil, 10 litres", "52,000"],
      ["store_purchase", "Tyres, 8", "224,000"],
    ],
    change: "4,000",
    end: "countersigned",
  },
  {
    day: 10,
    purpose: "Workshop labour and towing",
    amount: "40,000",
    fromCash: true,
    spent: [
      ["workshop_labour", "Mechanic, repairs this fortnight", "26,500"],
      ["transport", "Towing a broken-down tricycle", "12,000"],
    ],
    change: "1,500",
    end: "countersigned",
  },
  {
    day: 20,
    purpose: "Engine oil restock",
    amount: "96,000",
    fromCash: false,
    spent: [["store_purchase", "Engine oil, 20 litres", "96,000"]],
    end: "submitted",
  },
  {
    day: 29,
    purpose: "Office supplies and transport",
    amount: "30,000",
    fromCash: true,
    spent: [["office", "Receipt books and printing", "8,000"]],
    end: "open",
  },
];

const LOANS = [
  { bike: 0, day: 5, amount: "50,000", repay: [[9, "5,000"], [14, "5,000"], [19, "5,000"], [24, "5,000"], [29, "5,000"]] },
  { bike: 3, day: 6, amount: "30,000", repay: [[10, "10,000"], [16, "10,000"], [22, "10,000"]] },
  { bike: 2, day: 22, amount: "20,000", repay: [] },
] as const;

const SERVICE_NOTES = [
  "Oil changed, brakes and chain checked",
  "Oil changed, tyre pressure and lights checked",
  "Full service, nothing further needed",
  "Oil changed, chain tightened",
];

// A fixed seed gives the same sample every time.
let seed = 20261;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (odds: number) => random() < odds;
const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!;
const between = (from: number, to: number) => from + Math.floor(random() * (to - from + 1));
const clockTime = (fromHour: number, toHour: number) =>
  `${String(between(fromHour, toHour)).padStart(2, "0")}:${String(between(0, 59)).padStart(2, "0")}`;
const naira = (kobo: number) => String(kobo / 100);

const realNow = new Date();
let current = realNow;
const clock = () => current;
/** Moves the simulated clock. Today's events never run ahead of the real time. */
function setTime(date: string, time: string) {
  const at = new Date(`${date}T${time}:00+01:00`);
  current = at > realNow ? realNow : at;
}

const ctxOf = (user: { id: string; name: string }, role: Exclude<Role, "operator">): Ctx => ({
  actor: { userId: user.id, name: user.name, role, operatorId: null },
  clock,
});

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Sample data is for development only.");
  const [{ name } = { name: "" }] = (await db.execute(sql`SELECT current_database() AS name`)) as unknown as { name: string }[];
  if (name !== SAMPLE_DATABASE) throw new Error(`Refusing to run on ${name}. Sample data only goes into ${SAMPLE_DATABASE}.`);
  const [existing] = await db.select({ id: tricycleTable.id }).from(tricycleTable).limit(1);
  if (existing) throw new Error(`${SAMPLE_DATABASE} already has data. Recreate it first.`);
  const password = process.env.SEED_MANAGER_PASSWORD;
  if (!password) throw new Error("Set SEED_MANAGER_PASSWORD.");

  const [managerUser] = await db.select().from(users).where(eq(users.role, "manager")).limit(1);
  if (!managerUser) throw new Error("Run npm run db:seed first.");
  const manager = ctxOf(managerUser, "manager");

  const today = businessDate(realNow);
  const start = addDays(today, -DAYS);
  const dayOf = (index: number) => addDays(start, index);
  setTime(start, "09:00");

  const staff = async (staffName: string, phone: string, role: "assistant_manager" | "supervisor") => {
    await createStaff(manager, { name: staffName, phone, role, password });
    const [row] = await db.select().from(users).where(eq(users.name, staffName)).limit(1);
    return ctxOf(row!, role);
  };
  await createStaff(manager, { name: "Sample Owner", phone: "08000001900", role: "owner", password });
  const assistant = await staff("Amina Yusuf", "08000001901", "assistant_manager");
  const supervisors = [
    await staff("Bello Usman", "08000001902", "supervisor"),
    await staff("Halima Garba", "08000001903", "supervisor"),
  ];

  // The store's three items come from the migrations.
  const item = async (itemName: string, reorderLevel: string) => {
    const [row] = (await db.execute(sql`SELECT id FROM stock_items WHERE name = ${itemName}`)) as unknown as { id: string }[];
    await setReorderLevel(manager, row!.id, { reorderLevel });
    return row!.id;
  };
  const stock: Record<Part, string> = {
    engine: await item("Engine oil", "10"),
    gear: await item("Gear oil", "3"),
    tyre: await item("Tyre", "5"),
  };
  await receiveStock(manager, stock.engine, { quantity: "40", unitCost: "4,500", note: "Opening stock" });
  await receiveStock(manager, stock.gear, { quantity: "10", unitCost: "5,200", note: "Opening stock" });
  await receiveStock(manager, stock.tyre, { quantity: "8", unitCost: "28,000", note: "Opening stock" });

  const bikes = [];
  for (const [index, bike] of FLEET.entries()) {
    const tricycle = await createTricycle(manager, {
      registrationNumber: bike.reg,
      codeNumber: bike.code,
      chassisNumber: `CH${100_000 + index * 137}`,
      engineNumber: `EN${200_000 + index * 211}`,
      purchasedOn: addDays(start, -between(40, 280)),
      purchaseCost: pick(["2,450,000", "2,600,000", "2,750,000"]),
      serviceInterval: bike.interval,
      serviceCycleStart: dayOf(bike.firstService),
    });
    const serial = String(1001 + index).padStart(4, "0");
    const operator = await createOperator(manager, {
      name: bike.name,
      phone: `0800000${serial}`,
      address: `${between(2, 88)} ${pick(["Jekadafari", "Pantami", "Tumfure", "Bolari", "Herwagana"])} Road, Gombe`,
      licenceNumber: `GME-${between(10_000, 99_999)}`,
      guarantorName: pick(["Alhaji Sule Maina", "Malam Idris Hamza", "Mallam Yusuf Dauda", "Alhaji Rabiu Salisu"]),
      guarantorPhone: `0800000${String(2001 + index).padStart(4, "0")}`,
    });
    await issueTricycle(manager, {
      tricycleId: tricycle!.id,
      operatorId: operator!.id,
      issuedOn: start,
      dailyBalance: bike.rate.toLocaleString("en-NG"),
    });
    bikes.push({ ...bike, tricycleId: tricycle!.id, operatorId: operator!.id, cycleStart: dayOf(bike.firstService) });
  }
  await createTricycle(manager, {
    registrationNumber: "GME 113 TX",
    codeNumber: "JT-013",
    purchasedOn: addDays(start, -3),
    purchaseCost: "2,750,000",
    serviceInterval: "fortnightly",
    serviceCycleStart: dayOf(30),
  });
  await setOperatorPin(manager, bikes[0]!.operatorId, { pin: OPERATOR_PIN });

  const issue = (ctx: Ctx, orderId: string, part: Part, quantity: string) =>
    issuePart(ctx, orderId, { itemId: stock[part], quantity });

  const repairing = new Map<string, string>();
  const offences = async (date: string) =>
    db
      .select({ id: violations.id, raisedBy: violations.raisedBy, ruleCode: violations.ruleCode })
      .from(violations)
      .where(and(eq(violations.status, "proposed"), sql`${violations.occurredOn} < ${date}`));

  let meetingId: string | undefined;
  const advanceIds = new Map<number, string>();

  for (let index = 1; index <= DAYS; index++) {
    const date = dayOf(index);
    const isToday = date === today;
    setTime(date, "00:05");
    await runDailyJob(clock);

    // Repairs that finish today, before anything else needs the tricycle.
    for (const repair of REPAIRS) {
      if (repair.days === null || index !== repair.day + repair.days) continue;
      const bike = bikes[repair.bike]!;
      const serviceToday = serviceDatesBetween(bike.cycleStart, bike.interval, date, date).length > 0;
      setTime(date, serviceToday ? "07:45" : clockTime(14, 16));
      await completeWorkOrder(assistant, repairing.get(bike.tricycleId)!, { findings: repair.done, labourCost: repair.labour });
      repairing.delete(bike.tricycleId);
    }

    // Offences from earlier days are decided in the morning, except the last few days'.
    if (index <= DAYS - 3) {
      for (const offence of await offences(date)) {
        setTime(date, clockTime(10, 11));
        const decider = offence.raisedBy === assistant.actor.userId ? manager : assistant;
        if (chance(0.1)) await rejectViolation(decider, offence.id, { reason: "Checked with the supervisor and it was a mistake" });
        else await confirmViolation(decider, offence.id);
      }
    }

    // Supervisors walk the fleet. Half of today's round is still to do.
    for (const [position, bike] of bikes.entries()) {
      if (repairing.has(bike.tricycleId) || chance(0.07)) continue;
      if (isToday && position % 2 === 1) continue;
      const stickerGone = (position === 6 && index === 13) || (position === 10 && index === 22);
      const washed = !chance(bike.habit === "steady" ? 0.03 : 0.1);
      setTime(date, clockTime(7, 11));
      await recordInspection(supervisors[position % 2]!, {
        clientId: randomUUID(),
        tricycleId: bike.tricycleId,
        washed,
        stickerIntact: !stickerGone,
        note: stickerGone ? "Company sticker has been removed" : !washed ? "Tricycle is dirty" : undefined,
        photo: !washed || stickerGone ? PHOTO : undefined,
        inspectedAt: current.toISOString(),
      });
    }

    // Services due today. Today's are left waiting for the tricycle to arrive.
    if (!isToday) {
      const due = await db
        .select({ id: workOrders.id, tricycleId: workOrders.tricycleId })
        .from(workOrders)
        .where(and(eq(workOrders.type, "service"), eq(workOrders.status, "scheduled"), eq(workOrders.scheduledFor, date)));
      for (const order of due) {
        if (repairing.has(order.tricycleId) || chance(0.07)) continue;
        const supervisor = pick(supervisors);
        setTime(date, chance(0.12) ? "10:40" : clockTime(8, 9));
        await checkInService(supervisor, order.id);
        setTime(date, clockTime(11, 13));
        await issue(assistant, order.id, "engine", pick(["1", "1.5"]));
        if (chance(0.35)) await issue(assistant, order.id, "gear", "0.5");
        await completeWorkOrder(assistant, order.id, { findings: pick(SERVICE_NOTES), labourCost: pick(["1,500", "2,000", "2,500"]) });
      }
    }

    // Faults come in late in the day.
    for (const repair of REPAIRS) {
      if (index !== repair.day) continue;
      const bike = bikes[repair.bike]!;
      setTime(date, "16:30");
      await reportFault(assistant, { tricycleId: bike.tricycleId, fault: repair.fault });
      const [order] = await db
        .select({ id: workOrders.id })
        .from(workOrders)
        .where(and(eq(workOrders.tricycleId, bike.tricycleId), eq(workOrders.type, "maintenance"), eq(workOrders.status, "checked_in")));
      repairing.set(bike.tricycleId, order!.id);
      setTime(date, "16:45");
      for (const [part, quantity] of repair.parts) await issue(assistant, order!.id, part, quantity);
    }

    // Tracker reports, raised the morning after.
    for (const [position, night] of [[4, 8], [9, 19]] as const) {
      if (index !== night + 1) continue;
      setTime(date, "09:30");
      await raiseLateWork(supervisors[0]!, {
        tricycleId: bikes[position]!.tricycleId,
        trackerAt: `${dayOf(night)}T23:15`,
        photo: PHOTO,
        note: "Tracker showed the tricycle moving after 10:00 pm",
      });
    }

    if (index === 8) {
      setTime(date, "11:00");
      meetingId = (await scheduleMeeting(manager, { title: "Monthly general meeting", scheduledFor: `${dayOf(16)}T10:00` })).id;
    }
    if (index === 16 && meetingId) {
      setTime(date, "11:30");
      const meeting = await getMeeting(manager, meetingId);
      for (const person of meeting!.roster) {
        const position = bikes.findIndex((bike) => bike.operatorId === person.operatorId);
        if (position === 4) {
          await recordAttendance(manager, meetingId, { operatorId: person.operatorId, status: "excused", reason: "Travelled for a family burial" });
        } else {
          const status = position === 2 ? "absent" : position === 7 ? "present_without_tricycle" : "present_with_tricycle";
          await recordAttendance(supervisors[0]!, meetingId, { operatorId: person.operatorId, status });
        }
      }
      await closeMeeting(supervisors[0]!, meetingId);
    }

    // Operators pay in the evening.
    for (const bike of bikes) {
      const owed = await paymentContext(assistant, bike.operatorId);
      const balance = owed!.balanceOwedKobo;
      if (balance === 0) continue;
      if (isToday && chance(0.4)) continue;
      if (bike.habit === "stops" && index >= DAYS - 6) continue;
      if (bike.habit === "sometimes" && chance(0.18)) continue;
      if (bike.habit === "late" && index % 6 < 2) continue;

      let amount = balance;
      if (bike.habit === "part" && chance(0.3)) amount = Math.floor((balance * 0.7) / 50_000) * 50_000;
      const penalty = bike.habit !== "stops" && owed!.penaltiesOwedKobo > 0 && chance(0.4) ? owed!.penaltiesOwedKobo : 0;
      const method = pick(["cash", "cash", "cash", "cash", "transfer", "transfer", "pos"]);
      setTime(date, clockTime(17, 20));
      await recordPayment(chance(0.7) ? assistant : manager, {
        operatorId: bike.operatorId,
        clientId: randomUUID(),
        amount: naira(amount + penalty),
        method,
        tricyclePresent: chance(0.015) ? "no" : "yes",
        penaltyAmount: penalty ? naira(penalty) : undefined,
      });
    }

    if (index === 18) {
      setTime(date, "15:00");
      await receiveStock(manager, stock.engine, { quantity: "20", unitCost: "4,800", note: "Restock from supplier" });
    }

    // Loans and expense funds, once the day's takings are in.
    setTime(date, "21:05");
    for (const loan of LOANS) {
      const operatorId = bikes[loan.bike]!.operatorId;
      if (index === loan.day) await grantLoan(manager, { operatorId, amount: loan.amount, source: "bank" });
      for (const [day, amount] of loan.repay) {
        if (index === day) {
          await recordPayment(assistant, { operatorId, clientId: randomUUID(), amount, method: "transfer", loanAmount: amount });
        }
      }
    }
    for (const plan of ADVANCES) {
      if (index === plan.day) {
        const advance = await createAdvance(manager, {
          purpose: plan.purpose,
          amount: plan.amount,
          source: plan.fromCash ? assistant.actor.userId : "bank",
        });
        advanceIds.set(plan.day, advance.id);
      }
      const id = advanceIds.get(plan.day);
      if (id && index === plan.day + 2) {
        for (const [category, description, amount] of plan.spent) {
          await addExpenseLine(manager, id, { kind: "spent", category, description, amount, spentOn: date });
        }
        if (plan.change) await addExpenseLine(manager, id, { kind: "change", amount: plan.change });
      }
      if (id && index === plan.day + 3 && plan.end !== "open") {
        await submitAdvance(manager, id);
        if (plan.end === "countersigned") await countersignAdvance(assistant, id);
      }
    }

    // The day's cash is counted at closing time.
    if (!isToday) {
      setTime(date, "21:30");
      for (const person of await cashDay(manager, date)) {
        if (person.expectedKobo === 0) continue;
        const short = index === 10 && person.id === assistant.actor.userId;
        await closeCash(person.id === assistant.actor.userId ? assistant : manager, {
          custodianId: person.id,
          businessDate: date,
          counted: naira(person.expectedKobo - (short ? 50_000 : 0)),
          explanation: short ? "₦500 short, gave wrong change to an operator" : undefined,
        });
      }
    }
    process.stdout.write(`${date} done\n`);
  }

  setTime(today, "23:59");
  await scheduleMeeting(manager, { title: "Monthly general meeting", scheduledFor: `${addDays(today, 12)}T10:00` });

  const [totals] = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM tricycles)::int AS tricycles,
      (SELECT COUNT(*) FROM operators)::int AS operators,
      (SELECT COUNT(*) FROM assignments)::int AS assignments,
      (SELECT COUNT(*) FROM charges WHERE type = 'daily_balance')::int AS balances,
      (SELECT COUNT(*) FROM payments)::int AS payments,
      (SELECT COALESCE(SUM(amount_kobo), 0)::float8 FROM payments) AS collected,
      (SELECT COUNT(*) FROM inspections)::int AS inspections,
      (SELECT COUNT(*) FROM violations)::int AS offences,
      (SELECT COUNT(*) FROM violations WHERE status = 'proposed')::int AS to_confirm,
      (SELECT COUNT(*) FROM work_orders WHERE status = 'completed')::int AS completed_work,
      (SELECT COUNT(*) FROM work_orders WHERE status = 'missed')::int AS missed_services,
      (SELECT COUNT(*) FROM stock_movements WHERE kind = 'issued')::int AS parts_issued,
      (SELECT COUNT(*) FROM dismissals WHERE status = 'flagged')::int AS sacking_alerts
  `)) as unknown as (Record<string, number> & { collected: number })[];
  console.log({ ...totals, collected: formatNaira(totals!.collected), from: start, to: today });
}

main()
  .catch((error) => {
    console.error(error, error?.fieldErrors ?? "");
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
