import { z } from "zod";

/** Stock is counted in thousandths of a unit, so 1.25 litres is 1250. */
export const MILLI = 1000;

export function parseQuantity(text: string): number | null {
  const clean = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,3})?$/.test(clean)) return null;
  const [whole, fraction = ""] = clean.split(".");
  const value = Number(whole) * MILLI + Number(fraction.padEnd(3, "0"));
  return Number.isSafeInteger(value) ? value : null;
}

export const formatQuantity = (milli: number) =>
  (milli / MILLI).toLocaleString("en-NG", { maximumFractionDigits: 3 });

export const formatStock = (milli: number, unit: string) =>
  `${formatQuantity(milli)} ${unit}${milli === MILLI ? "" : "s"}`;

export const quantityField = (label: string) =>
  z.string(`${label} is required`).transform((value, ctx) => {
    const milli = parseQuantity(value);
    if (milli === null) {
      ctx.addIssue({ code: "custom", message: `Enter ${label.toLowerCase()} as a number` });
      return z.NEVER;
    }
    return milli;
  });

/** a × b ÷ c, rounded to the nearest whole, without losing precision on large values. */
export function mulDiv(a: number, b: number, c: number): number {
  return Number((BigInt(a) * BigInt(b) * 2n + BigInt(c)) / (BigInt(c) * 2n));
}
