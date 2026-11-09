import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { rules } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { asPgError, DomainError, fieldError, parseInput } from "@/lib/errors";
import { dateField, positiveNairaField } from "@/lib/fields";
import { auditFrom } from "./audit";
import { requirePermission, type Ctx } from "./context";
import { ruleAmount } from "./violations";

/** The fine in force today for each rule, and any change already set for later. */
export async function listRules(ctx: Ctx) {
  requirePermission(ctx, "violation.view");
  const today = businessDate(ctx.clock());
  const rows = await db.select().from(rules).orderBy(rules.code, desc(rules.effectiveFrom));
  const codes = [...new Set(rows.map((row) => row.code))];
  return codes.map((code) => {
    const versions = rows.filter((row) => row.code === code);
    const current = versions.find((row) => row.effectiveFrom <= today)!;
    return {
      code,
      name: current.name,
      amountKobo: current.amountKobo,
      upcoming: versions.filter((row) => row.effectiveFrom > today).reverse(),
    };
  });
}

const changeSchema = z.object({
  code: z.string("Choose a rule"),
  amount: positiveNairaField("New fine"),
  effectiveFrom: dateField("Start date"),
});

/** Adds a new amount from a date. Past offences keep the amount they had. */
export async function changeRuleAmount(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "rule.manage");
  const input = parseInput(changeSchema, raw);
  if (input.effectiveFrom < businessDate(ctx.clock())) {
    throw fieldError("effectiveFrom", "A new fine cannot start in the past");
  }
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(rules)
      .where(and(eq(rules.code, input.code), lte(rules.effectiveFrom, input.effectiveFrom)))
      .orderBy(desc(rules.effectiveFrom))
      .limit(1);
    if (!current) throw new DomainError("Rule not found.");
    const before = await ruleAmount(tx, input.code, input.effectiveFrom);
    try {
      await tx.insert(rules).values({
        code: input.code,
        effectiveFrom: input.effectiveFrom,
        name: current.name,
        amountKobo: input.amount,
      });
    } catch (error) {
      if (asPgError(error)?.code === "23505") {
        throw fieldError("effectiveFrom", "This rule already has a change on that date");
      }
      throw error;
    }
    await auditFrom(ctx, tx, {
      action: "rule.change",
      entityType: "rule",
      entityId: input.code,
      before: { amountKobo: before },
      after: { amountKobo: input.amount, effectiveFrom: input.effectiveFrom },
    });
  });
}
