import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { charges } from "@/db/schema";
import { koboToInput, previewPayment } from "@/lib/payment-preview";
import type { Ctx } from "@/services/context";
import { financeOverview, listArrears } from "@/services/finance";
import { openCharges } from "@/services/ledger";
import { grantLoan, listLoans, loansToCollect } from "@/services/loans";
import { paymentContext, recordPayment } from "@/services/payments";
import { makeOperator, makeUser, nextReference, TODAY } from "./helpers";

/** What each charge received from one payment, by charge id. */
async function allocationsOf(paymentId: string) {
  const rows = (await db.execute(sql`
    SELECT charge_id, amount_kobo::float8 AS amount FROM payment_allocations WHERE payment_id = ${paymentId}
  `)) as unknown as { charge_id: string; amount: number }[];
  return Object.fromEntries(rows.map((r) => [r.charge_id, r.amount]));
}

describe("taking unpaid balances and loan repayments", () => {
  let manager: Ctx;

  /** An operator owing three ₦10,000 balances, a ₦3,000 fine and a ₦20,000 loan. */
  async function owingOperator(loanGivenOn?: string) {
    const operator = await makeOperator(manager);
    const ids = [];
    for (const day of ["2026-11-01", "2026-11-02", "2026-11-03"]) {
      const [row] = await db
        .insert(charges)
        .values({ type: "daily_balance", operatorId: operator.id, amountKobo: 1_000_000, businessDate: day })
        .returning({ id: charges.id });
      ids.push(row!.id);
    }
    const [fine] = await db
      .insert(charges)
      .values({ type: "penalty", operatorId: operator.id, amountKobo: 300_000, businessDate: "2026-11-02" })
      .returning({ id: charges.id });
    const lender = loanGivenOn ? { ...manager, clock: () => new Date(`${loanGivenOn}T09:00:00+01:00`) } : manager;
    await grantLoan(lender, { operatorId: operator.id, amount: "20,000", source: "owner" });
    const [loanCharge] = await db
      .select({ id: charges.id })
      .from(charges)
      .where(sql`${charges.operatorId} = ${operator.id} AND ${charges.type} = 'loan'`);
    return { operatorId: operator.id, balanceIds: ids, fineId: fine!.id, loanId: loanCharge!.id };
  }

  async function previewFor(operatorId: string, amountKobo: number, finesPartKobo: number, loanPartKobo: number) {
    const data = (await paymentContext(manager, operatorId))!;
    return previewPayment({
      amountKobo,
      finesPartKobo,
      loanPartKobo,
      balances: data.balances,
      finesOwedKobo: data.penaltiesOwedKobo,
      loanOwedKobo: data.loanOwedKobo,
    });
  }

  const pay = (operatorId: string, amount: string, extra: Record<string, unknown> = {}) =>
    recordPayment(manager, {
      operatorId,
      amount,
      method: "transfer",
      reference: nextReference(),
      clientId: randomUUID(),
      ...extra,
    });

  beforeAll(async () => {
    manager = (await makeUser("manager")).ctx;
  });

  it("previews exactly what the payment then clears", async () => {
    const o = await owingOperator();
    // ₦32,000: ₦3,000 to the fine, ₦5,000 to the loan, ₦24,000 to balances oldest first.
    const preview = await previewFor(o.operatorId, 3_200_000, 300_000, 500_000);
    expect(preview.problems).toEqual([]);
    expect(preview.days).toEqual([
      { businessDate: "2026-11-01", appliedKobo: 1_000_000, cleared: true },
      { businessDate: "2026-11-02", appliedKobo: 1_000_000, cleared: true },
      { businessDate: "2026-11-03", appliedKobo: 400_000, cleared: false },
    ]);
    expect(preview).toMatchObject({ creditKobo: 0, balanceLeftKobo: 600_000, loanLeftKobo: 1_500_000 });

    const payment = (await pay(o.operatorId, "32,000", { penaltyAmount: "3,000", loanAmount: "5,000" }))!;
    expect(await allocationsOf(payment.id)).toEqual({
      [o.balanceIds[0]!]: 1_000_000,
      [o.balanceIds[1]!]: 1_000_000,
      [o.balanceIds[2]!]: 400_000,
      [o.fineId]: 300_000,
      [o.loanId]: 500_000,
    });
    const left = await openCharges(db, o.operatorId, "daily_balance");
    expect(left.reduce((sum, c) => sum + c.outstandingKobo, 0)).toBe(preview.balanceLeftKobo);
  });

  it("shows money beyond every balance as credit, as the server keeps it", async () => {
    const o = await owingOperator();
    const preview = await previewFor(o.operatorId, 3_500_000, 0, 0);
    expect(preview).toMatchObject({ balancesKobo: 3_000_000, creditKobo: 500_000, balanceLeftKobo: 0 });
    const payment = (await pay(o.operatorId, "35,000"))!;
    const applied = Object.values(await allocationsOf(payment.id)).reduce((a, b) => a + b, 0);
    expect(3_500_000 - applied).toBe(preview.creditKobo);
  });

  it("puts a whole loan-mode payment on the loan and clears it", async () => {
    const o = await owingOperator();
    const preview = await previewFor(o.operatorId, 2_000_000, 0, 2_000_000);
    expect(preview).toMatchObject({ loanKobo: 2_000_000, loanLeftKobo: 0, balancesKobo: 0, creditKobo: 0 });
    await pay(o.operatorId, "20,000", { loanAmount: "20,000" });
    const loan = (await listLoans(manager)).cleared.find((row) => row.operatorId === o.operatorId);
    expect(loan?.status).toBe("cleared");
  });

  it("warns about the same mistakes the server refuses", async () => {
    const o = await owingOperator();
    const preview = await previewFor(o.operatorId, 1_000_000, 500_000, 2_500_000);
    expect(preview.problems).toEqual([
      "The fines part is more than the fines owed.",
      "The loan part is more than the loan owed.",
      "Fines and loan together are more than the amount received.",
    ]);
    await expect(pay(o.operatorId, "10,000", { loanAmount: "25,000" })).rejects.toThrow();
  });

  it("lists the loan quiet for longest first, with what is left", async () => {
    const quiet = await owingOperator("2026-10-20");
    const recent = await owingOperator();
    await pay(recent.operatorId, "5,000", { loanAmount: "5,000" });
    const { active, outstandingKobo, canCollect } = await listLoans(manager);
    expect(canCollect).toBe(true);
    const mine = active.filter((row) => [quiet.operatorId, recent.operatorId].includes(row.operatorId));
    expect(mine.map((row) => row.operatorId)).toEqual([quiet.operatorId, recent.operatorId]);
    expect(mine[0]).toMatchObject({ lastRepaidOn: null, quietDays: 21 });
    const recentRow = mine.find((row) => row.operatorId === recent.operatorId)!;
    expect(recentRow).toMatchObject({ owedKobo: 1_500_000, lastRepaidOn: TODAY, quietDays: 0 });
    expect(outstandingKobo).toBe(active.reduce((sum, row) => sum + row.owedKobo, 0));
    expect((await loansToCollect()).loansOwedKobo).toBe(outstandingKobo);
  });

  it("counts only working operators in the pulse, and their total matches the list", async () => {
    const o = await owingOperator();
    await db.execute(sql`UPDATE operators SET status = 'left' WHERE id = ${o.operatorId}`);
    const [money, arrears] = await Promise.all([financeOverview(manager), listArrears(manager)]);
    const working = arrears.filter((row) => row.status === "active");
    expect(money.overdueOperators).toBe(working.length);
    expect(money.overdueOwedKobo).toBe(working.reduce((sum, row) => sum + row.owed, 0));
    expect(arrears.find((row) => row.id === o.operatorId)?.status).toBe("left");
  });

  it("writes amounts the way staff type them", () => {
    expect(koboToInput(1_500_000)).toBe("15000");
    expect(koboToInput(1_500_050)).toBe("15000.50");
    expect(koboToInput(5)).toBe("0.05");
  });
});

