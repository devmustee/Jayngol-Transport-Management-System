import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db";
import { backEntryWindows } from "@/db/schema";
import { addDays, businessDate } from "@/lib/clock";
import { asPgError, DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField } from "@/lib/fields";
import { formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";

/** The longest fines can wait, so a forgotten window cannot hold them for ever. */
export const MAX_HOLD_DAYS = 14;
const MAX_BACK_DAYS = 31;

/** The open window, if its stop date has not come. */
export async function openWindow(exec: Executor, date: string) {
  const [row] = await exec
    .select()
    .from(backEntryWindows)
    .where(and(isNull(backEntryWindows.closedAt), gt(backEntryWindows.stopOn, date)))
    .limit(1);
  return row ?? null;
}

const openSchema = z.object({
  fromDate: dateField("First day"),
  untilDate: dateField("Last day"),
  stopOn: dateField("Fines wait until at the latest"),
});

/** Holds fine checks for days whose payments are still being entered late. */
export async function openBackEntries(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "backentry.manage");
  const input = parseInput(openSchema, raw);
  const today = businessDate(ctx.clock());
  if (input.untilDate > today) throw fieldError("untilDate", "The last day cannot be in the future");
  if (input.fromDate > input.untilDate) throw fieldError("fromDate", "The first day must be on or before the last day");
  if (input.fromDate < addDays(today, -MAX_BACK_DAYS)) {
    throw fieldError("fromDate", `The first day can be at most ${MAX_BACK_DAYS} days ago`);
  }
  if (input.stopOn <= today) throw fieldError("stopOn", "Choose a date after today");
  if (input.stopOn > addDays(today, MAX_HOLD_DAYS)) {
    throw fieldError("stopOn", `Fines can wait at most ${MAX_HOLD_DAYS} days`);
  }
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(backEntryWindows)
        .values({ ...input, openedBy: ctx.actor.userId, openedAt: ctx.clock() })
        .returning({ id: backEntryWindows.id });
      await auditFrom(ctx, tx, {
        action: "backentry.open",
        entityType: "back_entry",
        entityId: row!.id,
        after: input,
      });
    });
  } catch (error) {
    if (asPgError(error)?.constraint_name === "one_open_back_entry") {
      throw new DomainError("Back entries are already open. Finish them first.");
    }
    throw error;
  }
}

/** The next nightly run checks the held days, counting each payment at its real date. */
export async function finishBackEntries(ctx: Ctx) {
  requirePermission(ctx, "backentry.manage");
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(backEntryWindows)
      .set({ closedBy: ctx.actor.userId, closedAt: now })
      .where(isNull(backEntryWindows.closedAt))
      .returning();
    if (!row) throw new DomainError("Back entries are not open.");
    await auditFrom(ctx, tx, {
      action: "backentry.finish",
      entityType: "back_entry",
      entityId: row.id,
      before: { fromDate: row.fromDate, untilDate: row.untilDate, stopOn: row.stopOn },
    });
  });
}

export async function backEntryStatus(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const today = businessDate(ctx.clock());
  return {
    today,
    window: await openWindow(db, today),
    canManage: can(ctx.actor.role, "backentry.manage"),
    maxStopOn: addDays(today, MAX_HOLD_DAYS),
  };
}

/** The reason a late payment starts with, while its day is open for back entry. */
export async function backEntryReason(ctx: Ctx, date: string) {
  requirePermission(ctx, "payment.record");
  const window = await openWindow(db, businessDate(ctx.clock()));
  if (!window || date < window.fromDate || date > window.untilDate) return undefined;
  return `Records start ${formatDate(window.fromDate)}`;
}
