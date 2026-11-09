/** Time is always passed in, so tests can run any date without waiting. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

const lagosDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole days from one date to a later one. Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The same day n months away, or the last day of that month if it is shorter. */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/** The calendar date in Lagos (WAT) as YYYY-MM-DD. */
export function businessDate(at: Date): string {
  return lagosDate.format(at);
}

const lagosClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The time of day in Lagos as HH:MM. */
export const lagosTime = (at: Date): string => lagosClock.format(at);
