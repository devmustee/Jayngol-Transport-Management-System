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
  /** Who it is for: operators, or staff holding this permission. */
  audience: "operator" | { permission: Permission };
};

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
  large_expense: {
    severity: "info",
    title: "Large expense by the Manager",
    link: "/expenses",
    audience: { permission: "expense.oversee" },
  },
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
