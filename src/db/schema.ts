import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", [
  "owner",
  "manager",
  "assistant_manager",
  "supervisor",
  "operator",
]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const operatorStatus = pgEnum("operator_status", ["active", "sacked", "left"]);
export const tricycleStatus = pgEnum("tricycle_status", [
  "in_stock",
  "issued",
  "off_road",
  "retired",
]);
export const serviceInterval = pgEnum("service_interval", ["fortnightly", "monthly"]);
export const returnReason = pgEnum("return_reason", [
  "reassigned",
  "operator_left",
  "tricycle_retired",
  "sacked",
  "other",
]);
export const chargeType = pgEnum("charge_type", ["daily_balance", "penalty", "loan"]);
export const paymentMethod = pgEnum("payment_method", ["cash", "transfer", "pos"]);
/**
 * What a payment is for. A day's balance pays that one day; older payments
 * (before this was recorded) are "general" and pay the oldest days first.
 */
export const paymentPurpose = pgEnum("payment_purpose", [
  "day_balance",
  "old_balance",
  "fine",
  "loan",
  "general",
]);
export const violationStatus = pgEnum("violation_status", [
  "proposed",
  "confirmed",
  "rejected",
  "waived",
]);
export const dismissalStatus = pgEnum("dismissal_status", [
  "flagged",
  "resolved",
  "confirmed",
  "reinstated",
]);
export const lateOutcome = pgEnum("late_outcome", ["on_time", "fined", "capped"]);
export const smsStatus = pgEnum("sms_status", ["pending", "sent", "failed"]);
export const meetingStatus = pgEnum("meeting_status", ["scheduled", "closed", "cancelled"]);
export const attendanceStatus = pgEnum("attendance_status", [
  "present_with_tricycle",
  "present_without_tricycle",
  "absent",
  "excused",
]);

export const workOrderType = pgEnum("work_order_type", ["service", "maintenance"]);
export const workOrderStatus = pgEnum("work_order_status", [
  "scheduled",
  "checked_in",
  "completed",
  "missed",
  "cancelled",
]);
export const stockMovementKind = pgEnum("stock_movement_kind", [
  "received",
  "issued",
  "returned",
  "adjusted",
]);

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const tz = { withTimezone: true, mode: "date" } as const;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique("users_phone_unique"),
  role: userRole("role").notNull(),
  status: userStatus("status").notNull().default("active"),
  credentialHash: text("credential_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", tz),
  lastLoginAt: timestamp("last_login_at", tz),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", tz).notNull(),
    lastSeenAt: timestamp("last_seen_at", tz).notNull(),
    expiresAt: timestamp("expires_at", tz).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const loginFailures = pgTable(
  "login_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ip: text("ip").notNull(),
    at: timestamp("at", tz).notNull(),
  },
  (t) => [index("login_failures_ip_at_idx").on(t.ip, t.at)],
);

export const operators = pgTable("operators", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique("operators_phone_unique"),
  address: text("address"),
  licenceNumber: text("licence_number"),
  guarantorName: text("guarantor_name"),
  guarantorPhone: text("guarantor_phone"),
  guarantorAddress: text("guarantor_address"),
  status: operatorStatus("status").notNull().default("active"),
  userId: uuid("user_id")
    .references(() => users.id)
    .unique("operators_user_unique"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

export const tricycles = pgTable(
  "tricycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationNumber: text("registration_number")
      .notNull()
      .unique("tricycles_registration_unique"),
    codeNumber: text("code_number").notNull().unique("tricycles_code_unique"),
    chassisNumber: text("chassis_number"),
    engineNumber: text("engine_number"),
    purchasedOn: date("purchased_on", { mode: "string" }).notNull(),
    purchaseCostKobo: bigint("purchase_cost_kobo", { mode: "number" }),
    serviceInterval: serviceInterval("service_interval").notNull(),
    serviceCycleStart: date("service_cycle_start", { mode: "string" }).notNull(),
    status: tricycleStatus("status").notNull().default("in_stock"),
    retiredReason: text("retired_reason"),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tricycles_chassis_unique")
      .on(t.chassisNumber)
      .where(sql`${t.chassisNumber} IS NOT NULL`),
    check("tricycles_cost_not_negative", sql`${t.purchaseCostKobo} >= 0`),
  ],
);

// Overlap protection lives in drizzle/0001_constraints.sql: Drizzle cannot
// express the two EXCLUDE constraints that make double-issuing impossible.
export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tricycleId: uuid("tricycle_id")
      .notNull()
      .references(() => tricycles.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    returnedOn: date("returned_on", { mode: "string" }),
    returnReason: returnReason("return_reason"),
    returnNote: text("return_note"),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id),
    returnedBy: uuid("returned_by").references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    index("assignments_tricycle_idx").on(t.tricycleId),
    index("assignments_operator_idx").on(t.operatorId),
    check(
      "assignments_return_after_issue",
      sql`${t.returnedOn} IS NULL OR ${t.returnedOn} >= ${t.issuedOn}`,
    ),
  ],
);

// Append-only. The rate for a date is the row with the latest effective_from
// on or before that date; among equal dates the most recently created wins,
// which is how a mistyped rate is corrected without editing history.
export const balanceRates = pgTable(
  "balance_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    index("balance_rates_lookup_idx").on(t.assignmentId, t.effectiveFrom),
    check("balance_rates_positive", sql`${t.amountKobo} > 0`),
  ],
);

// Each tricycle's daily balance and when each amount starts. The amount on a
// date is the newest row starting on or before it. A tricycle with no row has
// no balance set and cannot be issued. Append-only (drizzle/0025).
export const tricycleBalances = pgTable(
  "tricycle_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tricycleId: uuid("tricycle_id")
      .notNull()
      .references(() => tricycles.id),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    index("tricycle_balances_lookup_idx").on(t.tricycleId, t.effectiveFrom),
    check("tricycle_balances_positive", sql`${t.amountKobo} > 0`),
  ],
);

// Append-only, enforced by triggers in drizzle/0001_constraints.sql.
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorRole: userRole("actor_role"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", tz).notNull(),
  },
  (t) => [
    index("audit_entity_idx").on(t.entityType, t.entityId),
    index("audit_occurred_idx").on(t.occurredAt),
  ],
);

// charges, charge_voids, payments, payment_reversals, payment_allocations,
// cash_movements and cash_closes are append-only (drizzle/0003). A correction
// is always a new void or reversal row, never an edit.
export const charges = pgTable(
  "charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: chargeType("type").notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    tricycleId: uuid("tricycle_id").references(() => tricycles.id),
    assignmentId: uuid("assignment_id").references(() => assignments.id),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    /** Last date a daily balance can be paid without a fine. */
    dueOn: date("due_on", { mode: "string" }),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("one_daily_balance")
      .on(t.operatorId, t.tricycleId, t.businessDate)
      .where(sql`${t.type} = 'daily_balance'`),
    index("charges_operator_idx").on(t.operatorId, t.businessDate),
    // Weekly and monthly totals across the whole fleet.
    index("charges_balance_date_idx")
      .on(t.businessDate)
      .where(sql`${t.type} = 'daily_balance'`),
    check("charges_positive", sql`${t.amountKobo} > 0`),
  ],
);

export const chargeVoids = pgTable("charge_voids", {
  chargeId: uuid("charge_id")
    .primaryKey()
    .references(() => charges.id),
  voidedBy: uuid("voided_by").references(() => users.id),
  reason: text("reason").notNull(),
  voidedAt: timestamp("voided_at", tz).notNull(),
});

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    method: paymentMethod("method").notNull(),
    receivedAt: timestamp("received_at", tz).notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    /** Empty when the question does not apply, such as a remote transfer. */
    tricyclePresent: boolean("tricycle_present"),
    receiptNumber: text("receipt_number").notNull().unique("payments_receipt_unique"),
    clientId: uuid("client_id").notNull().unique("payments_client_unique"),
    backdateReason: text("backdate_reason"),
    purpose: paymentPurpose("purpose").notNull().default("general"),
    /** The day a day_balance payment pays. Empty for every other purpose. */
    forDate: date("for_date", { mode: "string" }),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    index("payments_operator_idx").on(t.operatorId, t.receivedAt),
    // What has been paid for one operator's day, for the once-a-day check.
    index("payments_for_date_idx").on(t.operatorId, t.forDate),
    check("payments_day_has_date", sql`(${t.purpose} = 'day_balance') = (${t.forDate} IS NOT NULL)`),
    index("payments_date_idx").on(t.businessDate),
    // A cashier's own collections for a week or month.
    index("payments_received_by_idx").on(t.receivedBy, t.businessDate),
    check("payments_positive", sql`${t.amountKobo} > 0`),
  ],
);

export const paymentReversals = pgTable("payment_reversals", {
  paymentId: uuid("payment_id")
    .primaryKey()
    .references(() => payments.id),
  reversedBy: uuid("reversed_by")
    .notNull()
    .references(() => users.id),
  reason: text("reason").notNull(),
  reversedAt: timestamp("reversed_at", tz).notNull(),
});

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    chargeId: uuid("charge_id")
      .notNull()
      .references(() => charges.id),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  },
  (t) => [
    index("allocations_charge_idx").on(t.chargeId),
    index("allocations_payment_idx").on(t.paymentId),
    check("allocations_positive", sql`${t.amountKobo} > 0`),
  ],
);

export const cashMovements = pgTable(
  "cash_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    custodianId: uuid("custodian_id")
      .notNull()
      .references(() => users.id),
    /** Positive is cash in, negative is cash out. */
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    at: timestamp("at", tz).notNull(),
  },
  (t) => [index("cash_custodian_date_idx").on(t.custodianId, t.businessDate)],
);

export const cashCloses = pgTable(
  "cash_closes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    custodianId: uuid("custodian_id")
      .notNull()
      .references(() => users.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    expectedKobo: bigint("expected_kobo", { mode: "number" }).notNull(),
    countedKobo: bigint("counted_kobo", { mode: "number" }).notNull(),
    explanation: text("explanation"),
    closedBy: uuid("closed_by")
      .notNull()
      .references(() => users.id),
    closedAt: timestamp("closed_at", tz).notNull(),
  },
  (t) => [uniqueIndex("one_cash_close").on(t.custodianId, t.businessDate)],
);

export const rules = pgTable(
  "rules",
  {
    code: text("code").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    name: text("name").notNull(),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.code, t.effectiveFrom] })],
);

export const violations = pgTable(
  "violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleCode: text("rule_code").notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    tricycleId: uuid("tricycle_id").references(() => tricycles.id),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    status: violationStatus("status").notNull(),
    occurrenceKey: text("occurrence_key").notNull().unique("one_charge_per_offence"),
    /** The late daily balance behind an R1 fine. */
    sourceChargeId: uuid("source_charge_id").references(() => charges.id),
    chargeId: uuid("charge_id").references(() => charges.id),
    raisedBy: uuid("raised_by").references(() => users.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", tz),
    decisionReason: text("decision_reason"),
    photoId: uuid("photo_id").references(() => photos.id),
    note: text("note"),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (t) => [
    index("violations_operator_idx").on(t.operatorId),
    index("violations_status_idx").on(t.status),
  ],
);

/** One verdict per daily balance once its deadline has passed. */
export const lateEvaluations = pgTable("late_evaluations", {
  chargeId: uuid("charge_id")
    .primaryKey()
    .references(() => charges.id),
  outcome: lateOutcome("outcome").notNull(),
  evaluatedOn: date("evaluated_on", { mode: "string" }).notNull(),
});

export const dismissals = pgTable(
  "dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    status: dismissalStatus("status").notNull(),
    unpaidDays: integer("unpaid_days").notNull(),
    flaggedOn: date("flagged_on", { mode: "string" }).notNull(),
    clearedBy: uuid("cleared_by").references(() => users.id),
    clearReason: text("clear_reason"),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedOn: date("confirmed_on", { mode: "string" }),
    reinstatedBy: uuid("reinstated_by").references(() => users.id),
    reinstatedOn: date("reinstated_on", { mode: "string" }),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (t) => [
    uniqueIndex("one_open_dismissal")
      .on(t.operatorId)
      .where(sql`${t.status} = 'flagged'`),
  ],
);

export const nonCollectionDays = pgTable("non_collection_days", {
  businessDate: date("business_date", { mode: "string" }).primaryKey(),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
});

export const jobRuns = pgTable(
  "job_runs",
  {
    job: text("job").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.job, t.businessDate] })],
);

/** Evidence. Compressed on the phone, so each is small. Append-only. */
export const photos = pgTable("photos", {
  id: uuid("id").primaryKey().defaultRandom(),
  data: bytea("data").notNull(),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", tz).notNull(),
});

export const inspections = pgTable(
  "inspections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tricycleId: uuid("tricycle_id")
      .notNull()
      .references(() => tricycles.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    inspectedBy: uuid("inspected_by")
      .notNull()
      .references(() => users.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    washed: boolean("washed").notNull(),
    stickerIntact: boolean("sticker_intact").notNull(),
    note: text("note"),
    photoId: uuid("photo_id").references(() => photos.id),
    clientId: uuid("client_id").notNull().unique("inspections_client_unique"),
    inspectedAt: timestamp("inspected_at", tz).notNull(),
    recordedAt: timestamp("recorded_at", tz).notNull(),
  },
  (t) => [
    uniqueIndex("one_inspection_per_day").on(t.tricycleId, t.businessDate),
    index("inspections_date_idx").on(t.businessDate),
    index("inspections_operator_idx").on(t.operatorId, t.businessDate),
  ],
);

/** One missing-sticker episode: it is fined once, however many days it lasts. */
export const stickerIncidents = pgTable(
  "sticker_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tricycleId: uuid("tricycle_id")
      .notNull()
      .references(() => tricycles.id),
    openedOn: date("opened_on", { mode: "string" }).notNull(),
    closedOn: date("closed_on", { mode: "string" }),
    violationId: uuid("violation_id").references(() => violations.id),
  },
  (t) => [
    uniqueIndex("one_open_sticker_incident")
      .on(t.tricycleId)
      .where(sql`${t.closedOn} IS NULL`),
  ],
);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    scheduledFor: timestamp("scheduled_for", tz).notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    status: meetingStatus("status").notNull().default("scheduled"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull(),
    closedBy: uuid("closed_by").references(() => users.id),
    closedAt: timestamp("closed_at", tz),
  },
  (t) => [index("meetings_scheduled_idx").on(t.scheduledFor)],
);

export const meetingAttendance = pgTable(
  "meeting_attendance",
  {
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    status: attendanceStatus("status").notNull(),
    reason: text("reason"),
    /** The tricycle held when attendance was taken, and whether it was off road. */
    tricycleId: uuid("tricycle_id").references(() => tricycles.id),
    tricycleOffRoad: boolean("tricycle_off_road").notNull().default(false),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    recordedAt: timestamp("recorded_at", tz).notNull(),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.operatorId] })],
);

/** Services and repairs share one flow: check in, findings, parts, complete. */
export const workOrders = pgTable(
  "work_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: workOrderType("type").notNull(),
    tricycleId: uuid("tricycle_id")
      .notNull()
      .references(() => tricycles.id),
    status: workOrderStatus("status").notNull(),
    /** The fixed cycle date. Never changes, even if this service is rescheduled. */
    cycleDate: date("cycle_date", { mode: "string" }),
    scheduledFor: date("scheduled_for", { mode: "string" }),
    fault: text("fault"),
    findings: text("findings"),
    labourCostKobo: bigint("labour_cost_kobo", { mode: "number" }).notNull().default(0),
    cancelReason: text("cancel_reason"),
    checkedInAt: timestamp("checked_in_at", tz),
    checkedInBy: uuid("checked_in_by").references(() => users.id),
    completedAt: timestamp("completed_at", tz),
    completedBy: uuid("completed_by").references(() => users.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (t) => [
    unique("one_service_per_cycle").on(t.tricycleId, t.cycleDate),
    uniqueIndex("one_open_repair")
      .on(t.tricycleId)
      .where(sql`${t.type} = 'maintenance' AND ${t.status} = 'checked_in'`),
    index("work_orders_status_idx").on(t.status, t.scheduledFor),
    index("work_orders_tricycle_idx").on(t.tricycleId),
  ],
);

export const offRoadPeriods = pgTable(
  "off_road_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tricycleId: uuid("tricycle_id")
      .notNull()
      .references(() => tricycles.id),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }),
    reason: text("reason").notNull(),
  },
  (t) => [
    uniqueIndex("one_open_off_road")
      .on(t.tricycleId)
      .where(sql`${t.endsOn} IS NULL`),
  ],
);

export const stockItems = pgTable("stock_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique("stock_items_name_unique"),
  unit: text("unit").notNull(),
  wholeOnly: boolean("whole_only").notNull().default(true),
  /** Quantities are thousandths of a unit, so 1.25 litres is 1250. */
  reorderLevelMilli: bigint("reorder_level_milli", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

/** Current stock. Always changed together with a movement, under a row lock. */
export const stockBalances = pgTable("stock_balances", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => stockItems.id),
  quantityMilli: bigint("quantity_milli", { mode: "number" }).notNull().default(0),
  valueKobo: bigint("value_kobo", { mode: "number" }).notNull().default(0),
});

/** Append-only. Stock is only ever changed by adding one of these. */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => stockItems.id),
    kind: stockMovementKind("kind").notNull(),
    quantityMilli: bigint("quantity_milli", { mode: "number" }).notNull(),
    /** The change in stock value: positive in, negative out. */
    costKobo: bigint("cost_kobo", { mode: "number" }).notNull(),
    workOrderId: uuid("work_order_id").references(() => workOrders.id),
    tricycleId: uuid("tricycle_id").references(() => tricycles.id),
    reversesId: uuid("reverses_id").unique("stock_movement_reversed_once"),
    reason: text("reason"),
    performedBy: uuid("performed_by")
      .notNull()
      .references(() => users.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (t) => [
    index("stock_movements_item_idx").on(t.itemId, t.createdAt),
    index("stock_movements_work_order_idx").on(t.workOrderId),
    index("stock_movements_tricycle_idx").on(t.tricycleId),
  ],
);

/** Not written to while operators are told through their portal. Kept for when SMS returns. */
export const smsOutbox = pgTable(
  "sms_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toPhone: text("to_phone").notNull(),
    body: text("body").notNull(),
    kind: text("kind").notNull(),
    status: smsStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", tz).notNull(),
    sentAt: timestamp("sent_at", tz),
  },
  (t) => [index("sms_status_idx").on(t.status, t.createdAt)],
);

/* ---------- Expenses, loans and the bank side of the cash book ---------- */

export const loanStatus = pgEnum("loan_status", ["active", "cleared", "cancelled"]);
export const advanceStatus = pgEnum("expense_advance_status", [
  "open",
  "submitted",
  "countersigned",
  "cancelled",
]);
export const expenseLineKind = pgEnum("expense_line_kind", ["spent", "change"]);
export const expenseCategory = pgEnum("expense_category", [
  "store_purchase",
  "workshop_labour",
  "transport",
  "office",
  "salaries",
  "other",
]);

// Money that did not pass through someone's hands as cash. Append-only (drizzle/0010).
/** Company bank money, or the owner's own money that never passed through the company. */
export const bankSide = pgEnum("bank_side", ["bank", "owner"]);

export const bankMovements = pgTable(
  "bank_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account: bankSide("account").notNull().default("bank"),
    /** Positive is money in, negative is money out. */
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    at: timestamp("at", tz).notNull(),
  },
  (t) => [
    index("bank_date_idx").on(t.businessDate),
    uniqueIndex("one_opening_balance").on(t.sourceType).where(sql`source_type = 'opening_balance'`),
  ],
);

export const loans = pgTable(
  "loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account: bankSide("account").notNull().default("bank"),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    chargeId: uuid("charge_id")
      .notNull()
      .unique()
      .references(() => charges.id),
    principalKobo: bigint("principal_kobo", { mode: "number" }).notNull(),
    status: loanStatus("status").notNull().default("active"),
    /** Who the cash came from. Empty means the bank or the owner. */
    custodianId: uuid("custodian_id").references(() => users.id),
    note: text("note"),
    disbursedOn: date("disbursed_on", { mode: "string" }).notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (t) => [
    uniqueIndex("one_active_loan").on(t.operatorId).where(sql`status = 'active'`),
    index("loans_operator_idx").on(t.operatorId),
    check("loan_principal_positive", sql`principal_kobo > 0`),
  ],
);

export const expenseAdvances = pgTable(
  "expense_advances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account: bankSide("account").notNull().default("bank"),
    purpose: text("purpose").notNull(),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    status: advanceStatus("status").notNull().default("open"),
    custodianId: uuid("custodian_id").references(() => users.id),
    collectedOn: date("collected_on", { mode: "string" }).notNull(),
    collectedBy: uuid("collected_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull(),
    submittedAt: timestamp("submitted_at", tz),
    countersignedBy: uuid("countersigned_by").references(() => users.id),
    countersignedAt: timestamp("countersigned_at", tz),
    /** Why the Assistant Manager last sent it back. */
    returnNote: text("return_note"),
    cancelReason: text("cancel_reason"),
    /** Recorded as one expense (what it was for, amount, date), not as funds collected first. */
    oneStep: boolean("one_step").notNull().default(false),
  },
  (t) => [
    index("advances_status_idx").on(t.status),
    check("advance_amount_positive", sql`amount_kobo > 0`),
    check("advance_two_people", sql`countersigned_by IS NULL OR countersigned_by <> collected_by`),
  ],
);

// expense_lines and expense_line_voids are append-only (drizzle/0010).
export const expenseLines = pgTable(
  "expense_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    advanceId: uuid("advance_id")
      .notNull()
      .references(() => expenseAdvances.id),
    kind: expenseLineKind("kind").notNull(),
    category: expenseCategory("category"),
    description: text("description").notNull(),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    spentOn: date("spent_on", { mode: "string" }).notNull(),
    photoId: uuid("photo_id").references(() => photos.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (t) => [
    index("expense_lines_advance_idx").on(t.advanceId),
    check("expense_line_amount_positive", sql`amount_kobo > 0`),
    check("expense_spent_has_category", sql`kind <> 'spent' OR category IS NOT NULL`),
  ],
);

export const expenseLineVoids = pgTable("expense_line_voids", {
  lineId: uuid("line_id")
    .primaryKey()
    .references(() => expenseLines.id),
  voidedBy: uuid("voided_by")
    .notNull()
    .references(() => users.id),
  reason: text("reason").notNull(),
  voidedAt: timestamp("voided_at", tz).notNull(),
});

/* ---------- Awards ---------- */

export const awardType = pgEnum("award_type", ["consistency", "clean_vehicle", "law_abiding"]);
export const candidateStatus = pgEnum("award_candidate_status", ["proposed", "approved", "rejected"]);

export const awardCandidates = pgTable(
  "award_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: awardType("type").notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    /** The 1st of the month the system looked at this operator. */
    runOn: date("run_on", { mode: "string" }).notNull(),
    periodFrom: date("period_from", { mode: "string" }).notNull(),
    periodTo: date("period_to", { mode: "string" }).notNull(),
    status: candidateStatus("status").notNull().default("proposed"),
    /** The facts behind the result, so any award can be explained later. */
    evidence: jsonb("evidence").notNull(),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", tz),
    rejectReason: text("reject_reason"),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (t) => [
    unique("one_candidate_per_run").on(t.type, t.operatorId, t.runOn),
    uniqueIndex("one_pending_candidate").on(t.type, t.operatorId).where(sql`status = 'proposed'`),
    index("award_candidates_status_idx").on(t.status),
  ],
);

// Append-only (drizzle/0012).
export const awards = pgTable(
  "awards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .unique()
      .references(() => awardCandidates.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    given: text("given").notNull(),
    givenOn: date("given_on", { mode: "string" }).notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (t) => [index("awards_operator_idx").on(t.operatorId)],
);

/* ---------- Operator notices ---------- */

/**
 * Retired: copied into notifications by drizzle/0022 and no longer written or
 * read. Kept until the copy has been checked on production, then dropped.
 */
export const operatorNotices = pgTable(
  "operator_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", tz).notNull(),
    readAt: timestamp("read_at", tz),
    /** Set on notices that must only ever reach an operator once. */
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    index("operator_notices_idx").on(t.operatorId, t.createdAt),
    uniqueIndex("operator_notices_once").on(t.operatorId, t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL`),
  ],
);

/* ---------- Notifications (NOTIFICATION_PLAN.md) ---------- */

export const notificationSeverity = pgEnum("notification_severity", ["info", "action", "critical"]);

/**
 * One row per event. What it says never changes once saved (drizzle/0022), so
 * what someone was told stays on record. Written in the same transaction as the
 * event, through notify() only.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    severity: notificationSeverity("severity").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** A page inside the app, always starting with "/". */
    link: text("link"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    /** Set on events that must only ever be posted once. */
    dedupeKey: text("dedupe_key").unique(),
    requiresAck: boolean("requires_ack").notNull().default(false),
    expiresAt: timestamp("expires_at", tz),
    /** Empty when the system posted it. */
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  // Same rule as isAppLink: a page inside the app, never "//site" or "/\site" (chr(92) is a backslash).
  (t) => [
    check(
      "notification_link_inside_app",
      sql`link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%' AND strpos(link, chr(92)) = 0 AND link !~ '[[:space:][:cntrl:]]')`,
    ),
  ],
);

/**
 * One row per person told. Staff are addressed by user and operators by
 * operator, so an operator can be told things before a login exists. Only
 * read_at and acknowledged_at may change (drizzle/0022).
 */
export const notificationRecipients = pgTable(
  "notification_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    operatorId: uuid("operator_id").references(() => operators.id),
    /** Copied from the notification, so each inbox is read from one index. */
    createdAt: timestamp("created_at", tz).notNull(),
    readAt: timestamp("read_at", tz),
    acknowledgedAt: timestamp("acknowledged_at", tz),
  },
  (t) => [
    check("recipient_is_one_person", sql`num_nonnulls(user_id, operator_id) = 1`),
    uniqueIndex("one_notice_per_user").on(t.notificationId, t.userId).where(sql`${t.userId} IS NOT NULL`),
    uniqueIndex("one_notice_per_operator").on(t.notificationId, t.operatorId).where(sql`${t.operatorId} IS NOT NULL`),
    index("user_inbox_idx").on(t.userId, t.createdAt).where(sql`${t.userId} IS NOT NULL`),
    index("operator_inbox_idx").on(t.operatorId, t.createdAt).where(sql`${t.operatorId} IS NOT NULL`),
    index("user_unread_idx").on(t.userId).where(sql`${t.userId} IS NOT NULL AND ${t.readAt} IS NULL`),
    index("operator_unread_idx").on(t.operatorId).where(sql`${t.operatorId} IS NOT NULL AND ${t.readAt} IS NULL`),
  ],
);

/** Which milestones have been celebrated. Progress itself is always worked out live. */
export const awardMilestones = pgTable(
  "award_milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    code: text("code").notNull(),
    reachedOn: date("reached_on", { mode: "string" }).notNull(),
    evidence: jsonb("evidence").notNull(),
    createdAt: timestamp("created_at", tz).notNull(),
    voidedAt: timestamp("voided_at", tz),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("award_milestones_once").on(t.operatorId, t.code).where(sql`${t.voidedAt} IS NULL`),
  ],
);

/* ---------- The cash trail ---------- */

/**
 * Money an operator leaves with the company. It is held for them, so it is never
 * income and never pays a charge. Append-only (drizzle/0019): a mistake is a reversal row.
 */
export const operatorDeposits = pgTable(
  "operator_deposits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").notNull().unique(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    method: paymentMethod("method").notNull(),
    receiptNumber: text("receipt_number").notNull().unique(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    receivedAt: timestamp("received_at", tz).notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
  },
  (t) => [
    index("operator_deposits_operator_idx").on(t.operatorId, t.receivedAt),
    check("operator_deposit_positive", sql`amount_kobo > 0`),
  ],
);

export const operatorDepositReversals = pgTable("operator_deposit_reversals", {
  depositId: uuid("deposit_id")
    .primaryKey()
    .references(() => operatorDeposits.id),
  reversedBy: uuid("reversed_by")
    .notNull()
    .references(() => users.id),
  reason: text("reason").notNull(),
  reversedAt: timestamp("reversed_at", tz).notNull(),
});

/**
 * The bank's reference for a transfer or POS payment or deposit. One table, so a
 * reference can only be live once across both. A reversal frees it for re-entry.
 */
export const paymentReferences = pgTable(
  "payment_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .unique()
      .references(() => payments.id),
    depositId: uuid("deposit_id")
      .unique()
      .references(() => operatorDeposits.id),
    reference: text("reference").notNull(),
    releasedAt: timestamp("released_at", tz),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", tz),
  },
  (t) => [
    uniqueIndex("one_live_reference").on(t.reference).where(sql`released_at IS NULL`),
    check("reference_has_one_owner", sql`num_nonnulls(payment_id, deposit_id) = 1`),
  ],
);

export const moneyPlace = pgEnum("money_place", ["cash", "bank", "owner"]);
export const transferStatus = pgEnum("money_transfer_status", ["pending", "done", "rejected", "voided"]);

/** Money moving between staff, the bank and the owner. */
export const moneyTransfers = pgTable(
  "money_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromPlace: moneyPlace("from_place").notNull(),
    fromCustodian: uuid("from_custodian").references(() => users.id),
    toPlace: moneyPlace("to_place").notNull(),
    toCustodian: uuid("to_custodian").references(() => users.id),
    amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
    reference: text("reference"),
    photoId: uuid("photo_id").references(() => photos.id),
    note: text("note"),
    status: transferStatus("status").notNull().default("done"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", tz).notNull(),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", tz),
    reason: text("reason"),
  },
  (t) => [
    index("money_transfers_status_idx").on(t.status, t.createdAt),
    check("transfer_amount_positive", sql`amount_kobo > 0`),
    check(
      "transfer_cash_has_person",
      sql`(from_place = 'cash') = (from_custodian IS NOT NULL) AND (to_place = 'cash') = (to_custodian IS NOT NULL)`,
    ),
  ],
);

// Append-only (drizzle/0014).
export const cashCloseChecks = pgTable("cash_close_checks", {
  closeId: uuid("close_id")
    .primaryKey()
    .references(() => cashCloses.id),
  /** Empty only for days closed before second checks began. */
  checkedBy: uuid("checked_by").references(() => users.id),
  recountedKobo: bigint("recounted_kobo", { mode: "number" }),
  note: text("note"),
  checkedAt: timestamp("checked_at", tz).notNull(),
});

// Append-only (drizzle/0014).
export const bankReconciliations = pgTable("bank_reconciliations", {
  id: uuid("id").primaryKey().defaultRandom(),
  month: date("month", { mode: "string" }).notNull().unique(),
  statementKobo: bigint("statement_kobo", { mode: "number" }).notNull(),
  bookKobo: bigint("book_kobo", { mode: "number" }).notNull(),
  unconfirmedKobo: bigint("unconfirmed_kobo", { mode: "number" }).notNull(),
  explanation: text("explanation"),
  recordedBy: uuid("recorded_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", tz).notNull(),
});
