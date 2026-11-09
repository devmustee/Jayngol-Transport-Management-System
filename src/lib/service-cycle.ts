import { addDays } from "./clock";

export type ServiceInterval = "fortnightly" | "monthly";

/** Always counted from the start date, so one short month cannot shift later dates. */
function cycleDate(start: string, interval: ServiceInterval, n: number): string {
  if (interval === "fortnightly") return addDays(start, n * 14);
  const year = Number(start.slice(0, 4));
  const month = Number(start.slice(5, 7)) - 1 + n;
  const day = Number(start.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/** Every service date from `from` to `to`, both included. */
export function serviceDatesBetween(
  start: string,
  interval: ServiceInterval,
  from: string,
  to: string,
): string[] {
  const dates: string[] = [];
  for (let n = 0; ; n++) {
    const date = cycleDate(start, interval, n);
    if (date > to) return dates;
    if (date >= from) dates.push(date);
  }
}

export function nextServiceDate(start: string, interval: ServiceInterval, onOrAfter: string): string {
  for (let n = 0; ; n++) {
    const date = cycleDate(start, interval, n);
    if (date >= onOrAfter) return date;
  }
}
