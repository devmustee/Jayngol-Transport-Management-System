import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { systemClock } from "@/lib/clock";
import { can, isStaff, type Permission } from "@/lib/permissions";
import { endSession, resolveSession } from "@/services/auth";
import type { Actor, Ctx } from "@/services/context";

const COOKIE = "jayngol_session";
const THIRTY_DAYS = 30 * 24 * 60 * 60;

/** Cached per request. The database decides expiry, not the cookie. */
export const getActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? resolveSession(token, systemClock) : null;
});

export async function requireCtx(): Promise<Ctx> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  return { actor, clock: systemClock };
}

export async function requireStaffCtx(): Promise<Ctx> {
  const ctx = await requireCtx();
  if (!isStaff(ctx.actor.role)) redirect("/me");
  return ctx;
}

export async function requirePage(permission: Permission): Promise<Ctx> {
  const ctx = await requireStaffCtx();
  if (!can(ctx.actor.role, permission)) redirect("/dashboard");
  return ctx;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: THIRTY_DAYS,
  });
}

export async function clearSession() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) await endSession(token);
  store.delete(COOKIE);
}

export async function clientIp(): Promise<string> {
  const forwarded = (await headers()).get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "local";
}
