"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { systemClock } from "@/lib/clock";
import { DomainError } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { clearSession, clientIp, requireCtx, setSessionCookie } from "@/lib/session";
import { changeIssueDate, changeTricycleBalance, issueTricycle, returnTricycle } from "@/services/assignments";
import { login } from "@/services/auth";
import type { Ctx } from "@/services/context";
import { clearSackingAlert, confirmSacking, reinstateOperator } from "@/services/dismissals";
import { confirmBankDeposit, confirmBankPayment, recordReconciliation, setOpeningBalance } from "@/services/bank";
import { recordDeposit, reverseDeposit } from "@/services/deposits";
import { addNonCollectionDay, checkCashClose, closeCash, removeNonCollectionDay } from "@/services/finance";
import { markMyNoticesRead } from "@/services/notices";
import { markAllRead, openNotification } from "@/services/notifications";
import { isStaff } from "@/lib/permissions";
import { isAppLink } from "@/lib/notification-catalogue";
import { acceptTransfer, createTransfer, rejectTransfer, voidTransfer } from "@/services/transfers";
import {
  addExpenseLine,
  cancelAdvance,
  countersignAdvance,
  correctExpense,
  createAdvance,
  recordExpense,
  removeExpense,
  sendBackAdvance,
  submitAdvance,
  voidExpenseLine,
} from "@/services/expenses";
import { approveAward, rejectAward } from "@/services/awards";
import { cancelLoan, grantLoan } from "@/services/loans";
import { recordPayment, reversePayment } from "@/services/payments";
import { changeRuleAmount } from "@/services/rules";
import {
  adjustStock,
  createStockItem,
  takeOutItems,
  receiveStock,
  returnPart,
  updateStockItem,
} from "@/services/store";
import {
  cancelWorkOrder,
  checkInService,
  completeWorkOrder,
  reportFault,
  rescheduleService,
} from "@/services/workshop";
import {
  cancelMeeting,
  closeMeeting,
  markRemainingAbsent,
  recordAttendance,
  scheduleMeeting,
} from "@/services/meetings";
import { confirmViolation, raiseLateWork, rejectViolation, waiveViolation } from "@/services/violations";
import { createOperator, markOperatorLeft, updateOperator } from "@/services/operators";
import { createTricycle, retireTricycle, updateTricycle } from "@/services/tricycles";
import {
  changeOwnPassword,
  createStaff,
  resetStaffPassword,
  setOperatorPin,
  setStaffStatus,
} from "@/services/users";

const values = (data: FormData) => Object.fromEntries(data);

const toState = (error: unknown): FormState => {
  if (error instanceof DomainError) {
    return { error: error.message, fieldErrors: error.fieldErrors };
  }
  throw error;
};

/** Runs a change for the logged-in user and refreshes the screens. */
async function perform(work: (ctx: Ctx) => Promise<unknown>, message: string): Promise<FormState> {
  const ctx = await requireCtx();
  try {
    await work(ctx);
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/", "layout");
  return { ok: true, message };
}

export async function loginAction(_: FormState, data: FormData): Promise<FormState> {
  let role: string;
  try {
    const result = await login(
      {
        phone: String(data.get("phone") ?? ""),
        secret: String(data.get("secret") ?? ""),
        ip: await clientIp(),
      },
      systemClock,
    );
    await setSessionCookie(result.token);
    role = result.role;
  } catch (error) {
    return toState(error);
  }
  redirect(role === "operator" ? "/me" : "/dashboard");
}

export async function logoutAction() {
  await clearSession();
  redirect("/login");
}

export async function createTricycleAction(_: FormState, data: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  let id: string;
  try {
    id = (await createTricycle(ctx, values(data)))!.id;
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/", "layout");
  redirect(`/tricycles/${id}`);
}

export async function updateTricycleAction(id: string, _: FormState, data: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  try {
    await updateTricycle(ctx, id, values(data));
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/", "layout");
  redirect(`/tricycles/${id}`);
}

export async function retireTricycleAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => retireTricycle(ctx, id, values(data)), "Tricycle retired.");
}

export async function createOperatorAction(_: FormState, data: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  let id: string;
  try {
    id = (await createOperator(ctx, values(data)))!.id;
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/", "layout");
  redirect(`/operators/${id}`);
}

export async function updateOperatorAction(id: string, _: FormState, data: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  try {
    await updateOperator(ctx, id, values(data));
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/", "layout");
  redirect(`/operators/${id}`);
}

export async function markOperatorLeftAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => markOperatorLeft(ctx, id, values(data)), "Operator marked as left.");
}

export async function setOperatorPinAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => setOperatorPin(ctx, id, values(data)), "Portal PIN saved.");
}

export async function issueTricycleAction(_: FormState, data: FormData) {
  return perform((ctx) => issueTricycle(ctx, values(data)), "Tricycle issued.");
}

export async function returnTricycleAction(assignmentId: string, _: FormState, data: FormData) {
  return perform((ctx) => returnTricycle(ctx, assignmentId, values(data)), "Tricycle returned.");
}

export async function changeIssueDateAction(assignmentId: string, _: FormState, data: FormData) {
  return perform((ctx) => changeIssueDate(ctx, assignmentId, values(data)), "Date issued changed.");
}

export async function changeTricycleBalanceAction(tricycleId: string, _: FormState, data: FormData) {
  return perform((ctx) => changeTricycleBalance(ctx, tricycleId, values(data)), "Daily balance saved.");
}

export async function createStaffAction(_: FormState, data: FormData) {
  return perform((ctx) => createStaff(ctx, values(data)), "Staff login created.");
}

export async function setStaffStatusAction(
  id: string,
  status: "active" | "disabled",
  _: FormState,
) {
  return perform((ctx) => setStaffStatus(ctx, id, status), "Login updated.");
}

export async function resetStaffPasswordAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => resetStaffPassword(ctx, id, values(data)), "Password reset.");
}

export async function changePasswordAction(_: FormState, data: FormData) {
  return perform((ctx) => changeOwnPassword(ctx, values(data)), "Password changed.");
}

export async function recordPaymentAction(_: FormState, data: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  let id: string;
  try {
    id = (await recordPayment(ctx, values(data))).id;
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/", "layout");
  redirect(`/payments/${id}`);
}

export async function reversePaymentAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => reversePayment(ctx, id, values(data)), "Payment reversed.");
}

export async function recordDepositAction(_: FormState, data: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  let id: string;
  try {
    id = (await recordDeposit(ctx, values(data))).id;
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/", "layout");
  redirect(`/deposits/${id}`);
}

export async function reverseDepositAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => reverseDeposit(ctx, id, values(data)), "Deposit reversed.");
}

export async function closeCashAction(_: FormState, data: FormData) {
  return perform((ctx) => closeCash(ctx, values(data)), "Cash closed.");
}

export async function confirmViolationAction(id: string, _: FormState) {
  return perform((ctx) => confirmViolation(ctx, id), "Offence confirmed and fine added.");
}

export async function rejectViolationAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => rejectViolation(ctx, id, values(data)), "Offence rejected.");
}

export async function waiveViolationAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => waiveViolation(ctx, id, values(data)), "Fine waived.");
}

export async function confirmSackingAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => confirmSacking(ctx, id, values(data)), "Sacking confirmed. The tricycle has been taken back and can be issued again once any repair is finished.");
}

export async function clearSackingAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => clearSackingAlert(ctx, id, values(data)), "Alert closed.");
}

export async function reinstateAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => reinstateOperator(ctx, id, values(data)), "Operator reinstated.");
}

export async function addNoBalanceDayAction(_: FormState, data: FormData) {
  return perform((ctx) => addNonCollectionDay(ctx, values(data)), "Date added.");
}

export async function removeNoBalanceDayAction(date: string, _: FormState) {
  return perform((ctx) => removeNonCollectionDay(ctx, date), "Date removed.");
}

export async function raiseLateWorkAction(_: FormState, data: FormData) {
  return perform((ctx) => raiseLateWork(ctx, values(data)), "Offence recorded. Someone else must confirm it.");
}

export async function changeRuleAction(_: FormState, data: FormData) {
  return perform((ctx) => changeRuleAmount(ctx, values(data)), "New fine saved.");
}

export async function scheduleMeetingAction(_: FormState, data: FormData) {
  return perform((ctx) => scheduleMeeting(ctx, values(data)), "Meeting scheduled.");
}

export async function cancelMeetingAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => cancelMeeting(ctx, id, values(data)), "Meeting cancelled.");
}

export async function attendanceAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => recordAttendance(ctx, id, values(data)), "");
}

export async function markAbsentAction(id: string, _: FormState) {
  return perform((ctx) => markRemainingAbsent(ctx, id), "");
}

export async function closeMeetingAction(id: string, _: FormState) {
  return perform((ctx) => closeMeeting(ctx, id), "Meeting closed. Any offences are waiting to be confirmed.");
}

export async function reportFaultAction(_: FormState, data: FormData) {
  let id: string | undefined;
  const state = await perform(async (ctx) => {
    id = (await reportFault(ctx, values(data)))?.id;
  }, "");
  if (!id) return state;
  redirect(`/workshop/${id}`);
}

export async function checkInServiceAction(id: string, _: FormState) {
  return perform((ctx) => checkInService(ctx, id), "Checked in.");
}

export async function rescheduleServiceAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => rescheduleService(ctx, id, values(data)), "Service moved.");
}

export async function completeWorkOrderAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => completeWorkOrder(ctx, id, values(data)), "Work completed.");
}

export async function cancelWorkOrderAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => cancelWorkOrder(ctx, id, values(data)), "Work order cancelled.");
}

export async function takeOutItemsAction(_: FormState, data: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  let workOrderId: string;
  try {
    workOrderId = (await takeOutItems(ctx, values(data))).workOrderId;
  } catch (error) {
    return toState(error);
  }
  revalidatePath("/", "layout");
  redirect(`/workshop/${workOrderId}?taken=1`);
}

export async function returnPartAction(id: string, _: FormState) {
  return perform((ctx) => returnPart(ctx, id), "Part returned to the store.");
}

export async function createStockItemAction(_: FormState, data: FormData) {
  return perform((ctx) => createStockItem(ctx, values(data)), "Item added to the store.");
}

export async function receiveStockAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => receiveStock(ctx, id, values(data)), "Stock received.");
}

export async function updateStockItemAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => updateStockItem(ctx, id, values(data)), "Item saved.");
}

export async function adjustStockAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => adjustStock(ctx, id, values(data)), "Stock count saved.");
}

/* ---------- Expenses and loans ---------- */

export async function createAdvanceAction(_: FormState, data: FormData) {
  return perform((ctx) => createAdvance(ctx, values(data)), "Expense funds recorded.");
}

export async function recordExpenseAction(_: FormState, data: FormData) {
  let id: string | undefined;
  const state = await perform(async (ctx) => {
    id = (await recordExpense(ctx, values(data)))?.id;
  }, "");
  if (!id) return state;
  redirect(`/expenses/${id}?recorded=1`);
}

export async function correctExpenseAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => correctExpense(ctx, id, values(data)), "Corrected.");
}

export async function removeExpenseAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => removeExpense(ctx, id, values(data)), "Removed and the money put back on the balance.");
}

export async function addExpenseLineAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => addExpenseLine(ctx, id, values(data)), "Saved.");
}

export async function voidExpenseLineAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => voidExpenseLine(ctx, id, values(data)), "Entry removed.");
}

export async function submitAdvanceAction(id: string) {
  return perform((ctx) => submitAdvance(ctx, id), "Sent for countersign.");
}

export async function countersignAdvanceAction(id: string) {
  return perform((ctx) => countersignAdvance(ctx, id), "Approved. It is now final.");
}

export async function sendBackAdvanceAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => sendBackAdvance(ctx, id, values(data)), "Sent back for correcting.");
}

export async function cancelAdvanceAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => cancelAdvance(ctx, id, values(data)), "Cancelled and the money put back.");
}

export async function grantLoanAction(_: FormState, data: FormData) {
  return perform((ctx) => grantLoan(ctx, values(data)), "Loan recorded.");
}

export async function cancelLoanAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => cancelLoan(ctx, id, values(data)), "Loan cancelled and the money put back.");
}

export async function approveAwardAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => approveAward(ctx, id, values(data)), "Award approved.");
}

export async function rejectAwardAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => rejectAward(ctx, id, values(data)), "Award rejected.");
}

export async function checkCashCloseAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => checkCashClose(ctx, id, values(data)), "Count checked.");
}

export async function createTransferAction(_: FormState, data: FormData) {
  return perform((ctx) => createTransfer(ctx, values(data)), "Saved.");
}

export async function acceptTransferAction(id: string, _state: FormState, _data: FormData) {
  return perform((ctx) => acceptTransfer(ctx, id), "Handover accepted.");
}

export async function rejectTransferAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => rejectTransfer(ctx, id, values(data)), "Handover refused.");
}

export async function voidTransferAction(id: string, _: FormState, data: FormData) {
  return perform((ctx) => voidTransfer(ctx, id, values(data)), "Move reversed.");
}

export async function confirmBankDepositAction(id: string, _state: FormState, _data: FormData) {
  return perform((ctx) => confirmBankDeposit(ctx, id), "Confirmed.");
}

export async function confirmBankPaymentAction(id: string, _state: FormState, _data: FormData) {
  return perform((ctx) => confirmBankPayment(ctx, id), "Confirmed.");
}

export async function setOpeningBalanceAction(_: FormState, data: FormData) {
  return perform((ctx) => setOpeningBalance(ctx, values(data)), "Opening balance saved.");
}

export async function recordReconciliationAction(_: FormState, data: FormData) {
  return perform((ctx) => recordReconciliation(ctx, values(data)), "Reconciliation saved.");
}

export async function markNoticesReadAction(_state: FormState, _data: FormData) {
  return perform((ctx) => markMyNoticesRead(ctx), "Marked as read.");
}

export async function markAllNotificationsReadAction(_state: FormState, _data: FormData) {
  return perform((ctx) => markAllRead(ctx), "All marked as read.");
}

/** Marks a notification read and goes where it leads. */
export async function openNotificationAction(id: string) {
  const ctx = await requireCtx();
  const inbox = isStaff(ctx.actor.role) ? "/notifications" : "/me/notifications";
  let link: string | null = null;
  try {
    ({ link } = await openNotification(ctx, id));
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  revalidatePath("/", "layout");
  // Checked again here, so a bad link saved by any route can never send someone off Jayngol.
  redirect(link && isAppLink(link) ? link : inbox);
}
