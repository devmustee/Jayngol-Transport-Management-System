import { asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { operators, sessions, users } from "@/db/schema";
import { DomainError, fieldError, parseInput, rethrowConstraint } from "@/lib/errors";
import { idField, passwordField, phoneField, pinField, requiredText } from "@/lib/fields";
import { auditFrom } from "./audit";
import { hashCredential, verifyCredential } from "./auth";
import { requirePermission, type Ctx } from "./context";

const PHONE_TAKEN = {
  users_phone_unique: fieldError("phone", "This phone number already has a login"),
};

const staffSchema = z.object({
  name: requiredText("Name"),
  phone: phoneField(),
  role: z.enum(
    ["owner", "manager", "assistant_manager", "supervisor"],
    "Choose a role",
  ),
  password: passwordField,
});

export async function listStaff(ctx: Ctx) {
  requirePermission(ctx, "user.manage");
  return db
    .select({
      id: users.id,
      name: users.name,
      phone: users.phone,
      role: users.role,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(ne(users.role, "operator"))
    .orderBy(asc(users.name));
}

export async function createStaff(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "user.manage");
  const { password, ...input } = parseInput(staffSchema, raw);
  const credentialHash = await hashCredential(password);
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ ...input, credentialHash })
        .returning({ id: users.id });
      await auditFrom(ctx, tx, {
        action: "user.create",
        entityType: "user",
        entityId: user!.id,
        after: input,
      });
      return user!;
    });
  } catch (error) {
    rethrowConstraint(error, PHONE_TAKEN);
  }
}

async function getStaffTarget(id: string) {
  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target || target.role === "operator") throw new DomainError("Staff member not found.");
  return target;
}

export async function setStaffStatus(ctx: Ctx, id: string, status: "active" | "disabled") {
  requirePermission(ctx, "user.manage");
  if (id === ctx.actor.userId) throw new DomainError("You cannot disable your own login.");
  const target = await getStaffTarget(id);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ status }).where(eq(users.id, id));
    if (status === "disabled") await tx.delete(sessions).where(eq(sessions.userId, id));
    await auditFrom(ctx, tx, {
      action: "user.status",
      entityType: "user",
      entityId: id,
      before: { status: target.status },
      after: { status },
    });
  });
}

export async function resetStaffPassword(ctx: Ctx, id: string, raw: unknown) {
  requirePermission(ctx, "user.manage");
  const { password } = parseInput(z.object({ password: passwordField }), raw);
  await getStaffTarget(id);
  const credentialHash = await hashCredential(password);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ credentialHash, failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, id));
    await tx.delete(sessions).where(eq(sessions.userId, id));
    await auditFrom(ctx, tx, {
      action: "user.reset_password",
      entityType: "user",
      entityId: id,
    });
  });
}

export async function changeOwnPassword(ctx: Ctx, raw: unknown) {
  const input = parseInput(
    z.object({ currentPassword: z.string("Enter your current password"), password: passwordField }),
    raw,
  );
  const [me] = await db.select().from(users).where(eq(users.id, ctx.actor.userId)).limit(1);
  if (!me || !(await verifyCredential(input.currentPassword, me.credentialHash))) {
    throw fieldError("currentPassword", "Current password is not correct");
  }
  const credentialHash = await hashCredential(input.password);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ credentialHash }).where(eq(users.id, me.id));
    await auditFrom(ctx, tx, {
      action: "user.change_password",
      entityType: "user",
      entityId: me.id,
    });
  });
}

/** Creates the operator's login on first use, and replaces the PIN afterwards. */
export async function saveOperatorLogin(
  tx: Tx,
  ctx: Ctx,
  operator: { id: string; name: string; phone: string; userId: string | null },
  credentialHash: string,
) {
  if (operator.userId) {
    await tx
      .update(users)
      .set({ credentialHash, failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, operator.userId));
    await tx.delete(sessions).where(eq(sessions.userId, operator.userId));
  } else {
    const [user] = await tx
      .insert(users)
      .values({ name: operator.name, phone: operator.phone, role: "operator", credentialHash })
      .returning({ id: users.id });
    await tx.update(operators).set({ userId: user!.id }).where(eq(operators.id, operator.id));
  }
  await auditFrom(ctx, tx, {
    action: "operator.set_pin",
    entityType: "operator",
    entityId: operator.id,
  });
}

/** Creates the operator's login on first use, and resets the PIN afterwards. */
export async function setOperatorPin(ctx: Ctx, rawOperatorId: unknown, raw: unknown) {
  requirePermission(ctx, "operator.manage");
  const operatorId = parseInput(idField("operator"), rawOperatorId);
  const { pin } = parseInput(z.object({ pin: pinField }), raw);
  const credentialHash = await hashCredential(pin);
  try {
    await db.transaction(async (tx) => {
      const [operator] = await tx
        .select()
        .from(operators)
        .where(eq(operators.id, operatorId))
        .for("update");
      if (!operator) throw new DomainError("Operator not found.");

      await saveOperatorLogin(tx, ctx, operator, credentialHash);
    });
  } catch (error) {
    rethrowConstraint(error, {
      users_phone_unique: new DomainError(
        "This phone number is already used by another login.",
      ),
    });
  }
}
