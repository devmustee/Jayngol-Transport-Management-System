import { addDays } from "./clock";
import { formatDate } from "./format";
import { weekStart } from "./periods";
import type { Role } from "./permissions";

/**
 * How often each cash holder counts and closes their cash. The Manager closes
 * once a week (Monday to Sunday) and the Assistant Manager every day. A count
 * always covers every day since that person's last count, so closing early is
 * fine: it simply covers fewer days.
 */
export type CloseRhythm = "day" | "week";

export const closeRhythm = (role: Role | string): CloseRhythm => (role === "manager" ? "week" : "day");

/**
 * The last day that must already be closed on `today`. Daily: yesterday.
 * Weekly: last Sunday, but Monday is a day of grace, so on a Monday it is the
 * Sunday a week earlier.
 */
export function closeDueBy(rhythm: CloseRhythm, today: string): string {
  if (rhythm === "day") return addDays(today, -1);
  const monday = weekStart(today);
  const lastSunday = addDays(monday, -1);
  return today === monday ? addDays(lastSunday, -7) : lastSunday;
}

/** The Monday-to-Sunday week holding a date. */
export function weekOf(date: string) {
  const from = weekStart(date);
  return { from, to: addDays(from, 6) };
}

/** "9 Nov 2026" or "3 Nov 2026 to 9 Nov 2026". */
export const coverageDates = (from: string, to: string): string =>
  from >= to ? formatDate(to) : `${formatDate(from)} to ${formatDate(to)}`;

/** "Day close, 9 Nov 2026" or "Week close, 3 Nov 2026 to 9 Nov 2026". */
export function coverageLabel(from: string, to: string, rhythm: CloseRhythm): string {
  const kind = from >= to ? "Day close" : rhythm === "week" ? "Week close" : "Close";
  return `${kind}, ${coverageDates(from, to)}`;
}
