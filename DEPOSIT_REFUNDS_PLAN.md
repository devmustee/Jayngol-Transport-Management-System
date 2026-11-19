# Jayngol Plan: Giving Deposits Back

Status: Built (20 Nov 2026) with the suggested answers, not yet released.

**As built:**
- **Operator's page:** once the operator has left or been sacked and the tricycle is back, a **Settle deposit** section shows the deposit, each debt with a tick box, what clears debts and what is given back. The figures follow the ticks and the amount typed. "Given back from" offers a person's cash or the bank, with an optional reference. Anything kept asks why.
- **After saving:** the deposit reads **Settled**, a "Deposit settlements" card shows what cleared debts (with its receipt), what was given back and from where, and what was kept and why. **Undo settlement** shows on the same day only.
- **Receipt:** the debts are cleared by a receipt with method "From deposit", which adds no cash or bank money. Its own **Reverse** is refused; the settlement is undone instead. A settled deposit cannot be reversed either.
- **Deposits page:** Total held leaves out settled deposits, with "To settle" and "Settled" lists. **Home** shows "N deposits to settle" to the Manager.
- **Money figures:** Money received includes "From deposit" (noted as no new money) on Home, in Reports and in the Annual balance, which also shows Deposits given back and Deposits kept. Deposits kept count in Net.
- **Owner:** told when more than ₦50,000 is given back ("Large deposit given back").
- **Operator portal:** shows Settled and the settlement lines. An operator who has left can no longer sign in, so this matters only if they are taken back.
- **Code:** src/services/deposit-settlements.ts and src/components/forms/deposit-settle-form.tsx, migration 0032. Covered by tests/deposit-settlements.test.ts.
- **Receipt number:** the receipt uses the normal "R-" numbers, not "DEP-…-S" as first written below.

## 1. What happens today

- **Recording a deposit:** **Record deposit** saves money an operator gives the company to hold, with a receipt. Cash stays with the person who received it, and POS or transfer goes to the bank.
- **Not income:** a deposit is not counted as money collected and pays nothing.
- **Mistakes:** the Manager can reverse a deposit entered by mistake. The receipt stays, and the money comes back out of the cash or bank it went into.
- **What is missing:**
  - There is no way to give a deposit back.
  - There is no way to use it to clear what the operator owes when they leave.
  - So once taken, a deposit sits as "held" for ever.
- **On production:** nothing has been recorded yet (Total held ₦0), so nothing needs fixing in existing records.

## 2. How it will work

**When.** A deposit is settled when the operator stops working: after **Mark as left**, or after a sacking is confirmed, once the tricycle is back (question 1).

**Settle deposit.** This is a new section on the operator's page, shown once they have left and a deposit is held. It shows:

| Line | Example |
| --- | --- |
| Deposit held | ₦50,000 |
| Unpaid balances | ₦24,000 (3 days) |
| Unpaid fines | ₦3,000 |
| Loan left | ₦10,000 |
| Weekly contributions unpaid | ₦2,500 |
| **Used to clear what is owed** | **₦39,500** |
| **To give back** | **₦10,500** |

**Choosing what to clear:**
- Each debt has a tick box, ticked by default.
- The Manager can untick a debt to leave it owed. For example, a fine the Manager plans to waive.
- The figures update as boxes are ticked.
- The oldest debts are cleared first. If the deposit is smaller than what is owed, it all goes to debts, nothing is given back, and the rest stays owed.

**Giving back:**
- The Manager chooses where the money comes from: cash held by a named person, or the bank.
- If paid by transfer, the Manager adds the reference.
- The Manager can give back less than "To give back", with a reason (question 3). Whatever is kept is recorded as **Deposit kept**, with that reason.
- **Save settlement** then does everything in one step:
  - **Debts cleared:** a receipt "Paid from deposit" (for example DEP-000012-S) clears the ticked debts. It counts as money received that day, marked as from a deposit, so the money-in figures still add up (question 4).
  - **Money given back:** what is given back leaves the chosen cash or bank, like an expense, and shows in the cash book as "Deposit given back".
  - **Notice:** the operator gets one on their portal: "Your deposit of ₦50,000: ₦39,500 cleared what you owed, ₦10,500 given back on 20 Nov 2026."
  - **Owner:** the owner is told when the amount given back is over ₦50,000, as with large expenses.
- After saving, the deposit reads **Settled** and no longer counts in Total held.

**Mistakes.** The Manager can undo a settlement on the same day it was saved:
- the debts open again;
- the money given back is put back where it came from;
- the deposit is held again.

From the next day it is final, like an approved expense.

**Who can do it.** Only the Manager settles a deposit. The Assistant Manager and the owner can view settlements (question 2).

## 3. Screens

- **Operator deposits page:**
  - "Total held" counts only deposits not yet settled.
  - A new list, "To settle", shows operators who have left with a deposit still held, oldest first.
  - Settled deposits sit under "Settled", each with what cleared debts, what was given back and what was kept.
- **Operator's page:** the Deposit card shows "Held", "Settled" or "Partly kept", and **Settle deposit** once the operator has left.
- **Home (Manager):** "N deposits to settle" while anyone who left still has a deposit held.
- **Operator portal:** shows the deposit, then the settlement, line by line.
- **Reports and annual balance:** "Deposits given back" appears as money out, and "Paid from deposit" appears as money in from deposits.

## 4. Data

- **New table:** `deposit_settlements`, one row per settled deposit. It records what cleared debts, what was given back and where from, what was kept and why, who settled it and when.
- **Debts cleared:** a payment with method "deposit" clears the ticked debts, so receipts, the arrears list and the operator's statement need no new rules. That payment does not add money to cash or bank, since the deposit already did.
- **Money given back:** a cash or bank movement out, with source "deposit_refund".
- **Migration:** a new migration, numbered after 0028, with its journal date after the last one.

## 5. Questions for the owner

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | When can a deposit be given back? | Only after the operator has left or been sacked and the tricycle is back. Not while they are still working. |
| 2 | Who settles a deposit? | The Manager only. The owner is told when more than ₦50,000 is given back. |
| 3 | Can the company keep part of a deposit beyond what is owed, for example for damage to the tricycle? | Yes, with a reason the Manager writes, for example "Broken windscreen, ₦8,000". It is recorded as Deposit kept and counts as income that day. |
| 4 | Should debts cleared from a deposit count in "money received" on Home and in reports? | Yes, marked "from deposit", so it is clear no new cash came in. |
| 5 | If an operator who left comes back (reinstated), what happens to a settled deposit? | Nothing. They make a new deposit when they start again. |

## 6. Work and tests

One day.

- A ₦50,000 deposit for an operator owing ₦39,500: settling clears every ticked debt, gives back ₦10,500 from the chosen source, and leaves Total held lower by ₦50,000.
- Unticking a fine leaves it owed and adds its amount to what is given back.
- A deposit smaller than the debts clears the oldest first, gives nothing back, and leaves the rest owed.
- Keeping part needs a reason, and it shows as Deposit kept.
- Settling is refused while the operator still works or still holds a tricycle, and for anyone but the Manager.
- Undo on the same day restores the debts, the money and the held deposit. From the next day undo is refused.
- The cash book, the operator's statement, the arrears list and the annual balance all match after a settlement.
- The operator's portal shows the settlement, and every form works at 360 px.
