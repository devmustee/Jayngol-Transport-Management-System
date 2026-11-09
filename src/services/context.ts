import type { Clock } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import { can, type Permission, type Role } from "@/lib/permissions";

export type Actor = {
  userId: string;
  name: string;
  role: Role;
  /** Set only for operator logins. Comes from the session, never from a request. */
  operatorId: string | null;
};

export type Ctx = { actor: Actor; clock: Clock };

export function requirePermission(ctx: Ctx, permission: Permission): void {
  if (!can(ctx.actor.role, permission)) throw new ForbiddenError();
}

/** Escapes a search term for use inside an ILIKE pattern. */
export const likePattern = (term: string) =>
  `%${term.trim().replace(/[\\%_]/g, "\\$&")}%`;
