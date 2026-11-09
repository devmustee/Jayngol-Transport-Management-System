const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Lagos",
});

/** Formats a YYYY-MM-DD business date. */
export const formatDate = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));

export const formatDateTime = (at: Date) => dateTimeFormat.format(at);

export const SERVICE_LABELS = { fortnightly: "Every 2 weeks", monthly: "Every month" } as const;

export const TRICYCLE_STATUS_LABELS = {
  in_stock: "In stock",
  issued: "With operator",
  off_road: "Off road",
  retired: "Retired",
} as const;

export const OPERATOR_STATUS_LABELS = {
  active: "Active",
  sacked: "Sacked",
  left: "Left",
} as const;

export const RETURN_REASON_LABELS = {
  reassigned: "Going to another operator",
  operator_left: "Operator left",
  tricycle_retired: "Tricycle being retired",
  other: "Other",
} as const;

export const CLOSED_REASON_LABELS = { ...RETURN_REASON_LABELS, sacked: "Operator sacked" } as const;

export const METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  transfer: "Transfer",
  pos: "POS",
};

export const CHARGE_LABELS = {
  daily_balance: "Daily balance",
  penalty: "Penalty",
  loan: "Loan",
} as const;

export const VIOLATION_STATUS_LABELS = {
  proposed: "To confirm",
  confirmed: "Confirmed",
  rejected: "Rejected",
  waived: "Waived",
} as const;

export const ATTENDANCE_LABELS = {
  present_with_tricycle: "With tricycle",
  present_without_tricycle: "No tricycle",
  absent: "Absent",
  excused: "Excused",
} as const;

export const MEETING_STATUS_LABELS = {
  scheduled: "Scheduled",
  closed: "Closed",
  cancelled: "Cancelled",
} as const;

export const WORK_TYPE_LABELS = { service: "Service", maintenance: "Repair" } as const;

export const WORK_STATUS_LABELS = {
  scheduled: "Scheduled",
  checked_in: "In workshop",
  completed: "Completed",
  missed: "Missed",
  cancelled: "Cancelled",
} as const;

export const MOVEMENT_LABELS = {
  received: "Received",
  issued: "Issued",
  returned: "Returned",
  adjusted: "Stock count",
} as const;

/** Reads one query-string value, ignoring repeated parameters. */
export const queryValue = (value: unknown) => (typeof value === "string" ? value : undefined);

export const BALANCE_HINT = "Usually 10,000, 12,000 or 15,000.";

export const EXPENSE_CATEGORY_LABELS = {
  store_purchase: "Store purchase",
  workshop_labour: "Workshop labour",
  transport: "Fuel and transport",
  office: "Office",
  salaries: "Salaries",
  other: "Other",
} as const;

export const ADVANCE_STATUS_LABELS = {
  open: "To account for",
  submitted: "Waiting for countersign",
  countersigned: "Countersigned",
  cancelled: "Cancelled",
} as const;

export const LOAN_STATUS_LABELS = { active: "Active", cleared: "Cleared", cancelled: "Cancelled" } as const;

export const BOOK_LABELS: Record<string, string> = {
  payment: "Payment received",
  payment_reversal: "Payment reversed",
  deposit: "Operator deposit received",
  deposit_reversal: "Operator deposit reversed",
  expense_advance: "Expense funds collected",
  expense_advance_cancel: "Expense funds put back",
  expense_change: "Change returned",
  expense_change_void: "Change entry corrected",
  loan: "Loan given",
  loan_cancel: "Loan cancelled",
  transfer_out: "Money moved out",
  transfer_in: "Money moved in",
  transfer_void_out: "Move reversed",
  transfer_void_in: "Move reversed",
  opening_balance: "Opening bank balance",
};

export const AWARD_LABELS = {
  consistency: "Consistency",
  clean_vehicle: "Clean vehicle",
  law_abiding: "Law-abiding",
} as const;

export const AWARD_PRIZES = {
  consistency: "Smartphone",
  clean_vehicle: "Clothes",
  law_abiding: "Cash",
} as const;
