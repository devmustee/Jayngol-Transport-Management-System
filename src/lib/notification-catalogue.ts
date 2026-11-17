import type { Permission } from "./permissions";

/**
 * Every kind of notification, with its severity, title and default link. A
 * feature names the kind and the facts; the catalogue decides how it reads.
 * drizzle/0022 used these same titles when it moved old operator notices.
 *
 * Staff audiences are permissions, never role names, so they follow any change
 * to the permission matrix (NOTIFICATION_PLAN.md section 3.2).
 */
export type Severity = "info" | "action" | "critical";

export type CatalogueEntry = {
  severity: Severity;
  title: string;
  /** Where the notification opens. Operators always land in their portal. */
  link: string;
  /** Who it is for: operators, or staff holding this permission (or any of these). */
  audience: "operator" | { permission: Permission | readonly Permission[] };
};

const staffNotice = (
  severity: Severity,
  title: string,
  link: string,
  permission: Permission | readonly Permission[],
): CatalogueEntry => ({ severity, title, link, audience: { permission } });

const operatorNotice = (severity: Severity, title: string): CatalogueEntry => ({
  severity,
  title,
  link: "/me",
  audience: "operator",
});

export const CATALOGUE = {
  receipt: operatorNotice("info", "Payment received"),
  offence: operatorNotice("action", "Offence recorded"),
  meeting_notice: operatorNotice("action", "Meeting"),
  award: operatorNotice("info", "Award"),
  milestone: operatorNotice("info", "Milestone reached"),
  run_ended: operatorNotice("info", "Your run has ended"),
  award_near: operatorNotice("info", "Close to an award"),
  balance_reminder: operatorNotice("action", "Balance due today"),
  late_fine: operatorNotice("action", "Late balance fine"),
  service_reminder: operatorNotice("action", "Service tomorrow"),
  balance_changed: operatorNotice("action", "Daily balance changed"),
  contribution_due: operatorNotice("action", "Contribution due Sunday"),
  contribution_unpaid: operatorNotice("action", "Contribution unpaid"),
  balance_waived: operatorNotice("info", "Balance waived"),
  balance_waiver: {
    severity: "info",
    title: "Balance waived by the Manager",
    link: "/waivers",
    audience: { permission: "balance.waive.oversee" },
  },
  large_expense: {
    severity: "info",
    title: "Large expense by the Manager",
    link: "/expenses",
    audience: { permission: "expense.oversee" },
  },
  // Staff events (STAFF_NOTIFICATIONS_PLAN.md section 4.1). The person who
  // caused an event is never told of it.
  payment_reversed: staffNotice("action", "Payment reversed", "/payments", "payment.oversee"),
  payment_backdated: staffNotice("action", "Payment backdated", "/payments", "payment.oversee"),
  sacking_flagged: staffNotice("critical", "Operator reached 5 unpaid days", "/sacking", ["dismissal.decide", "dismissal.oversee"]),
  offence_raised: staffNotice("action", "Offence to confirm", "/offences?status=proposed", "violation.confirm"),
  offence_decided: staffNotice("info", "Offence decided", "/offences", "violation.raise"),
  handover_sent: staffNotice("action", "Cash handover to accept", "/transfers", "money.transfer"),
  handover_rejected: staffNotice("action", "Cash handover refused", "/transfers", "money.transfer"),
  cash_difference: staffNotice("critical", "Cash count does not match", "/cash", "cash.oversee"),
  expense_submitted: staffNotice("action", "Expenses to countersign", "/expenses", "expense.countersign"),
  expense_sent_back: staffNotice("action", "Expenses sent back", "/expenses", "expense.record"),
  expense_countersigned: staffNotice("info", "Expenses countersigned", "/expenses", "expense.record"),
  awards_proposed: staffNotice("action", "Awards to decide", "/awards", "award.approve"),
  stock_low: staffNotice("action", "Stock below reorder level", "/store", "stock.move"),
  account_locked: staffNotice("critical", "Staff account locked", "/users", "user.manage"),
} as const satisfies Record<string, CatalogueEntry>;

export type NotificationKind = keyof typeof CATALOGUE;

/**
 * A page inside Jayngol. "//site" and "/\site" are refused because browsers
 * treat both as another website, and so is any space, control character or
 * backslash. The database checks the same rule (notification_link_inside_app).
 */
// eslint-disable-next-line no-control-regex
export const isAppLink = (link: string): boolean => /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(link);

export const isNotificationKind =(kind: string): kind is NotificationKind => Object.hasOwn(CATALOGUE, kind);
