import { z } from "zod";
import { parseNairaToKobo } from "./money";
import { normalizePhone } from "./phone";

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const requiredText = (label: string, max = 200) =>
  z
    .string(`${label} is required`)
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} is too long`);

export const optionalText = (max = 500) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

/** Identifiers such as registration numbers: uppercase, single spaces. */
export const identifier = (label: string) =>
  requiredText(label, 40).transform((v) => v.toUpperCase().replace(/\s+/g, " "));

export const optionalIdentifier = () =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .max(60)
      .transform((v) => v.toUpperCase().replace(/\s+/g, " "))
      .optional(),
  );

export const phoneField = (label = "Phone number") =>
  z.string(`${label} is required`).transform((value, ctx) => {
    const phone = normalizePhone(value);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "Enter a valid Nigerian mobile number" });
      return z.NEVER;
    }
    return phone;
  });

export const optionalPhoneField = () =>
  z.preprocess(blankToUndefined, phoneField().optional());

export const dateField = (label: string) =>
  z.iso.date(`${label} must be a valid date`);

export const nairaField = (label: string) =>
  z.string(`${label} is required`).transform((value, ctx) => {
    const kobo = parseNairaToKobo(value);
    if (kobo === null) {
      ctx.addIssue({ code: "custom", message: `Enter ${label.toLowerCase()} as a number` });
      return z.NEVER;
    }
    return kobo;
  });

export const positiveNairaField = (label: string) =>
  nairaField(label).refine((kobo) => kobo > 0, `${label} must be more than zero`);

export const optionalNairaField = (label: string) =>
  z.preprocess(blankToUndefined, nairaField(label).optional());

export const idField = (label: string) => z.uuid(`Choose a valid ${label}`);

export const passwordField = z
  .string("Password is required")
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters");

export const pinField = z
  .string("PIN is required")
  .regex(/^\d{6}$/, "PIN must be exactly 6 digits");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);
