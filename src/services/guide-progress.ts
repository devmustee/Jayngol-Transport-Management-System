import { sql } from "drizzle-orm";
import { db } from "@/db";
import { tourFor } from "@/guide";
import { DomainError } from "@/lib/errors";
import { isStaff } from "@/lib/permissions";
import type { Ctx } from "./context";

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
