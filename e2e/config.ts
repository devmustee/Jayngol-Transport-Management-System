export const AUDIT_DATABASE = "jayngol_audit";
export const SOURCE_DATABASE = "jayngol_sample";
export const DATABASE_URL = `postgres://localhost:5432/${AUDIT_DATABASE}`;
export const BASE_URL = "http://localhost:3200";
export const OWNER_PHONE = "+2348000001900";
export const WIDTHS = [320, 375, 768, 1024, 1440] as const;
/** Widths held to the phone tap-target rule. */
export const PHONE_WIDTH_LIMIT = 768;
export const MIN_TAP_HEIGHT = 44;

export const STAFF_ROLES = ["owner", "manager", "assistant_manager", "supervisor"] as const;
export type AuditRole = (typeof STAFF_ROLES)[number] | "operator";
export const statePath = (role: AuditRole) => `e2e/.auth/${role}.json`;
export const idsPath = "e2e/.auth/ids.json";
export const resultsPath = "e2e/results/audit.json";

/** Every staff page. `:name` values are filled from the audit database. */
export const STAFF_ROUTES = [
  "/dashboard", "/account", "/tricycles", "/tricycles/new", "/tricycles/:tricycle", "/tricycles/:tricycle/edit",
  "/operators", "/operators/new", "/operators/:operator", "/operators/:operator/edit", "/operators/:operator/statement",
  "/money", "/payments", "/payments/new", "/payments/:payment", "/cash", "/arrears", "/no-balance-days", "/sacking",
  "/inspections", "/inspections/report", "/offences", "/offences/late-work", "/meetings", "/meetings/:meeting", "/rules",
  "/workshop", "/workshop/new", "/workshop/history", "/workshop/:workOrder",
  "/store", "/store/usage", "/store/:item", "/users", "/audit",
] as const;
