import { z } from "zod";
import { addDays, addMonths } from "./clock";
import { formatDate, queryValue } from "./format";

/** The periods a workshop report can cover. */
export const PERIODS = [
  { key: "month", label: "This month" },
  { key: "3m", label: "Last 3 months" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"] | "custom";

export type ReportPeriod = {
  key: PeriodKey;
  /** Undefined for all time. */
  from?: string;
  to: string;
  label: string;
};

const isDate = (value: string | undefined): value is string => !!value && z.iso.date().safeParse(value).success;

/**
 * Reads `period`, or `from` and `to` for chosen dates, from the address bar.
 * Anything malformed falls back to this month. Never runs past today.
 */
export function readReportPeriod(params: Record<string, unknown>, today: string): ReportPeriod {
  const from = queryValue(params.from);
  const to = queryValue(params.to);
  if (isDate(from) || isDate(to)) {
    const end = isDate(to) && to < today ? to : today;
    const start = isDate(from) && from <= end ? from : undefined;
    return {
      key: "custom",
      from: start,
      to: end,
      label: start ? `${formatDate(start)} to ${formatDate(end)}` : `Up to ${formatDate(end)}`,
    };
  }
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (queryValue(params.period)) {
    case "3m":
      return { key: "3m", from: addDays(addMonths(today, -3), 1), to: today, label: "Last 3 months" };
    case "year":
      return { key: "year", from: `${today.slice(0, 4)}-01-01`, to: today, label: `This year (${today.slice(0, 4)})` };
    case "all":
      return { key: "all", to: today, label: "All time" };
    default:
      return { key: "month", from: monthStart, to: today, label: "This month" };
  }
}
