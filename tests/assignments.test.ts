import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { assignments, operators, tricycles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { asPgError, DomainError, ForbiddenError } from "@/lib/errors";
import {
  changeRate,
  issueTricycle,
  rateOn,
  returnTricycle,
} from "@/services/assignments";
import type { Ctx } from "@/services/context";
import { createOperator, markOperatorLeft } from "@/services/operators";
import { getTricycle, retireTricycle } from "@/services/tricycles";
import { makeOperator, makeTricycle, makeUser, TODAY, uniquePhone } from "./helpers";

let manager: Ctx;
let assistant: Ctx;

beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  assistant = (await makeUser("assistant_manager")).ctx;
});

async function issue(overrides: Record<string, unknown> = {}) {
  const t = await makeTricycle(manager);
  const o = await makeOperator(manager);
  const a = (await issueTricycle(manager, {
    tricycleId: t.id,
    operatorId: o.id,
    issuedOn: "2026-03-01",
    dailyBalance: "12,000",
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
        dailyBalance: "10000",
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
        dailyBalance: "10000",
      }),
    ).rejects.toMatchObject({
      fieldErrors: { issuedOn: "This operator already had a tricycle on that date" },
    });
  });

  it("lets exactly one of two simultaneous issues succeed", async () => {
    const t = await makeTricycle(manager);
    const [a, b] = await Promise.all([makeOperator(manager), makeOperator(manager)]);
    const results = await Promise.allSettled(
      [a, b].map((o) =>
        issueTricycle(manager, {
          tricycleId: t.id,
          operatorId: o.id,
          issuedOn: TODAY,
          dailyBalance: "15000",
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
      issueTricycle(manager, { tricycleId: t.id, operatorId: o.id, issuedOn, dailyBalance: "10000" });
    await expect(attempt("2026-05-31")).rejects.toThrow(DomainError);
    await expect(attempt("2026-11-11")).rejects.toThrow(DomainError);
  });

  it("refuses an inactive operator and a retired tricycle", async () => {
    const leaver = await makeOperator(manager);
    await markOperatorLeft(manager, leaver.id, { reason: "Moved away" });
    const t = await makeTricycle(manager);
    await expect(
      issueTricycle(manager, { tricycleId: t.id, operatorId: leaver.id, issuedOn: TODAY, dailyBalance: "10000" }),
    ).rejects.toThrow(DomainError);

    await retireTricycle(manager, t.id, { reason: "Sold" });
    const o = await makeOperator(manager);
    await expect(
      issueTricycle(manager, { tricycleId: t.id, operatorId: o.id, issuedOn: TODAY, dailyBalance: "10000" }),
    ).rejects.toThrow(/retired/);
  });
});

describe("returning a tricycle", () => {
  it("frees it for reissue on the same day and keeps the full history", async () => {
    const { tricycleId, assignmentId } = await issue();
    await returnTricycle(manager, assignmentId, { returnedOn: "2026-10-01", reason: "reassigned" });
    expect(await statusOf(tricycleId)).toBe("in_stock");

    const next = await makeOperator(manager);
    await issueTricycle(manager, {
      tricycleId,
      operatorId: next.id,
      issuedOn: "2026-10-01",
      dailyBalance: "15000",
    });
    const detail = await getTricycle(manager, tricycleId);
    expect(detail!.history).toHaveLength(2);
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
        dailyBalance: "10000",
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

describe("changing the daily balance", () => {
  it("applies from its start date and leaves earlier days unchanged", async () => {
    const { assignmentId } = await issue();
    await changeRate(manager, assignmentId, { dailyBalance: "15,000", effectiveFrom: "2026-12-01" });
    expect(await rateOn(db, assignmentId, "2026-11-30")).toBe(1_200_000);
    expect(await rateOn(db, assignmentId, "2026-12-01")).toBe(1_500_000);
  });

  it("lets the latest entry correct a mistake on the same date", async () => {
    const { assignmentId } = await issue();
    await changeRate(manager, assignmentId, { dailyBalance: "100", effectiveFrom: TODAY });
    await changeRate(manager, assignmentId, { dailyBalance: "10,000", effectiveFrom: TODAY });
    expect(await rateOn(db, assignmentId, TODAY)).toBe(1_000_000);
  });

  it("cannot start in the past and is Manager-only", async () => {
    const { assignmentId } = await issue();
    await expect(
      changeRate(manager, assignmentId, { dailyBalance: "10000", effectiveFrom: "2026-11-09" }),
    ).rejects.toThrow(DomainError);
    await expect(
      changeRate(assistant, assignmentId, { dailyBalance: "10000", effectiveFrom: TODAY }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("cannot be edited or deleted in the database", async () => {
    const { assignmentId } = await issue();
    await expect(
      db.execute(sql`UPDATE balance_rates SET amount_kobo = 1 WHERE assignment_id = ${assignmentId}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM balance_rates WHERE assignment_id = ${assignmentId}`),
    ).rejects.toThrow();
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
    dailyBalance: "12,000",
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
    const o = (await createOperator(manager, form("", { dailyBalance: "" })))!;
    expect(await db.select().from(assignments).where(eq(assignments.operatorId, o.id))).toHaveLength(0);
  });

  it("saves nothing if the tricycle has been issued to someone else", async () => {
    const { tricycleId } = await issue();
    const input = form(tricycleId);
    await expect(createOperator(manager, input)).rejects.toThrow(/cannot be issued/);
    expect(await named(input.name)).toHaveLength(0);
  });

  it("asks for the daily balance and saves nothing without it", async () => {
    const t = await makeTricycle(manager);
    const input = form(t.id, { dailyBalance: "" });
    await expect(createOperator(manager, input)).rejects.toBeInstanceOf(DomainError);
    expect(await named(input.name)).toHaveLength(0);
    expect(await status(t.id)).toBe("in_stock");
  });

  it("leaves the tricycle in stock if the phone number is already used", async () => {
    const t = await makeTricycle(manager);
    const phone = uniquePhone();
    await makeOperator(manager, { phone });
    await expect(createOperator(manager, form(t.id, { phone }))).rejects.toBeInstanceOf(DomainError);
    expect(await status(t.id)).toBe("in_stock");
  });
});
