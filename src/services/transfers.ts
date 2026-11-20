import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { moneyTransfers, users } from "@/db/schema";
import { DomainError, fieldError, ForbiddenError, parseInput } from "@/lib/errors";
import { idField, isUuid, optionalText, positiveNairaField, requiredText } from "@/lib/fields";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { photoField } from "@/lib/photo";
import { auditFrom } from "./audit";
import { checkBankHolds } from "./bank";
import { assertCashHeld, lockCashHolder, recordMovement, takeMoneyOut, type BankSide } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { savePhoto } from "./violations";
import { handoverConfirmer, tellCashMoved, tellHandoverRejected, tellHandoverSent } from "./staff-events";

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

/** Whether a person can still hold company cash, and their name for messages. */
async function holder(tx: Tx, id: string) {
  const [row] = await tx
    .select({ name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, id));
  return {
    name: row?.name ?? "This person",
    active: row?.status === "active" && ["manager", "assistant_manager"].includes(row.role),
  };
}

async function placeLabel(tx: Tx, place: string, custodian: string | null) {
  if (place === "cash" && custodian) return `${(await holder(tx, custodian)).name}'s cash`;
  return place === "bank" ? "the Bank" : "the Owner";
}

/** Says in words what a finished move did. */
function doneMessage(from: string, to: string, fromPlace: string, toPlace: string, amount: string) {
  if (fromPlace === "cash" && toPlace === "bank") return `${amount} from ${from} paid into the bank.`;
  if (fromPlace === "cash" && toPlace === "owner") return `${amount} from ${from} handed to the Owner.`;
  if (toPlace === "cash") return `${amount} from ${from} added to ${to}.`;
  return `${amount} moved from ${from} to ${to}.`;
}

/**
 * A handover waits for the person who must agree, so nobody can be made
 * responsible for cash they never agreed they got, or lose cash they never
 * agreed they gave. Everything else takes effect at once.
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
    const bank = from.place === "bank" ? await checkBankHolds(tx, input.amount, "amount") : null;
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
    const fromLabel = await placeLabel(tx, from.place, from.custodianId);
    const toLabel = await placeLabel(tx, to.place, to.custodianId);
    const amount = formatNaira(input.amount);
    let message: string;
    if (handover) {
      await tellHandoverSent(tx, ctx, transfer!);
      const confirmer = handoverConfirmer(transfer!)!;
      message =
        confirmer === to.custodianId
          ? `Waiting for ${(await holder(tx, confirmer)).name} to accept ${amount}.`
          : `Waiting for ${(await holder(tx, confirmer)).name} to confirm they gave you ${amount}.`;
    } else {
      await moveNow(tx, transfer!, now, "from");
      await tellCashMoved(tx, ctx, transfer!, { what: "moved", fromLabel, toLabel });
      message = doneMessage(fromLabel, toLabel, from.place, to.place, amount);
    }
    if (bank && !bank.checked) message += " The bank book has no opening balance yet, so the bank balance was not checked.";
    await auditFrom(ctx, tx, {
      action: "money.transfer",
      entityType: "money_transfer",
      entityId: transfer!.id,
      after: { from: from.custodianId ?? from.place, to: to.custodianId ?? to.place, amountKobo: input.amount },
    });
    return { ...transfer!, message };
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
    const confirmer = handoverConfirmer(transfer);
    if (confirmer !== ctx.actor.userId) {
      throw new DomainError(
        confirmer === transfer.toCustodian
          ? "Only the person receiving the cash can accept it."
          : "The person giving the cash must confirm this handover.",
      );
    }
    for (const id of [transfer.fromCustodian, transfer.toCustodian]) {
      if (!id) continue;
      const person = await holder(tx, id);
      if (!person.active) {
        throw new DomainError(`${person.name} is no longer staff, so this handover cannot be accepted. Refuse it instead.`);
      }
    }
    // Marked done first, so the check of the sender's free cash does not count this handover against itself.
    await tx
      .update(moneyTransfers)
      .set({ status: "done", decidedBy: ctx.actor.userId, decidedAt: now })
      .where(eq(moneyTransfers.id, id));
    await moveNow(tx, transfer, now, "from").catch(plainly("The sender no longer holds this much cash."));
    await auditFrom(ctx, tx, { action: "money.accept", entityType: "money_transfer", entityId: id });
  });
}

const reasonSchema = z.object({ reason: requiredText("Reason", 500) });

/**
 * The person who must agree can refuse a handover. The person who recorded it,
 * and the person whose cash it is, can withdraw it.
 */
export async function rejectTransfer(ctx: Ctx, rawId: unknown, raw: unknown) {
  requirePermission(ctx, "money.transfer");
  const id = parseInput(idField("handover"), rawId);
  const { reason } = parseInput(reasonSchema, raw);
  const now = ctx.clock();
  await db.transaction(async (tx) => {
    const transfer = await lockTransfer(tx, id);
    if (transfer.status !== "pending") throw new DomainError("This handover has already been decided.");
    const allowed = [handoverConfirmer(transfer), transfer.createdBy, transfer.fromCustodian];
    if (!allowed.includes(ctx.actor.userId)) throw new ForbiddenError();
    await tx
      .update(moneyTransfers)
      .set({ status: "rejected", decidedBy: ctx.actor.userId, decidedAt: now, reason })
      .where(eq(moneyTransfers.id, id));
    await auditFrom(ctx, tx, { action: "money.reject", entityType: "money_transfer", entityId: id, reason });
    await tellHandoverRejected(tx, ctx, transfer, reason);
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
    for (const id of [transfer.fromCustodian, transfer.toCustodian]) {
      if (!id) continue;
      const person = await holder(tx, id);
      if (!person.active) {
        throw new DomainError(
          `${person.name} is no longer staff, so this move cannot be reversed. Record the correction as a new move instead.`,
        );
      }
    }
    if (transfer.toPlace === "bank") {
      await checkBankHolds(tx, transfer.amountKobo, "reason").catch(
        plainly("The bank book no longer holds this much, so this cannot be reversed."),
      );
    }
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
    await tellCashMoved(tx, ctx, transfer, {
      what: "reversed",
      fromLabel: await placeLabel(tx, transfer.fromPlace, transfer.fromCustodian),
      toLabel: await placeLabel(tx, transfer.toPlace, transfer.toCustodian),
      reason,
    });
  });
}

export async function listTransfers(ctx: Ctx) {
  requirePermission(ctx, "finance.view");
  const [pendingRows, doneRows] = await Promise.all([
    db.select().from(moneyTransfers).where(eq(moneyTransfers.status, "pending")).orderBy(desc(moneyTransfers.createdAt)),
    db.select().from(moneyTransfers).orderBy(desc(moneyTransfers.createdAt)).limit(100),
  ]);
  const rows = [...pendingRows, ...doneRows.filter((row) => row.status !== "pending")];
  const ids = [...new Set(rows.flatMap((row) => [row.fromCustodian, row.toCustodian, row.createdBy]).filter((id) => id !== null))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const nameOf = (id: string | null) => people.find((person) => person.id === id)?.name ?? "";
  const label = (place: string, custodian: string | null) =>
    place === "cash" ? `Cash held by ${nameOf(custodian)}` : place === "bank" ? "Bank" : "Owner";
  const shaped = rows.map((row) => {
    const confirmer = handoverConfirmer(row);
    return {
      ...row,
      fromLabel: label(row.fromPlace, row.fromCustodian),
      toLabel: label(row.toPlace, row.toCustodian),
      createdByName: nameOf(row.createdBy),
      confirmer,
      confirmerName: nameOf(confirmer),
      /** The giver confirms, rather than the receiver, when the receiver recorded it. */
      giverConfirms: confirmer !== null && confirmer !== row.toCustodian,
    };
  });
  return {
    pending: shaped.filter((row) => row.status === "pending"),
    recent: shaped.filter((row) => row.status !== "pending"),
    userId: ctx.actor.userId,
    canMove: can(ctx.actor.role, "money.transfer"),
    isManager: ctx.actor.role === "manager",
  };
}
