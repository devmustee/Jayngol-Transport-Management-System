import { addDays, addMonths } from "./clock";

/** Weekly and monthly views of the daily balance. Dates are Lagos business dates. */
export const PERIOD_KINDS = ["week", "month"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** A range of business dates, both ends included. */
export type DateRange = { from: string; to: string };

/** A period up to today, with its full end and the same point in the period before. */
export type Period = {
  kind: PeriodKind;
  /** First day up to today. */
  soFar: DateRange;
  /** First day to the last day of the whole period. */
  full: DateRange;
  /** The previous period, from its first day to the same point as today. */
  previous: DateRange;
};

/** Monday of the week holding this date. The business week runs Monday to Sunday. */
export function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 is Sunday
  return addDays(date, -((weekday + 6) % 7));
}

export const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

/** The last day of the month holding this date. */
export const monthEnd = (date: string): string => addDays(addMonths(monthStart(date), 1), -1);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // 2026-13-40 is not a date at all, and 2026-02-30 would roll into March.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A range from a page address, or null if it is missing or not a real pair of dates. */
export function parseRange(params: { from?: string; to?: string }): DateRange | null {
  const { from, to } = params;
  if (!from || !to || !isRealDate(from) || !isRealDate(to) || from > to) return null;
  return { from, to };
}

/** Today, this week or this month, from a page address. Anything else means today. */
export function parsePulse(value: string | undefined): "today" | PeriodKind {
  return value === "week" || value === "month" ? value : "today";
}

export function periodOf(kind: PeriodKind, today: string): Period {
  if (kind === "week") {
    const from = weekStart(today);
    return {
      kind,
      soFar: { from, to: today },
      full: { from, to: addDays(from, 6) },
      previous: { from: addDays(from, -7), to: addDays(today, -7) },
    };
  }
  const from = monthStart(today);
  const lastFrom = addMonths(from, -1);
  // 31 March compares with 28 or 29 February: the previous month cannot go past its own end.
  const lastTo = addMonths(today, -1);
  return {
    kind,
    soFar: { from, to: today },
    full: { from, to: monthEnd(today) },
    previous: { from: lastFrom, to: lastTo },
  };
}
