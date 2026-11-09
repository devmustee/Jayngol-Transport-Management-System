import { db } from "@/db";
import { users } from "@/db/schema";
import type { Clock } from "@/lib/clock";
import type { Role } from "@/lib/permissions";
import { hashCredential } from "@/services/auth";
import type { Ctx } from "@/services/context";
import { createOperator } from "@/services/operators";
import { createTricycle } from "@/services/tricycles";

/** Tuesday 10 November 2026, 09:00 WAT. */
export const NOW = new Date("2026-11-10T08:00:00Z");
export const TODAY = "2026-11-10";
export const fixedClock: Clock = () => NOW;

// Each test file loads this module afresh, so start from the clock to keep
// generated phones and codes unique across files.
let serial = Date.now() % 50_000_000;
export const nextSerial = () => ++serial;

export const nextReference = () => `TRF${nextSerial()}`;

/** A valid, unique Nigerian mobile number. */
export const uniquePhone = () => `080${10_000_000 + nextSerial()}`;

export const SECRET = "test-secret-123";
let secretHash: Promise<string> | undefined;

export async function makeUser(role: Exclude<Role, "operator">, clock: Clock = fixedClock) {
  secretHash ??= hashCredential(SECRET);
  const phone = `+234${uniquePhone().slice(1)}`;
  const [user] = await db
    .insert(users)
    .values({ name: `${role} ${nextSerial()}`, phone, role, credentialHash: await secretHash })
    .returning();
  const ctx: Ctx = {
    actor: { userId: user!.id, name: user!.name, role, operatorId: null },
    clock,
  };
  return { user: user!, ctx };
}

function letters(value: number, count: number) {
  let out = "";
  for (let i = 0, rest = value; i < count; i++, rest = Math.floor(rest / 26)) {
    out = String.fromCharCode(65 + (rest % 26)) + out;
  }
  return out;
}

export function tricycleInput(overrides: Record<string, unknown> = {}) {
  const n = nextSerial();
  return {
    registrationNumber: `${letters(Math.floor(n / 676_000), 3)}-${String(n % 1000).padStart(3, "0")}${letters(Math.floor(n / 1000), 2)}`,
    codeNumber: `${letters(Math.floor(n / 10_000), 3)},${String(n % 10_000).padStart(4, "0")}`,
    purchasedOn: "2026-01-15",
    purchaseCost: "2,500,000",
    serviceInterval: "fortnightly",
    serviceCycleStart: "2026-02-01",
    ...overrides,
  };
}

export async function makeTricycle(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  return (await createTricycle(ctx, tricycleInput(overrides)))!;
}

export async function makeOperator(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  return (await createOperator(ctx, {
    name: `Operator ${nextSerial()}`,
    phone: uniquePhone(),
    ...overrides,
  }))!;
}
