/** Normalises a Nigerian mobile number to +234XXXXXXXXXX, or null if invalid. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;

  let national: string;
  if (digits.startsWith("234") && digits.length === 13) national = digits.slice(3);
  else if (digits.startsWith("0") && digits.length === 11) national = digits.slice(1);
  else if (digits.length === 10) national = digits;
  else return null;

  return /^[789]/.test(national) ? `+234${national}` : null;
}

/** Shows +2348031234567 as 0803 123 4567. */
export function formatPhone(phone: string): string {
  const national = phone.replace(/^\+234/, "0");
  return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
}
