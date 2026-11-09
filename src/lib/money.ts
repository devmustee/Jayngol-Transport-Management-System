/** Money is integer kobo everywhere. These are the only conversions. */
export function parseNairaToKobo(input: string): number | null {
  const cleaned = input.replace(/[₦,\s]/g, "");
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const naira = Number(match[1]);
  const kobo = Number((match[2] ?? "").padEnd(2, "0"));
  return naira * 100 + kobo;
}

export function formatNaira(kobo: number): string {
  const naira = Math.trunc(kobo / 100);
  const remainder = kobo % 100;
  const whole = naira.toLocaleString("en-NG");
  return remainder === 0
    ? `₦${whole}`
    : `₦${whole}.${String(remainder).padStart(2, "0")}`;
}
