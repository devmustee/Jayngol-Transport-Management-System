import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { charges, loans } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import type { Ctx } from "@/services/context";
import {
  approveLoanRequest,
  listLoanRequests,
  rejectLoanRequest,
  requestLoan,
  waitingLoanRequests,
  withdrawLoanRequest,
} from "@/services/loan-requests";
import { cancelLoan, getLoan, grantLoan } from "@/services/loans";
import { markOperatorLeft } from "@/services/operators";
import { makeOperator, makeUser } from "./helpers";

let manager: Ctx;
let assistant: Ctx;
let otherAssistant: Ctx;
beforeAll(async () => {
  manager = (await makeUser("manager")).ctx;
  assistant = (await makeUser("assistant_manager")).ctx;
  otherAssistant = (await makeUser("assistant_manager")).ctx;
});

const inbox = async (userId: string, kind: string) => {
  const { notifications, notificationRecipients } = await import("@/db/schema");
  return db
    .select({ body: notifications.body })
    .from(notificationRecipients)
    .innerJoin(notifications, eq(notifications.id, notificationRecipients.notificationId))
    .where(and(eq(notificationRecipients.userId, userId), eq(notifications.kind, kind)));
};

const loanCharges = (operatorId: string) =>
  db.select().from(charges).where(and(eq(charges.operatorId, operatorId), eq(charges.type, "loan")));

describe("an Assistant Manager asking for a loan", () => {
  it("moves no money, leaves nothing owed and tells the Manager", async () => {
    const operator = await makeOperator(manager);
    const request = await requestLoan(assistant, { operatorId: operator.id, amount: "25,000", reason: "Wedding" });
    expect(await loanCharges(operator.id)).toEqual([]);
    expect(await db.select().from(loans).where(eq(loans.operatorId, operator.id))).toEqual([]);
    expect((await inbox(manager.actor.userId, "loan_request")).some((n) => n.body.includes("₦25,000"))).toBe(true);
    expect((await listLoanRequests(manager)).waiting.map((r) => r.id)).toContain(request!.id);
    expect((await waitingLoanRequests()).count).toBeGreaterThan(0);
  });

  it("is the only way for the Assistant Manager: giving and cancelling are refused", async () => {
    const operator = await makeOperator(manager);
    await expect(grantLoan(assistant, { operatorId: operator.id, amount: "10,000", source: "bank" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const loan = await grantLoan(manager, { operatorId: operator.id, amount: "10,000", source: "bank" });
    await expect(cancelLoan(assistant, loan!.id, { reason: "Mistake" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestLoan(manager, { operatorId: operator.id, amount: "1,000", reason: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("refuses a second waiting request, and a request for an operator who owes a loan", async () => {
    const operator = await makeOperator(manager);
    await requestLoan(assistant, { operatorId: operator.id, amount: "5,000", reason: "School fees" });
    await expect(
      requestLoan(otherAssistant, { operatorId: operator.id, amount: "6,000", reason: "Rent" }),
    ).rejects.toMatchObject({ fieldErrors: { operatorId: expect.stringMatching(/already waiting/) } });

    const owing = await makeOperator(manager);
    await grantLoan(manager, { operatorId: owing.id, amount: "5,000", source: "bank" });
    await expect(requestLoan(assistant, { operatorId: owing.id, amount: "5,000", reason: "More" })).rejects.toMatchObject({
      fieldErrors: { operatorId: expect.stringMatching(/already has a loan/) },
    });
  });
});

describe("the Manager deciding", () => {
  it("approves: pays from the chosen source, the operator owes it, and the asker is told", async () => {
    const operator = await makeOperator(manager);
    const request = await requestLoan(assistant, { operatorId: operator.id, amount: "30,000", reason: "Rent" });
    // Lowering is allowed, raising is not.
    await expect(approveLoanRequest(manager, request!.id, { amount: "40,000", source: "bank" })).rejects.toMatchObject({
      fieldErrors: { amount: expect.anything() },
    });
    const loan = await approveLoanRequest(manager, request!.id, { amount: "20,000", source: "bank" });

    expect(await loanCharges(operator.id)).toMatchObject([{ amountKobo: 2_000_000 }]);
    const detail = await getLoan(manager, loan!.id);
    expect(detail!.loan).toMatchObject({ requestedByName: assistant.actor.name, approvedByName: manager.actor.name });
    const answers = await inbox(assistant.actor.userId, "loan_request_answered");
    expect(answers.some((n) => n.body.startsWith("Approved: ₦20,000") && n.body.includes("₦30,000"))).toBe(true);
    expect((await inbox(otherAssistant.actor.userId, "loan_request_answered")).length).toBe(0);

    const mine = await listLoanRequests(assistant);
    expect(mine.answered.find((r) => r.id === request!.id)).toMatchObject({ status: "approved", givenKobo: 2_000_000 });
    await expect(approveLoanRequest(manager, request!.id, { source: "bank" })).rejects.toThrow(/already been approved/);
  });

  it("rejects with a reason, moving no money, and tells the asker why", async () => {
    const operator = await makeOperator(manager);
    const request = await requestLoan(assistant, { operatorId: operator.id, amount: "15,000", reason: "Phone" });
    await expect(rejectLoanRequest(manager, request!.id, {})).rejects.toMatchObject({
      fieldErrors: { rejectReason: expect.anything() },
    });
    await rejectLoanRequest(manager, request!.id, { rejectReason: "Owes too many days" });
    expect(await loanCharges(operator.id)).toEqual([]);
    const answers = await inbox(assistant.actor.userId, "loan_request_answered");
    expect(answers.some((n) => n.body.includes("Owes too many days"))).toBe(true);
    // A new request can follow once the first is decided.
    await requestLoan(assistant, { operatorId: operator.id, amount: "5,000", reason: "Smaller" });
  });

  it("refuses to approve once the operator has left or already has a loan", async () => {
    const leaving = await makeOperator(manager);
    const left = await requestLoan(assistant, { operatorId: leaving.id, amount: "5,000", reason: "Travel" });
    await markOperatorLeft(manager, leaving.id, { reason: "Moved" });
    await expect(approveLoanRequest(manager, left!.id, { source: "bank" })).rejects.toThrow(/no longer working/);

    const busy = await makeOperator(manager);
    const asked = await requestLoan(assistant, { operatorId: busy.id, amount: "5,000", reason: "Travel" });
    await grantLoan(manager, { operatorId: busy.id, amount: "3,000", source: "bank" });
    await expect(approveLoanRequest(manager, asked!.id, { source: "bank" })).rejects.toThrow(/already has a loan/);
  });

  it("lets only the asker withdraw a waiting request", async () => {
    const operator = await makeOperator(manager);
    const request = await requestLoan(assistant, { operatorId: operator.id, amount: "5,000", reason: "Food" });
    await expect(withdrawLoanRequest(otherAssistant, request!.id)).rejects.toThrow(/person who asked/);
    await withdrawLoanRequest(assistant, request!.id);
    await expect(withdrawLoanRequest(assistant, request!.id)).rejects.toThrow(/already been withdrawn/);
    await expect(approveLoanRequest(manager, request!.id, { source: "bank" })).rejects.toThrow(/already been withdrawn/);
  });
});
