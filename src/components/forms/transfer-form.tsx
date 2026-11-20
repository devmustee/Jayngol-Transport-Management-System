"use client";

import { useEffect, useRef, useState } from "react";
import { createTransferAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { PhotoInput } from "@/components/photo-input";
import { formatNaira, parseNairaToKobo } from "@/lib/money";

type Person = { id: string; name: string; availableKobo: number; heldKobo: number; waitingKobo: number };

const isPerson = (value: string) => value !== "" && value !== "bank" && value !== "owner";

/**
 * Records a move. Only the fields that matter for the chosen move are shown,
 * the To list leaves out the place chosen in From, and the cash left free
 * follows what is typed. The server checks everything again.
 */
export function TransferForm({
  from,
  people,
  isManager,
  me = null,
  held = null,
}: {
  from: Person[];
  people: Person[];
  isManager: boolean;
  /** The person recording, who needs no acceptance for cash they record for themselves. */
  me?: string | null;
  /** What the bank book and the Owner hold. The bank figure is null before an opening balance is set. */
  held?: { bankKobo: number | null; ownerKobo: number } | null;
}) {
  const [source, setSource] = useState("");
  // A new one after each save, so a second tap of Save records the move only once.
  // Made in the browser after it loads, so the page the server sent still matches.
  const [clientId, setClientId] = useState("");
  useEffect(() => setClientId(crypto.randomUUID()), []);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const anchor = useRef<HTMLDivElement>(null);

  // The form clears itself after a save, so the choices here clear with it.
  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    const clear = () => {
      setSource("");
      setTarget("");
      setAmount("");
      setClientId(crypto.randomUUID());
    };
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  const giver = people.find((person) => person.id === source) ?? null;
  const amountKobo = amount.trim() === "" ? 0 : (parseNairaToKobo(amount) ?? 0);
  const intoBank = isPerson(source) && target === "bank";
  const outOfBank = source === "bank" && isPerson(target);
  const handover = isPerson(source) && isPerson(target);
  const left = giver ? giver.availableKobo - amountKobo : 0;

  return (
    <ActionForm action={createTransferAction}>
      <input type="hidden" name="clientId" value={clientId} />
      <div ref={anchor} className="grid gap-4 sm:grid-cols-2">
        <SelectField name="from" label="From" value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="" disabled>Choose…</option>
          {from.map((person) => (
            <option key={person.id} value={person.id}>
              Cash held by {person.name} ({formatNaira(Math.max(person.availableKobo, 0))}
              {person.waitingKobo > 0 ? ` free, ${formatNaira(person.waitingKobo)} waiting` : ""})
            </option>
          ))}
          {isManager ? (
            <option value="bank">Bank{held?.bankKobo != null ? ` (book shows ${formatNaira(held.bankKobo)})` : ""}</option>
          ) : null}
          {isManager ? (
            <option value="owner">Owner{held ? ` (${formatNaira(Math.max(held.ownerKobo, 0))} handed over)` : ""}</option>
          ) : null}
        </SelectField>
        <SelectField name="to" label="To" value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="" disabled>Choose…</option>
          {source !== "bank" ? <option value="bank">Bank</option> : null}
          {source !== "owner" ? <option value="owner">Owner (cash handed over)</option> : null}
          {people
            .filter((person) => person.id !== source)
            .map((person) => (
              <option key={person.id} value={person.id}>Cash held by {person.name}</option>
            ))}
        </SelectField>
      </div>
      <Field
        name="amount"
        label="Amount (₦)"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />
      {giver && amountKobo > 0 ? (
        left >= 0 ? (
          <p className="text-sm text-muted" aria-live="polite">
            {giver.name} will have {formatNaira(left)} free left.
          </p>
        ) : (
          <p className="text-sm font-semibold text-danger" aria-live="polite">
            {giver.name} has only {formatNaira(Math.max(giver.availableKobo, 0))} free
            {giver.waitingKobo > 0 ? ` (${formatNaira(giver.waitingKobo)} is waiting in handovers)` : ""}.
          </p>
        )
      ) : null}
      {handover ? (
        <p className="text-sm text-muted">
          A handover waits until the other person confirms it. The cash stays with {giver?.name ?? "the giver"} until then.
        </p>
      ) : null}
      {(source === "bank" || source === "owner") && isPerson(target) && target !== me ? (
        <p className="text-sm text-muted">
          {people.find((person) => person.id === target)?.name ?? "They"} must accept this cash before it counts as theirs.
        </p>
      ) : null}
      {target === "owner" ? <p className="text-sm text-muted">The Owner is told of this move.</p> : null}
      {intoBank ? (
        <>
          <Field name="reference" label="Teller or slip number" autoComplete="off" />
          <PhotoInput name="photo" label="Teller photo" />
        </>
      ) : null}
      {outOfBank ? <Field name="reference" label="Withdrawal or transfer number (optional)" autoComplete="off" /> : null}
      <TextareaField name="note" label="Note (optional)" />
      <SubmitButton>Save</SubmitButton>
    </ActionForm>
  );
}
