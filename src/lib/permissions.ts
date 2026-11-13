export type Role =
  | "owner"
  | "manager"
  | "assistant_manager"
  | "supervisor"
  | "operator";

const STAFF: readonly Role[] = ["owner", "manager", "assistant_manager", "supervisor"];
const OFFICE: readonly Role[] = ["manager", "assistant_manager"];
const FIELD: readonly Role[] = ["manager", "assistant_manager", "supervisor"];

/**
 * Who may do what (DEVELOPMENT_PLAN.md section 5). The owner appears only on
 * view permissions and on checking cash counts, which keeps that login read-only
 * apart from being a second pair of eyes on the cash.
 */
const MATRIX = {
  "dashboard.view": STAFF,
  "tricycle.view": STAFF,
  "tricycle.manage": OFFICE,
  "operator.view": STAFF,
  "operator.manage": OFFICE,
  "operator.viewSensitive": ["owner", "manager", "assistant_manager"],
  "assignment.manage": OFFICE,
  "rate.change": ["manager"],
  "user.manage": ["manager"],
  "audit.view": ["owner", "manager"],
  "portal.viewOwn": ["operator"],
  "payment.record": OFFICE,
  "payment.reverse": ["manager"],
  "payment.backdate": ["manager"],
  "finance.view": ["owner", "manager", "assistant_manager"],
  "cash.close": OFFICE,
  // A second person recounts each close. The Owner may too, mostly for the Manager's weekly count.
  "cash.check": ["owner", "manager", "assistant_manager"],
  "money.transfer": OFFICE,
  "bank.reconcile": OFFICE,
  "bank.opening": ["manager"],
  // The Manager's own expenses need no approval; the Assistant Manager's wait for the Manager.
  "expense.record": OFFICE,
  "expense.countersign": ["manager"],
  // Told about the Manager's large expenses, which nobody approves.
  "expense.oversee": ["owner"],
  "loan.approve": ["manager"],
  "award.approve": ["manager"],
  "awards.track": STAFF,
  "violation.view": STAFF,
  "violation.raise": FIELD,
  "violation.confirm": OFFICE,
  "inspection.record": FIELD,
  "inspection.report": ["owner", "manager", "assistant_manager", "supervisor"],
  "meeting.view": STAFF,
  "meeting.schedule": ["manager"],
  "meeting.attendance": FIELD,
  "meeting.excuse": ["manager"],
  "rule.manage": ["manager"],
  "violation.waive": ["manager"],
  "workorder.view": STAFF,
  "workorder.checkin": FIELD,
  "workorder.manage": OFFICE,
  "workorder.cost": ["owner", "manager", "assistant_manager"],
  "stock.view": ["owner", "manager", "assistant_manager"],
  "stock.move": OFFICE,
  "stock.adjust": ["manager"],
  "dismissal.decide": ["manager"],
  "calendar.manage": ["manager"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof MATRIX;

export function can(role: Role, permission: Permission): boolean {
  return (MATRIX[permission] as readonly Role[]).includes(role);
}

export const isStaff = (role: Role) => STAFF.includes(role);

/** Every role holding a permission, for reaching staff by what they can do. */
export const rolesWith = (permission: Permission): Role[] => [...(MATRIX[permission] as readonly Role[])];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  assistant_manager: "Assistant Manager",
  supervisor: "Supervisor",
  operator: "Operator",
};
