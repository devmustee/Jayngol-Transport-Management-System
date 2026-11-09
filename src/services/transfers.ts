import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { moneyTransfers, users } from "@/db/schema";
import { DomainError, fieldError, ForbiddenError, parseInput } from "@/lib/errors";
import { idField, isUuid, optionalText, positiveNairaField, requiredText } from "@/lib/fields";
import { can } from "@/lib/permissions";
import { photoField } from "@/lib/photo";
import { auditFrom } from "./audit";
import { assertCashHeld, lockCashHolder, recordMovement, takeMoneyOut, type BankSide } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { savePhoto } from "./violations";

const placeField = (message: string) =>
  z
    .string(message)
    .refine((value) => value === "bank" || value === "owner" || isUuid(value), message)
    .transform((value) =>
      isUuid(value)
        ? { place: "cash" as const, custodianId: value as string | null }
        : { place: value as BankSide, custodianId: null as string | null },
    );

const transferSchema = z.object({
  from: placeField("Choose where the money is now"),
  to: placeField("Choose where the money is going"),
  amount: positiveNairaField("Amount"),
  reference: optionalText(60),
  note: optionalText(500),
  photo: photoField("Photo"),
});

type Transfer = typeof moneyTransfers.$inferSelect;

async function moveNow(tx: Tx, transfer: Transfer, at: Date, field: string) {
  const base = { amountKobo: transfer.amountKobo, sourceId: transfer.id, at };
  await takeMoneyOut(
    tx,
    {
      ...base,
      custodianId: transfer.fromCustodian,
      account: transfer.fromPlace === "owner" ? "owner" : "bank",
      sourceType: "transfer_out",
    },
    field,
  );
  await recordMovement(tx, {
    ...base,
    custodianId: transfer.toCustodian,
    account: transfer.toPlace === "owner" ? "owner" : "bank",
    sourceType: "transfer_in",
  });
}

/**
 * A handover waits for the receiver, so nobody can be made responsible for cash
 * they never agreed they got. Everything else takes effect at once.
 */
export async function createTransfer(ctx: Ctx, raw: unknown) {
  requirePermission(ctx, "money.transfer");
  const input = parseInput(transferSchema, raw);
  const { from, to } = input;
  if (from.place === to.place && from.custodianId === to.custodianId) {
    throw fieldError("to", "Money cannot move to the same place");
  }
  if (ctx.actor.role !== "manager" && from.custodianId !== ctx.actor.userId) throw new ForbiddenError();

  const deposit = from.place === "cash" && to.place === "bank";
  if (deposit && !input.reference) throw fieldError("reference", "Enter the teller or slip number");
  if (deposit && !input.photo) throw fieldError("photo", "Take a photo of the teller");
  const handover = from.place === "cash" && to.place === "cash";
  const now = ctx.clock();

  return db.transaction(async (tx) => {
    if (to.custodianId) await lockCashHolder(tx, to.custodianId, "to");
    if (from.custodianId) {
      await lockCashHolder(tx, from.custodianId, "from");
      await assertCashHeld(tx, from.custodianId, input.amount, now, "from");
    }
    const photoId = input.photo ? await savePhoto(tx, ctx, input.photo) : null;
    const [transfer] = await tx
      .insert(moneyTransfers)
      .values({
        fromPlace: from.place,
        fromCustodian: from.custodianId,
        toPlace: to.place,
        toCustodian: to.custodianId,
        amountKobo: input.amount,
        reference: input.reference ?? null,
        photoId,
        note: input.note ?? null,
        status: handover ? "pending" : "done",
        createdBy: ctx.actor.userId,
        createdAt: now,
      })
      .returning();
    if (!handover) await moveNow(tx, transfer!, now, "from");
    await auditFrom(ctx, tx, {
      action: "money.transfer",
      entityType: "money_transfer",
      entityId: transfer!.id,
      after: { from: from.custodianId ?? from.place, to: to.custodianId ?? to.place, amountKobo: input.amount },
    });
    return transfer!;
  });
}

async function lockTransfer(tx: Tx, id: string) {
  const [transfer] = await tx.select().from(moneyTransfers).where(eq(moneyTransfers.id, id)).for("update");
  if (!transfer) throw new DomainError("This record was not found.");
  return transfer;
}

/** Field errors have no field on these one-button forms, so the message must stand alone. */
const plainly = (message: string) => (error: unknown) => {
  if (error instanceof DomainError) throw new DomainError(message);
  throw error;
};

export async function acceptTransfer(ctx: Ctx, rawId: unknown) {
  requirePermission(ctx, "money.transfer");
  const id = parseInput(idField("handover"), rawId);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, id);
    if (transfer.status !== "pending") throw new DomainError("This handover has already been decided.");
    if (transfer.toCustodian !== ctx.actor.userId) throw new DomainError("Only the person receiving the cash can accept it.");
    await moveNow(tx, transfer, now, "from").catch(plainly("The sender no longer holds this much cash."));
    await tx
      .update(moneyTransfers)
      .set({ status: "done", decidedBy: ctx.actor.userId, decidedAt: now })
      .where(eq(moneyTransfers.id, id));
    await auditFrom(ctx, tx, { action: "money.accept", entityType: "money_transfer", entityId: id });
  });
}

const reasonSchema = z.object({ reason: requiredText("Reason", 500) });

/** The receiver can refuse a handover, and the sender can withdraw it. */
export async function rejectTransfer(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "money.transfer");
  const id = parseInput(idField("handover"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, id);
    if (transfer.status !== "pending") throw new DomainError("This handover has already been decided.");
    if (transfer.toCustodian !== ctx.actor.userId && transfer.createdBy !== ctx.actor.userId) throw new ForbiddenError();
    await tx
      .update(moneyTransfers)
      .set({ status: "rejected", decidedBy: ctx.actor.userId, decidedAt: now, reason })
      .where(eq(moneyTransfers.id, id));
    await auditFrom(ctx, tx, { action: "money.reject", entityType: "money_transfer", entityId: id, reason });
  });
}

/** Corrects a mistake with a new entry. The original stays on record. */
export async function voidTransfer(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "bank.opening");
  const id = parseInput(idField("record"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, id);
    if (transfer.status !== "done") throw new DomainError("Only a completed move can be reversed.");
    const base = { amountKobo: transfer.amountKobo, sourceId: id, at: now };
    await takeMoneyOut(
      tx,
      {
        ...base,
        custodianId: transfer.toCustodian,
        account: transfer.toPlace === "owner" ? "owner" : "bank",
        sourceType: "transfer_void_out",
      },
      "reason",
    ).catch(plainly("That cash has already left the receiver's hands, so this cannot be reversed today."));
    await recordMovement(tx, {
      ...base,
      custodianId: transfer.fromCustodian,
      account: transfer.fromPlace === "owner" ? "owner" : "bank",
      sourceType: "transfer_void_in",
    });
    await tx
      .update(moneyTransfers)
      .set({ status: "voided", decidedBy: ctx.actor.userId, decidedAt: now, reason })
      .where(eq(moneyTransfers.id, id));
    await auditFrom(ctx, tx, { action: "money.void", entityType: "money_transfer", entityId: id, reason });
  });
}

export async function listTransfers(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const rows = await db.select().from(moneyTransfers).orderBy(desc(moneyTransfers.createdAt)).limit(100);
  const ids = [...new Set(rows.flatMap((row) => [row.fromCustodian, row.toCustodian, row.createdBy]).filter((id) => id !== null))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const nameOf = (id: string | null) => people.find((person) => person.id === id)?.name ?? "";
  const label = (place: string, custodian: string | null) =>
    place === "cash" ? `Cash held by ${nameOf(custodian)}` : place === "bank" ? "Bank" : "Owner";
  const shaped = rows.map((row) => ({
    ...row,
    fromLabel: label(row.fromPlace, row.fromCustodian),
    toLabel: label(row.toPlace, row.toCustodian),
    createdByName: nameOf(row.createdBy),
  }));
  return {
    pending: shaped.filter((row) => row.status === "pending"),
    recent: shaped.filter((row) => row.status !== "pending"),
    userId: ctx.actor.userId,
    canMove: can(ctx.actor.role, "money.transfer"),
    isManager: ctx.actor.role === "manager",
  };
}
