import type { Metadata } from "next";
import { Empty, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listAudit } from "@/services/audit";

export const metadata: Metadata = { title: "Audit log" };

const ACTIONS: Record<string, string> = {
  "cash.check": "Checked a cash count",
  "money.transfer": "Moved money",
  "money.accept": "Accepted a cash handover",
  "money.reject": "Refused a cash handover",
  "money.void": "Reversed a money move",
  "bank.confirm": "Confirmed a payment against the bank",
  "bank.opening": "Set the opening bank balance",
  "bank.reconcile": "Reconciled the bank",
  "award.propose": "Proposed an award",
  "award.approve": "Approved an award",
  "award.reject": "Rejected an award",
  "expense.advance": "Collected expense funds",
  "expense.line": "Recorded an expense",
  "expense.line_void": "Corrected an expense entry",
  "expense.submit": "Sent expenses for countersign",
  "expense.countersign": "Countersigned expenses",
  "expense.send_back": "Sent expenses back",
  "expense.cancel": "Cancelled expense funds",
  "loan.grant": "Gave a loan",
  "loan.cancel": "Cancelled a loan",
  "auth.login": "Logged in",
  "auth.locked": "Login locked after wrong attempts",
  "user.create": "Created a staff login",
  "user.status": "Changed a login's status",
  "user.reset_password": "Reset a password",
  "user.change_password": "Changed own password",
  "operator.create": "Added an operator",
  "operator.update": "Edited an operator",
  "operator.left": "Marked an operator as left",
  "operator.set_pin": "Set an operator's PIN",
  "tricycle.create": "Added a tricycle",
  "tricycle.update": "Edited a tricycle",
  "tricycle.retire": "Retired a tricycle",
  "assignment.issue": "Issued a tricycle",
  "assignment.return": "Returned a tricycle",
  "assignment.change_rate": "Changed a daily balance",
  "payment.record": "Recorded a payment",
  "payment.record_backdated": "Recorded a backdated payment",
  "payment.reverse": "Reversed a payment",
  "cash.close": "Closed cash",
  "violation.auto_fine": "Late-balance fine added",
  "violation.propose": "Raised an offence",
  "violation.confirm": "Confirmed an offence",
  "violation.reject": "Rejected an offence",
  "violation.waive": "Waived a fine",
  "inspection.record": "Recorded an inspection",
  "meeting.schedule": "Scheduled a meeting",
  "meeting.cancel": "Cancelled a meeting",
  "meeting.attendance": "Marked meeting attendance",
  "meeting.excuse": "Excused a meeting absence",
  "meeting.mark_absent": "Marked remaining operators absent",
  "meeting.close": "Closed a meeting",
  "rule.change": "Changed a fine amount",
  "workorder.fault": "Took a tricycle in for repair",
  "workorder.checkin": "Checked in a service",
  "workorder.reschedule": "Moved a service date",
  "workorder.complete": "Completed workshop work",
  "workorder.cancel": "Cancelled a work order",
  "stock.item_create": "Added a store item",
  "stock.reorder_level": "Changed a reorder level",
  "stock.receive": "Received stock",
  "stock.issue": "Issued a part",
  "stock.return": "Returned a part to the store",
  "stock.adjust": "Adjusted stock after a count",
  "dismissal.flagged": "Sacking alert raised",
  "dismissal.confirm": "Confirmed a sacking",
  "dismissal.clear": "Gave an operator more time",
  "dismissal.reinstate": "Reinstated an operator",
  "calendar.add": "Added a no-balance day",
  "calendar.remove": "Removed a no-balance day",
};

export default async function AuditPage() {
  const ctx = await requirePage("audit.view");
  const rows = await listAudit(ctx);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Latest 200 actions. This record cannot be changed." />
      {rows.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {rows.map((row) => (
            <li key={row.id} className="p-3">
              <div className="font-semibold">{ACTIONS[row.action] ?? row.action}</div>
              <div className="text-sm text-muted">
                {row.actorName ?? "System"}
                {row.actorRole ? ` (${ROLE_LABELS[row.actorRole]})` : ""} · {formatDateTime(row.occurredAt)}
              </div>
              {row.reason ? <div className="mt-1 text-sm">{row.reason}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
