import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { assignments, charges, operators, tricycles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { asPgError, DomainError, ForbiddenError } from "@/lib/errors";
import {
  balanceOn,
  changeIssueDate,
  changeTricycleBalance,
  issueTricycle,
  rateOn,
  returnTricycle,
} from "@/services/assignments";
import type { Ctx } from "@/services/context";
import { createOperator, markOperatorLeft } from "@/services/operators";
import { createTricycle, getTricycle, listInStockTricycles, listTricycles, retireTricycle } from "@/services/tricycles";
import { makeOperator, makeTricycle, makeUser, noticesFor, TODAY, tricycleInput, uniquePhone } from "./helpers";

let manager: Ctx;
let assistant: Ctx;

beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  assistant = (await makeUser("assistant_manager")).ctx;
});

async function issue({ dailyBalance = "12,000", ...overrides }: Record<string, unknown> = {}) {
  const t = await makeTricycle(manager, { dailyBalance });
  const o = await makeOperator(manager);
  const a = (await issueTricycle(manager, {
    tricycleId: t.id,
    operatorId: o.id,
    issuedOn: "2026-03-01",
    ...overrides,
  }))!;
  return { tricycleId: t.id, operatorId: o.id, assignmentId: a.id };
}

const statusOf = async (id: string) =>
  (await db.select().from(tricycles).where(eq(tricycles.id, id)))[0]!.status;

describe("issuing a tricycle", () => {
  it("records the issue date and daily balance, and marks it issued", async () => {
    const { tricycleId, assignmentId } = await issue();
    expect(await statusOf(tricycleId)).toBe("issued");
    const detail = await getTricycle(manager, tricycleId);
    expect(detail!.current!.assignment.issuedOn).toBe("2026-03-01");
    expect(detail!.current!.dailyBalanceKobo).toBe(1_200_000);
    expect(await rateOn(db, assignmentId, "2026-02-28")).toBeNull();
  });

  it("refuses a tricycle that is already with an operator", async () => {
    const { tricycleId } = await issue();
    const other = await makeOperator(manager);
    await expect(
      issueTricycle(manager, {
        tricycleId,
        operatorId: other.id,
        issuedOn: TODAY,
      }),
    ).rejects.toThrow(/cannot be issued while it is with an operator/);
  });

  it("refuses an operator who already has a tricycle", async () => {
    const { operatorId } = await issue();
    const free = await makeTricycle(manager);
    await expect(
      issueTricycle(manager, {
        tricycleId: free.id,
        operatorId,
        issuedOn: TODAY,
      }),
    ).rejects.toMatchObject({
      fieldErrors: { issuedOn: "This operator already had a tricycle on that date" },
    });
  });

  it("lets exactly one of two simultaneous issues succeed", async () => {
    const t = await makeTricycle(manager, { dailyBalance: "15000" });
    const [a, b] = await Promise.all([makeOperator(manager), makeOperator(manager)]);
    const results = await Promise.allSettled(
      [a, b].map((o) =>
        issueTricycle(manager, {
          tricycleId: t.id,
          operatorId: o.id,
          issuedOn: TODAY,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const detail = await getTricycle(manager, t.id);
    expect(detail!.history).toHaveLength(1);
  });

  it("is impossible at database level, even bypassing the app", async () => {
    const { tricycleId } = await issue();
    const other = await makeOperator(manager);
    const error = await db
      .execute(
        sql`INSERT INTO assignments (tricycle_id, operator_id, issued_on, issued_by)
            VALUES (${tricycleId}, ${other.id}, '2026-05-01', ${manager.actor.userId})`,
      )
      .catch((e: unknown) => e);
    expect(asPgError(error)?.constraint_name).toBe("one_operator_per_tricycle");
  });

  it("refuses dates before purchase or in the future", async () => {
    const t = await makeTricycle(manager, { purchasedOn: "2026-06-01" });
    const o = await makeOperator(manager);
    const attempt = (issuedOn: string) =>
      issueTricycle(manager, { tricycleId: t.id, operatorId: o.id, issuedOn });
    await expect(attempt("2026-05-31")).rejects.toThrow(DomainError);
    await expect(attempt("2026-11-11")).rejects.toThrow(DomainError);
  });

  it("refuses an inactive operator and a retired tricycle", async () => {
    const leaver = await makeOperator(manager);
    await markOperatorLeft(manager, leaver.id, { reason: "Moved away" });
    const t = await makeTricycle(manager);
    await expect(
      issueTricycle(manager, { tricycleId: t.id, operatorId: leaver.id, issuedOn: TODAY }),
    ).rejects.toThrow(DomainError);

    await retireTricycle(manager, t.id, { reason: "Sold" });
    const o = await makeOperator(manager);
    await expect(
      issueTricycle(manager, { tricycleId: t.id, operatorId: o.id, issuedOn: TODAY }),
    ).rejects.toThrow(/retired/);
  });
});

describe("returning a tricycle", () => {
  it("frees it for reissue on the same day and keeps the full history", async () => {
    const { tricycleId, assignmentId } = await issue();
    await returnTricycle(manager, assignmentId, { returnedOn: "2026-10-01", reason: "reassigned" });
    expect(await statusOf(tricycleId)).toBe("in_stock");

    await changeTricycleBalance(manager, tricycleId, { dailyBalance: "15000", effectiveFrom: TODAY, reason: "Overhauled" });
    const next = await makeOperator(manager);
    const reissued = (await issueTricycle(manager, { tricycleId, operatorId: next.id, issuedOn: "2026-10-01" }))!;
    const detail = await getTricycle(manager, tricycleId);
    expect(detail!.history).toHaveLength(2);
    // Backdated to 1 October: the old amount until today, when the change starts.
    expect(await rateOn(db, reissued.id, "2026-10-01")).toBe(1_200_000);
    expect(detail!.current!.dailyBalanceKobo).toBe(1_500_000);
  });

  it("refuses a backdated issue that overlaps earlier history", async () => {
    const { tricycleId, assignmentId } = await issue({ issuedOn: "2026-03-01" });
    await returnTricycle(manager, assignmentId, { returnedOn: "2026-06-01", reason: "other" });
    const next = await makeOperator(manager);
    await expect(
      issueTricycle(manager, {
        tricycleId,
        operatorId: next.id,
        issuedOn: "2026-05-01",
      }),
    ).rejects.toMatchObject({
      fieldErrors: { issuedOn: "This tricycle was already with an operator on that date" },
    });
  });

  it("refuses a return before the issue date, or twice", async () => {
    const { assignmentId } = await issue();
    await expect(
      returnTricycle(manager, assignmentId, { returnedOn: "2026-02-01", reason: "other" }),
    ).rejects.toThrow(DomainError);
    await returnTricycle(manager, assignmentId, { returnedOn: TODAY, reason: "other" });
    await expect(
      returnTricycle(manager, assignmentId, { returnedOn: TODAY, reason: "other" }),
    ).rejects.toThrow(/already been returned/);
  });

  it("will not let an operator leave while holding a tricycle", async () => {
    const { operatorId } = await issue();
    await expect(markOperatorLeft(manager, operatorId, { reason: "Left" })).rejects.toThrow(
      /still has a tricycle/,
    );
  });
});

describe("each tricycle's daily balance", () => {
  const change = (ctx: Ctx, tricycleId: string, dailyBalance: string, effectiveFrom = TODAY) =>
    changeTricycleBalance(ctx, tricycleId, { dailyBalance, effectiveFrom, reason: "Test" });

  /** A tricycle from before balances were kept on tricycles, with none set. */
  async function withoutBalance() {
    const { dailyBalance: _, purchaseCost: __, ...input } = tricycleInput();
    const [row] = await db.insert(tricycles).values(input as typeof tricycles.$inferInsert).returning();
    return row!;
  }

  it("must be entered when a tricycle is added, between ₦5,000 and ₦30,000", async () => {
    await expect(createTricycle(manager, tricycleInput({ dailyBalance: "" }))).rejects.toMatchObject({
      fieldErrors: { dailyBalance: expect.any(String) },
    });
    for (const outside of ["4,999", "30,001"]) {
      await expect(createTricycle(manager, tricycleInput({ dailyBalance: outside }))).rejects.toMatchObject({
        fieldErrors: { dailyBalance: "Daily balance must be between ₦5,000 and ₦30,000" },
      });
    }
    for (const [amount, kobo] of [["5,000", 500_000], ["30,000", 3_000_000]] as const) {
      const t = (await createTricycle(manager, tricycleInput({ dailyBalance: amount, purchasedOn: "2026-01-15" })))!;
      expect(await balanceOn(db, t.id, "2026-01-15")).toBe(kobo);
      expect(await balanceOn(db, t.id, "2026-01-14")).toBeNull();
    }
  });

  it("is what the operator is charged, without being typed at issue", async () => {
    const { assignmentId } = await issue({ dailyBalance: "15,000" });
    expect(await rateOn(db, assignmentId, "2026-03-01")).toBe(1_500_000);
  });

  it("cannot be issued until one is set", async () => {
    const t = await withoutBalance();
    const o = await makeOperator(manager);
    await expect(issueTricycle(manager, { tricycleId: t.id, operatorId: o.id, issuedOn: TODAY })).rejects.toMatchObject({
      fieldErrors: { tricycleId: "Set this tricycle's daily balance first" },
    });
    await change(manager, t.id, "13,000");
    const a = (await issueTricycle(manager, { tricycleId: t.id, operatorId: o.id, issuedOn: TODAY }))!;
    expect(await rateOn(db, a.id, TODAY)).toBe(1_300_000);
  });

  it("changes an issued tricycle's charges from the start date only, and tells the operator", async () => {
    const { tricycleId, operatorId, assignmentId } = await issue();
    await change(manager, tricycleId, "15,000", "2026-12-01");
    expect(await rateOn(db, assignmentId, "2026-11-30")).toBe(1_200_000);
    expect(await rateOn(db, assignmentId, "2026-12-01")).toBe(1_500_000);
    const [notice] = await noticesFor(operatorId, "balance_changed");
    expect(notice!.body).toMatch(/from ₦12,000 to ₦15,000, starting 1 Dec 2026/);
  });

  it("changes an in-stock tricycle for its next operator, including a change still to come", async () => {
    const t = await makeTricycle(manager, { dailyBalance: "12,000" });
    await change(manager, t.id, "14,000");
    await change(manager, t.id, "16,000", "2026-12-01");
    const o = await makeOperator(manager);
    const a = (await issueTricycle(manager, { tricycleId: t.id, operatorId: o.id, issuedOn: "2026-11-01" }))!;
    expect(await rateOn(db, a.id, "2026-11-01")).toBe(1_200_000);
    expect(await rateOn(db, a.id, TODAY)).toBe(1_400_000);
    expect(await rateOn(db, a.id, "2026-12-01")).toBe(1_600_000);
    const detail = await getTricycle(manager, t.id);
    expect(detail!.balance.today).toBe(1_400_000);
    expect(detail!.balance.upcoming.map((b) => b.amountKobo)).toEqual([1_600_000]);
  });

  it("shows each tricycle's amount today in the lists", async () => {
    const input = tricycleInput({ dailyBalance: "13,500" });
    const t = (await createTricycle(manager, input))!;
    const bare = await withoutBalance();
    const inStock = await listInStockTricycles(manager);
    expect(inStock.find((row) => row.id === t.id)?.dailyBalanceKobo).toBe(1_350_000);
    expect(inStock.find((row) => row.id === bare.id)?.dailyBalanceKobo).toBeNull();
    const [listed] = await listTricycles(manager, { q: input.codeNumber as string });
    expect(listed!.dailyBalanceKobo).toBe(1_350_000);
  });

  it("lets the latest entry correct a mistake on the same date", async () => {
    const { tricycleId, assignmentId } = await issue();
    await change(manager, tricycleId, "25,000");
    await change(manager, tricycleId, "10,000");
    expect(await rateOn(db, assignmentId, TODAY)).toBe(1_000_000);
    expect(await balanceOn(db, tricycleId, TODAY)).toBe(1_000_000);
  });

  it("cannot start in the past, needs a reason and is Manager-only", async () => {
    const { tricycleId } = await issue();
    await expect(change(manager, tricycleId, "10000", "2026-11-09")).rejects.toThrow(DomainError);
    await expect(
      changeTricycleBalance(manager, tricycleId, { dailyBalance: "10000", effectiveFrom: TODAY, reason: "" }),
    ).rejects.toThrow(DomainError);
    await expect(change(manager, tricycleId, "50,000")).rejects.toThrow(DomainError);
    await expect(change(assistant, tricycleId, "10000")).rejects.toThrow(ForbiddenError);
  });

  it("cannot be edited or deleted in the database", async () => {
    const { tricycleId, assignmentId } = await issue();
    for (const statement of [
      sql`UPDATE balance_rates SET amount_kobo = 1 WHERE assignment_id = ${assignmentId}`,
      sql`DELETE FROM balance_rates WHERE assignment_id = ${assignmentId}`,
      sql`UPDATE tricycle_balances SET amount_kobo = 1 WHERE tricycle_id = ${tricycleId}`,
      sql`DELETE FROM tricycle_balances WHERE tricycle_id = ${tricycleId}`,
    ]) {
      await expect(db.execute(statement)).rejects.toThrow();
    }
  });
});

describe("adding an operator with a tricycle", () => {
  const status = async (id: string) =>
    (await db.select().from(tricycles).where(eq(tricycles.id, id)))[0]!.status;
  const named = (name: string) => db.select().from(operators).where(eq(operators.name, name));
  const form = (tricycleId: string, overrides: Record<string, unknown> = {}) => ({
    name: `New ${uniquePhone()}`,
    phone: uniquePhone(),
    tricycleId,
    issuedOn: TODAY,
    ...overrides,
  });

  it("issues the tricycle in the same save", async () => {
    const t = await makeTricycle(manager);
    const o = (await createOperator(assistant, form(t.id)))!;
    expect(await status(t.id)).toBe("issued");
    const [held] = await db.select().from(assignments).where(eq(assignments.tricycleId, t.id));
    expect(held).toMatchObject({ operatorId: o.id, issuedOn: TODAY, returnedOn: null });
  });

  it("adds an operator with no tricycle when none is chosen", async () => {
    const o = (await createOperator(manager, form("")))!;
    expect(await db.select().from(assignments).where(eq(assignments.operatorId, o.id))).toHaveLength(0);
  });

  it("saves nothing if the tricycle has been issued to someone else", async () => {
    const { tricycleId } = await issue();
    const input = form(tricycleId);
    await expect(createOperator(manager, input)).rejects.toThrow(/cannot be issued/);
    expect(await named(input.name)).toHaveLength(0);
  });

  it("charges the tricycle's own balance", async () => {
    const t = await makeTricycle(manager, { dailyBalance: "15,000" });
    await createOperator(manager, form(t.id));
    const [held] = await db.select().from(assignments).where(eq(assignments.tricycleId, t.id));
    expect(await rateOn(db, held!.id, TODAY)).toBe(1_500_000);
  });

  it("leaves the tricycle in stock if the phone number is already used", async () => {
    const t = await makeTricycle(manager);
    const phone = uniquePhone();
    await makeOperator(manager, { phone });
    await expect(createOperator(manager, form(t.id, { phone }))).rejects.toBeInstanceOf(DomainError);
    expect(await status(t.id)).toBe("in_stock");
  });
});

describe("changing the date issued", () => {
  const raise = (a: { tricycleId: string; operatorId: string; assignmentId: string }, dates: string[]) =>
    db.insert(charges).values(
      dates.map((date) => ({
        type: "daily_balance" as const,
        operatorId: a.operatorId,
        tricycleId: a.tricycleId,
        assignmentId: a.assignmentId,
        amountKobo: 1_200_000,
        businessDate: date,
        dueOn: date,
      })),
    );
  const owedDays = async (assignmentId: string) =>
    ((await db.execute(sql`
      SELECT business_date::text AS d FROM valid_charges WHERE assignment_id = ${assignmentId} ORDER BY 1
    `)) as unknown as { d: string }[]).map((r) => r.d);
  const issuedOn = async (id: string) => (await db.select().from(assignments).where(eq(assignments.id, id)))[0]!.issuedOn;

  it("moves the date later and takes back balances for days before it", async () => {
    const a = await issue();
    await raise(a, ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
    await changeIssueDate(assistant, a.assignmentId, { issuedOn: "2026-03-03", reason: "Typed the wrong day" });
    expect(await issuedOn(a.assignmentId)).toBe("2026-03-03");
    expect(await owedDays(a.assignmentId)).toEqual(["2026-03-04", "2026-03-05"]);
  });

  it("moves the date earlier with the tricycle's balance from that day, raising nothing", async () => {
    const a = await issue();
    await raise(a, ["2026-03-02"]);
    await changeIssueDate(manager, a.assignmentId, { issuedOn: "2026-02-20", reason: "Collected earlier" });
    expect(await issuedOn(a.assignmentId)).toBe("2026-02-20");
    expect(await rateOn(db, a.assignmentId, "2026-02-25")).toBe(1_200_000);
    expect(await owedDays(a.assignmentId)).toEqual(["2026-03-02"]);
  });

  it("refuses a future date, a date before purchase, and asks for a reason", async () => {
    const a = await issue();
    await expect(changeIssueDate(manager, a.assignmentId, { issuedOn: "2026-12-01", reason: "x" })).rejects.toMatchObject({
      fieldErrors: { issuedOn: "Date issued cannot be in the future" },
    });
    await expect(changeIssueDate(manager, a.assignmentId, { issuedOn: "2026-01-01", reason: "x" })).rejects.toMatchObject({
      fieldErrors: { issuedOn: "Date issued cannot be before the date purchased" },
    });
    await expect(changeIssueDate(manager, a.assignmentId, { issuedOn: "2026-02-20", reason: "" })).rejects.toMatchObject({
      fieldErrors: { reason: expect.any(String) },
    });
  });

  it("refuses a date that overlaps the operator's or tricycle's earlier assignment", async () => {
    const first = await issue();
    await returnTricycle(manager, first.assignmentId, { returnedOn: "2026-04-10", reason: "reassigned" });
    const second = (await issueTricycle(manager, { tricycleId: first.tricycleId, operatorId: (await makeOperator(manager)).id, issuedOn: "2026-04-15" }))!;
    await expect(changeIssueDate(manager, second.id, { issuedOn: "2026-04-05", reason: "x" })).rejects.toMatchObject({
      fieldErrors: { issuedOn: "This tricycle was already with an operator on that date" },
    });
    await expect(changeIssueDate(manager, first.assignmentId, { issuedOn: "2026-02-20", reason: "x" })).rejects.toThrow(/current operator/);
  });

  it("is for office staff only", async () => {
    const a = await issue();
    const supervisor = (await makeUser("supervisor")).ctx;
    await expect(changeIssueDate(supervisor, a.assignmentId, { issuedOn: "2026-03-02", reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
