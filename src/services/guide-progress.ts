import { sql } from "drizzle-orm";
import { db } from "@/db";
import { tourFor, toursFor, TOURS } from "@/guide";
import { DomainError } from "@/lib/errors";
import { isStaff, type Role } from "@/lib/permissions";
import { requirePermission, type Ctx } from "./context";

export type TourStatus = "done" | "skipped";

/** Each tour this person has finished or skipped. */
export async function tourProgress(ctx: Ctx): Promise<Record<string, TourStatus>> {
  if (!isStaff(ctx.actor.role)) return {};
  const rows = (await db.execute(sql`
    SELECT tour_id, status FROM guide_progress WHERE user_id = ${ctx.actor.userId}
  `)) as unknown as { tour_id: string; status: TourStatus }[];
  return Object.fromEntries(rows.map((row) => [row.tour_id, row.status]));
}

/**
 * Remembers that this person finished or skipped a tour. Finishing it once
 * stands: skipping it on a later run does not undo that.
 */
export async function saveTourProgress(ctx: Ctx, tourId: string, status: TourStatus) {
  if (status !== "done" && status !== "skipped") throw new DomainError("Unknown tour status.");
  if (!isStaff(ctx.actor.role) || !tourFor(ctx.actor.role, tourId)) throw new DomainError("That tour is not one of yours.");
  await db.execute(sql`
    INSERT INTO guide_progress (user_id, tour_id, status, updated_at)
    VALUES (${ctx.actor.userId}, ${tourId}, ${status}, ${ctx.clock().toISOString()}::timestamptz)
    ON CONFLICT (user_id, tour_id) DO UPDATE SET
      status = CASE WHEN guide_progress.status = 'done' THEN 'done' ELSE EXCLUDED.status END,
      updated_at = EXCLUDED.updated_at
  `);
}

export type TourState = { status: TourStatus | "not_yet"; at: Date | null };

/**
 * For the Owner and Manager: each working member of staff, the tours their
 * role is offered, and whether they finished, skipped or have not taken each
 * one. Operators have no tours, so they are left out.
 */
export async function tourReport(ctx: Ctx) {
  requirePermission(ctx, "guide.progress");
  const rows = (await db.execute(sql`
    SELECT u.id, u.name, u.role, u.last_login_at, g.tour_id, g.status, g.updated_at
    FROM users u
    LEFT JOIN guide_progress g ON g.user_id = u.id
    WHERE u.status = 'active' AND u.role <> 'operator'
    ORDER BY u.name, u.id
  `)) as unknown as {
    id: string;
    name: string;
    role: Role;
    last_login_at: Date | string | null;
    tour_id: string | null;
    status: TourStatus | null;
    updated_at: Date | string | null;
  }[];
  const asDate = (value: Date | string | null) => (value === null ? null : new Date(value));

  const people = new Map<string, { id: string; name: string; role: Role; lastLoginAt: Date | null; seen: Map<string, TourState> }>();
  for (const row of rows) {
    const person = people.get(row.id) ?? { id: row.id, name: row.name, role: row.role, lastLoginAt: asDate(row.last_login_at), seen: new Map() };
    people.set(row.id, person);
    if (row.tour_id && row.status) person.seen.set(row.tour_id, { status: row.status, at: asDate(row.updated_at) });
  }

  const staff = [...people.values()].map((person) => ({
    id: person.id,
    name: person.name,
    role: person.role,
    lastLoginAt: person.lastLoginAt,
    tours: toursFor(person.role).map((tour) => ({
      id: tour.id,
      title: tour.title,
      ...(person.seen.get(tour.id) ?? { status: "not_yet" as const, at: null }),
    })),
  }));

  const tours = TOURS.map((tour) => {
    const offered = staff.flatMap((person) => person.tours.filter((one) => one.id === tour.id));
    return {
      id: tour.id,
      title: tour.title,
      offered: offered.length,
      done: offered.filter((one) => one.status === "done").length,
      skipped: offered.filter((one) => one.status === "skipped").length,
    };
  }).filter((tour) => tour.offered > 0);

  return { staff, tours };
}
