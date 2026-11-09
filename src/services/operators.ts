import { and, asc, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { assignments, operators, tricycles, users } from "@/db/schema";
import { businessDate } from "@/lib/clock";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import {
  idField,
  optionalPhoneField,
  optionalText,
  phoneField,
  pinField,
  requiredText,
} from "@/lib/fields";
import { can } from "@/lib/permissions";
import { currentRate, issueTricycle } from "./assignments";
import { auditFrom } from "./audit";
import { hashCredential } from "./auth";
import { likePattern, requirePermission, type Ctx } from "./context";
import { saveOperatorLogin } from "./users";

const operatorSchema = z.object({
  name: requiredText("Name"),
  phone: phoneField(),
  address: optionalText(),
  licenceNumber: optionalText(60),
  guarantorName: optionalText(200),
  guarantorPhone: optionalPhoneField(),
  guarantorAddress: optionalText(),
});

const DUPLICATES = {
  operators_phone_unique: fieldError("phone", "An operator with this phone number already exists"),
  users_phone_unique: fieldError("phone", "This phone number is already used by another login"),
};

function validated(raw: unknown) {
  const input = parseInput(operatorSchema, raw);
  return {
    ...input,
    address: input.address ?? null,
    licenceNumber: input.licenceNumber ?? null,
    guarantorName: input.guarantorName ?? null,
    guarantorPhone: input.guarantorPhone ?? null,
    guarantorAddress: input.guarantorAddress ?? null,
  };
}

const tricycleChoice = z.object({
  tricycleId: z.preprocess((value) => value || undefined, idField("tricycle").optional()),
});

const firstPin = z.object({ pin: z.preprocess((value) => value || undefined, pinField.optional()) });

/** Issues a tricycle and sets up the login if asked. If any part fails, none is saved. */
export async function createOperator(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "operator.manage");
  const values = validated(raw);
  const { tricycleId } = parseInput(tricycleChoice, raw);
  const { pin } = parseInput(firstPin, raw);
  const credentialHash = pin ? await hashCredential(pin) : null;
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(operators).values(values).returning({ id: operators.id });
      await auditFrom(ctx, tx, {
        action: "operator.create",
        entityType: "operator",
        entityId: row!.id,
        after: { name: values.name, phone: values.phone },
      });
      if (tricycleId) {
        await issueTricycle(ctx, { ...(raw as object), tricycleId, operatorId: row!.id }, tx);
      }
      if (credentialHash) {
        await saveOperatorLogin(tx, ctx, { id: row!.id, name: values.name, phone: values.phone, userId: null }, credentialHash);
      }
      return row!;
    });
  } catch (error) {
    rethrowConstraint(error, DUPLICATES);
  }
}

export async function updateOperator(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "operator.manage");
  const id = parseInput(idField("operator"), rawId);
  const values = validated(raw);
  try {
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(operators).where(eq(operators.id, id)).for("update");
      if (!before) throw new DomainError("Operator not found.");
      await tx.update(operators).set(values).where(eq(operators.id, id));
      // The portal login uses the same phone number, so they must stay in step.
      if (before.userId) {
        await tx
          .update(users)
          .set({ phone: values.phone, name: values.name })
          .where(eq(users.id, before.userId));
      }
      await auditFrom(ctx, tx, {
        action: "operator.update",
        entityType: "operator",
        entityId: id,
        before,
        after: values,
      });
    });
  } catch (error) {
    rethrowConstraint(error, DUPLICATES);
  }
}

export async function markOperatorLeft(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "operator.manage");
  const id = parseInput(idField("operator"), rawId);
  const { reason } = parseInput(z.object({ reason: requiredText("Reason", 500) }), raw);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(operators).where(eq(operators.id, id)).for("update");
    if (!before) throw new DomainError("Operator not found.");
    const [open] = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.operatorId, id), isNull(assignments.returnedOn)))
      .limit(1);
    if (open) throw new DomainError("This operator still has a tricycle. Return it first.");
    await tx.update(operators).set({ status: "left" }).where(eq(operators.id, id));
    await auditFrom(ctx, tx, {
      action: "operator.left",
      entityType: "operator",
      entityId: id,
      before: { status: before.status },
      after: { status: "left" },
      reason,
    });
  });
}

const OPERATOR_STATUSES = ["active", "sacked", "left"] as const;

export async function listOperators(ctx: Ctx, filter: { q?: string; status?: string } = {}) {
  requirePermission(ctx, "operator.view");
  const conditions: (SQL | undefined)[] = [];
  if (filter.q?.trim()) {
    const pattern = likePattern(filter.q);
    conditions.push(
      or(
        ilike(operators.name, pattern),
        ilike(operators.phone, pattern),
        ilike(tricycles.codeNumber, pattern),
      ),
    );
  }
  const status = OPERATOR_STATUSES.find((s) => s === filter.status);
  if (status) conditions.push(eq(operators.status, status));

  return db
    .select({
      id: operators.id,
      name: operators.name,
      phone: operators.phone,
      status: operators.status,
      tricycleCode: tricycles.codeNumber,
    })
    .from(operators)
    .leftJoin(
      assignments,
      and(eq(assignments.operatorId, operators.id), isNull(assignments.returnedOn)),
    )
    .leftJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
    .where(and(...conditions))
    .orderBy(asc(operators.name))
    .limit(200);
}

/** Active operators with no tricycle: the choices on the issue form. */
export async function listAvailableOperators(ctx: Ctx) {
  requirePermission(ctx, "assignment.manage");
  return db
    .select({ id: operators.id, name: operators.name, phone: operators.phone })
    .from(operators)
    .leftJoin(
      assignments,
      and(eq(assignments.operatorId, operators.id), isNull(assignments.returnedOn)),
    )
    .where(and(eq(operators.status, "active"), isNull(assignments.id)))
    .orderBy(asc(operators.name));
}

export async function getOperator(ctx: Ctx, id: string) {
  requirePermission(ctx, "operator.view");
  const [operator] = await db.select().from(operators).where(eq(operators.id, id)).limit(1);
  if (!operator) return null;

  const history = await db
    .select({
      assignment: assignments,
      codeNumber: tricycles.codeNumber,
      registrationNumber: tricycles.registrationNumber,
    })
    .from(assignments)
    .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
    .where(eq(assignments.operatorId, id))
    .orderBy(desc(assignments.issuedOn), desc(assignments.createdAt));

  const showSensitive = can(ctx.actor.role, "operator.viewSensitive");
  return {
    operator: {
      ...operator,
      address: showSensitive ? operator.address : null,
      guarantorName: showSensitive ? operator.guarantorName : null,
      guarantorPhone: showSensitive ? operator.guarantorPhone : null,
      guarantorAddress: showSensitive ? operator.guarantorAddress : null,
    },
    showSensitive,
    hasPortalLogin: operator.userId !== null,
    history,
  };
}

/**
 * The operator portal. The operator comes only from the login session, so
 * there is no input that could point this at someone else's records.
 */
export async function getMyPortal(ctx: Ctx) {
  requirePermission(ctx, "portal.viewOwn");
  const operatorId = ctx.actor.operatorId;
  if (!operatorId) throw new DomainError("This login is not linked to an operator.");

  const [operator] = await db
    .select({ name: operators.name, phone: operators.phone, status: operators.status })
    .from(operators)
    .where(eq(operators.id, operatorId))
    .limit(1);
  if (!operator) throw new DomainError("Operator not found.");

  const [current] = await db
    .select({
      assignmentId: assignments.id,
      issuedOn: assignments.issuedOn,
      codeNumber: tricycles.codeNumber,
      registrationNumber: tricycles.registrationNumber,
    })
    .from(assignments)
    .innerJoin(tricycles, eq(tricycles.id, assignments.tricycleId))
    .where(and(eq(assignments.operatorId, operatorId), isNull(assignments.returnedOn)))
    .limit(1);

  const dailyBalanceKobo = current
    ? await currentRate(current.assignmentId, businessDate(ctx.clock()))
    : null;
  return { operator, current: current ?? null, dailyBalanceKobo };
}
