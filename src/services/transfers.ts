import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { moneyTransfers, paymentReferences, users } from "@/db/schema";
import { asPgError, DomainError, fieldError, ForbiddenError, parseInput } from "@/lib/errors";
import { idField, isUuid, optionalText, positiveNairaField, requiredText } from "@/lib/fields";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { photoField } from "@/lib/photo";
import { auditFrom } from "./audit";
import { bankAndOwnerHeld, checkBankHolds } from "./bank";
import { assertCashHeld, lockCashHolder, recordMovement, takeMoneyOut, type BankSide } from "./cash-book";
import { requirePermission, type Ctx } from "./context";
import { savePhoto } from "./violations";
import { handoverConfirmer, tellCashMoved, tellHandoverRejected, tellHandoverSent, tellOwnerOfMove } from "./staff-events";

const placeField = (message: string) =>
  z
    .string(message)
    .refine((value) => value === "bank" || value === "owner" || isUuid(value), message)
    .transform((value) =>
      isUuid(value)
        ? { place: "cash" as const, custodianId: value as string | null }
        : { place: value as BankSide, custodianId: null as string | null },
    );

/** Spaces are ignored and letters uppercased, so a teller number always matches itself however it is typed. */
const referenceField = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/\s+/g, "").toUpperCase() : value),
  optionalText(60),
);

const transferSchema = z.object({
  from: placeField("Choose where the money is now"),
  to: placeField("Choose where the money is going"),
  amount: positiveNairaField("Amount"),
  reference: referenceField,
  /** Made by the form when it opens. Old forms without one still save, without the double-tap guard. */
  clientId: z.preprocess((value) => (value === "" ? undefined : value), z.uuid().optional()),
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
 * A move into someone's cash waits for them to accept it, unless they record
 * it themselves: nobody is made responsible for cash they never agreed they
 * got, or loses cash they never agreed they gave. Moves into the bank or to
 * the Owner take effect at once. A teller deposit goes on the Bank check, and
 * its teller number can be used only once.
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
  const waits = to.place === "cash" && (from.place === "cash" || to.custodianId !== ctx.actor.userId);
  const now = ctx.clock();

  try {
    return await db.transaction(async (tx) => {
      if (input.clientId) {
        const [already] = await tx.select().from(moneyTransfers).where(eq(moneyTransfers.clientId, input.clientId));
        if (already && already.createdBy !== ctx.actor.userId) throw new ForbiddenError();
        if (already) return { ...already, message: "This move was already saved." };
      }
      if (to.custodianId) await lockCashHolder(tx, to.custodianId, "to");
      if (from.custodianId) {
        await lockCashHolder(tx, from.custodianId, "from");
        await assertCashHeld(tx, from.custodianId, input.amount, now, "from");
      }
      const bank = from.place === "bank" ? await checkBankHolds(tx, input.amount, "amount") : null;
      if (deposit) await refuseUsedTeller(tx, input.reference!);
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
          status: waits ? "pending" : "done",
          createdBy: ctx.actor.userId,
          createdAt: now,
          clientId: input.clientId ?? null,
        })
        .returning();
      if (deposit) await tx.insert(paymentReferences).values({ transferId: transfer!.id, reference: input.reference! });
      const fromLabel = await placeLabel(tx, from.place, from.custodianId);
      const toLabel = await placeLabel(tx, to.place, to.custodianId);
      const amount = formatNaira(input.amount);
      let message: string;
      if (waits) {
        await tellHandoverSent(tx, ctx, transfer!);
        const confirmer = handoverConfirmer(transfer!)!;
        message =
          confirmer === to.custodianId
            ? `Waiting for ${(await holder(tx, confirmer)).name} to accept ${amount}.`
            : `Waiting for ${(await holder(tx, confirmer)).name} to confirm they gave you ${amount}.`;
      } else {
        await moveNow(tx, transfer!, now, "from");
        await tellCashMoved(tx, ctx, transfer!, { what: "moved", fromLabel, toLabel });
        await tellOwnerOfMove(tx, ctx, transfer!, { what: "moved", fromLabel, toLabel });
        message = doneMessage(fromLabel, toLabel, from.place, to.place, amount);
        if (deposit) message += " It now waits on the Bank check.";
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
  } catch (error) {
    const constraint = asPgError(error)?.constraint_name;
    if (constraint === "one_live_reference") throw usedTeller();
    // Two taps raced: the first one's move is the answer.
    if (constraint === "money_transfers_client_unique" && input.clientId) {
      const [winner] = await db.select().from(moneyTransfers).where(eq(moneyTransfers.clientId, input.clientId));
      if (winner) return { ...winner, message: "This move was already saved." };
    }
    throw error;
  }
}

const usedTeller = () => fieldError("reference", "This teller or slip number has already been used");

/**
 * Teller deposits saved before the Bank check listed them have no reference
 * row, so their numbers are checked here too. Newer ones are kept unique by the
 * reference index, which also covers the race of two saves at once.
 */
async function refuseUsedTeller(tx: Tx, reference: string) {
  const [used] = await tx
    .select({ id: moneyTransfers.id })
    .from(moneyTransfers)
    .where(
      and(
        eq(moneyTransfers.fromPlace, "cash"),
        eq(moneyTransfers.toPlace, "bank"),
        ne(moneyTransfers.status, "voided"),
        sql`upper(regexp_replace(${moneyTransfers.reference}, '[[:space:]]', '', 'g')) = ${reference}`,
      ),
    )
    .limit(1);
  if (used) throw usedTeller();
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
    if (transfer.fromPlace === "bank") {
      await checkBankHolds(tx, transfer.amountKobo, "from").catch(plainly("The bank book no longer holds this much."));
    }
    // Marked done first, so the check of the sender's free cash does not count this handover against itself.
    await tx
      .update(moneyTransfers)
      .set({ status: "done", decidedBy: ctx.actor.userId, decidedAt: now })
      .where(eq(moneyTransfers.id, id));
    await moveNow(tx, transfer, now, "from").catch(plainly("The sender no longer holds this much cash."));
    await auditFrom(ctx, tx, { action: "money.accept", entityType: "money_transfer", entityId: id });
    await tellOwnerOfMove(tx, ctx, transfer, {
      what: "moved",
      fromLabel: await placeLabel(tx, transfer.fromPlace, transfer.fromCustodian),
      toLabel: await placeLabel(tx, transfer.toPlace, transfer.toCustodian),
    });
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
    // Its teller number is free again, and it leaves the Bank check.
    await tx.update(paymentReferences).set({ releasedAt: now }).where(eq(paymentReferences.transferId, id));
    await auditFrom(ctx, tx, { action: "money.void", entityType: "money_transfer", entityId: id, reason });
    const how = {
      what: "reversed" as const,
      fromLabel: await placeLabel(tx, transfer.fromPlace, transfer.fromCustodian),
      toLabel: await placeLabel(tx, transfer.toPlace, transfer.toCustodian),
      reason,
    };
    await tellCashMoved(tx, ctx, transfer, how);
    await tellOwnerOfMove(tx, ctx, transfer, how);
  });
}

export const MOVES_PER_PAGE = 40;

/** Handovers waiting, and the decided moves a page at a time, newest first. */
export async function listTransfers(ctx: Ctx, options: { page?: number } = {}) {
  requirePermission(ctx, "finance.view");
  const page = Math.max(1, Math.floor(options.page ?? 1)) || 1;
  const decided = ne(moneyTransfers.status, "pending");
  const [pendingRows, doneRows, [count], held] = await Promise.all([
    db.select().from(moneyTransfers).where(eq(moneyTransfers.status, "pending")).orderBy(desc(moneyTransfers.createdAt)),
    db
      .select()
      .from(moneyTransfers)
      .where(decided)
      .orderBy(desc(moneyTransfers.createdAt), desc(moneyTransfers.id))
      .limit(MOVES_PER_PAGE)
      .offset((page - 1) * MOVES_PER_PAGE),
    db.select({ total: sql<number>`count(*)::int` }).from(moneyTransfers).where(decided),
    ctx.actor.role === "manager" ? bankAndOwnerHeld(db) : null,
  ]);
  const rows = [...pendingRows, ...doneRows];
  const ids = [
    ...new Set(
      rows.flatMap((row) => [row.fromCustodian, row.toCustodian, row.createdBy, row.decidedBy]).filter((id) => id !== null),
    ),
  ];
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
      decidedByName: row.decidedBy ? nameOf(row.decidedBy) : null,
      confirmer,
      confirmerName: nameOf(confirmer),
      /** The giver confirms, rather than the receiver, when the receiver recorded it. */
      giverConfirms: confirmer !== null && confirmer !== row.toCustodian,
    };
  });
  return {
    pending: shaped.filter((row) => row.status === "pending"),
    recent: shaped.filter((row) => row.status !== "pending"),
    page,
    total: count?.total ?? 0,
    pages: Math.max(1, Math.ceil((count?.total ?? 0) / MOVES_PER_PAGE)),
    held,
    userId: ctx.actor.userId,
    canMove: can(ctx.actor.role, "money.transfer"),
    isManager: ctx.actor.role === "manager",
  };
}
