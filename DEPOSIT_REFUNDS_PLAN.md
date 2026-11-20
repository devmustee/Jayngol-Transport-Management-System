# Jayngol Plan: Giving Deposits Back

Status: Released 20 Nov 2026 (settle when the operator leaves). **Section 0 built 20 Nov 2026, not yet released:** monthly savings refunded every month end, with damage deductions.

**As built (section 0):**
- **Renamed for staff:** Deposits now read as **Operator savings**, **Record saving** and **Give back savings**. The operator's page has a **Savings** card with "Saved this month: ₦… · given back on 30 Nov".
- **When savings fall due:**
  - On the month end, everything a working operator has saved is due.
  - Savings from an earlier month that were never given back are due on any day.
  - A leaver's savings are due once the tricycle is back.
  - Anything saved after the refund on the month end waits for the next month.
- **Give back savings form:** tick boxes for debts, then **Damage to the tricycle** (amount, what was damaged, Done on purpose), then the source.
  - If the damage is more than what is left, the form shows "₦40,000 damage: ₦23,000 from the savings, ₦17,000 owed as a fine".
  - That rest becomes a fine straight away. Undo removes it, unless part of it has been paid.
- **Operator savings page:**
  - **To give back** has a tick box per operator, with **Give back all** from one source and the totals shown.
  - Operators with a workshop job this month start unticked, marked "check for damage".
  - A leaver still holding a tricycle can't be ticked.
  - **Not saving this month** lists working operators with nothing saved.
- **Home:** shows "N operators to give savings back to · ₦…", with "Overdue" from the 7th for savings left from an earlier month.
- **Notices:**
  - The operator's notice names any damage and ends with "Start saving for December".
  - Working operators with nothing saved get a reminder on the 5th.
  - The owner is told of damage over ₦20,000, and of more than ₦50,000 given back at once (one notice for **Give back all**).
- **Reports and Annual balance:** "Deposits kept" now reads "Deposits kept for damage".
- **Data:** migration 0034 adds `damage_on_purpose` and `damage_charge_id` to `deposit_settlements`.
- **Not done:**
  - The damage fine shows as an ordinary fine on the statement. Its name ("Damage: …") is on the refund record and in the operator's notice, because fines have no name of their own.
  - The operator portal doesn't show "Saved this month" yet; it shows the savings list and each refund.

## 0. Change: monthly savings, refunded every month end

The owner wants deposits to work as monthly savings. Operators save during the month, get it all back at the month end, and start saving again for the new month, every month.

**How it will work:**
1. **Operators save through the month.** An operator can make several deposits in a month, for example ₦1,000 a day. Each one gets its own DEP receipt, as now. Their page and portal show "Saved this month: ₦…".
2. **Month end is refund day.** From the last day of the month, everything an operator has saved is due back.
   - This applies even while the operator is working.
   - Home shows "N operators to refund for November · ₦…".
   - Operator deposits lists them under **To refund this month**.
3. **Refunding is the same as settling now**, from the operator's page:
   - tick boxes for unpaid balances, fines, loan and contributions, oldest debt cleared first;
   - damage deducted if any (item 7);
   - the rest given back from a person's cash or the bank;
   - a "From deposit" receipt for the debts cleared;
   - the operator is told;
   - undo on the same day only.
4. **Then saving starts again.** The next deposit counts towards the new month. The refund notice ends with "Start saving for December".
   - A deposit made on refund day after the refund counts towards the next month.
   - No one is forced to save (question 1). On the 5th of each month, a working operator with no saving yet gets a reminder, and the Deposits page shows "Not saving this month".
5. **Refund all.** Above the list, **Refund all for November** refunds every listed operator in one step:
   - every debt is ticked;
   - the money comes from one chosen source;
   - every operator has a tick box, so anyone with damage to deduct can be unticked and refunded on their own.

   It shows the totals first: "12 operators · ₦600,000 saved · ₦85,000 clears debts · ₦515,000 to give back". If the chosen cash is too small, it says so before saving.
6. **Not refunded on the day.** A refund still waiting is not blocked. Home keeps the notice, and from the 7th of the next month it turns gold with "Overdue" (question 4). Deposits made meanwhile still count towards the new month.
6a. **Leaving.** When an operator leaves or is sacked and the tricycle is back, everything saved is due at once, as now.

7. **Deduct for damage.** If the operator damaged the tricycle, on purpose or through carelessness, the Manager takes the cost out of the deposit, and the operator gets what remains.
   - The settle form gets its own **Damage to the tricycle** line, under the debts:
     - **Amount (₦)** to deduct;
     - **What was damaged**, for example "Broken windscreen" (needed when an amount is entered);
     - **On purpose?**, a Yes/No tick that is recorded for the operator's history (question 5).
   - The figures then read:

     | Line | Example |
     | --- | --- |
     | Deposit held | ₦50,000 |
     | Used to clear what is owed | ₦12,000 |
     | Deducted for damage: broken windscreen | ₦8,000 |
     | **To give back** | **₦30,000** |

   - **When the damage costs more than what is left:** the deposit covers what it can, and the rest is added straight away as a debt the operator owes (question 6).
     - The debt is a fine named "Damage: broken windscreen", so it shows with fines on the operator's statement, debt list and portal.
     - It is paid like any fine.
     - The form shows it before saving: "₦30,000 damage: ₦18,000 from the deposit, ₦12,000 owed as a fine".
   - It replaces the current "give back less, then say why" step, which is easy to miss. "To give back" is always the deposit less debts less damage, so it can no longer be lowered on its own.
   - **The operator's notice and portal show the deduction line by line:** "₦8,000 deducted for damage: broken windscreen. ₦30,000 given back."
   - **Refund all** lists each operator with a tick box, all ticked. Before saving, the Manager unticks anyone with damage to deduct, then settles them one by one with the deduction. An operator whose tricycle had a workshop job this month is marked "Workshop job this month: check for damage".
   - **Money:** a damage deduction is company income on the day, shown as "Deposits kept for damage" in Reports and the Annual balance. It is the same figure as today's "Deposits kept", renamed.
   - **Workshop link:** if the tricycle has a workshop job this month, the form shows it ("Workshop: windscreen replaced, 18 Nov"), so the Manager can match the deduction to the repair. Linking is a hint only; the Manager types the amount.

**What stays the same:**
- Only the Manager settles. The Assistant Manager and the owner can see the lists.
- The owner is told about anything over ₦50,000 given back at once. For **Refund all**, that means one notice with the total.
- The receipt, the cash book, Total held and the reports work as now.

**Questions for the owner:**

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | Must every working operator save each month? | **Owner's answer:** remind only. The app reminds them and shows who is not saving, but does not block work. |
| 2 | When are savings given back? | **Owner's answer:** every month end. Operators get everything saved back, then start saving for the new month, continuously. Refund one by one or with **Refund all**. |
| 3 | Is money saved on the last day of the month refunded that day? | Yes, if it comes in before the refund. If it comes in after, it counts towards the next month. |
| 4 | What if the Manager does not refund on the last day? | Nothing is blocked. Home keeps the notice, and from the 7th it turns gold with "Overdue". |
| 5 | Does damage on purpose count against the operator beyond the deduction? | It is recorded on the operator's page as "Damage on purpose" with the date and amount. It does not raise an offence by itself; the Manager can record one too. |
| 6 | Damage costs more than the deposit can cover: what happens to the rest? | **Owner's answer:** the rest is owed automatically, added as a fine named "Damage: …" and paid like any fine. |
| 7 | Who can deduct for damage? | **Owner's answer:** the Manager only, as with settling. The owner is told when a deduction is over ₦20,000. |

**Code changes:**
- **Rule change:** in src/services/deposit-settlements.ts, the "only after leaving" rule is replaced.
  - From the last day of a month, everything held for a working operator can be refunded.
  - Before that, nothing can be refunded unless the operator has left.
  - Leftover held money from an earlier month that was not refunded is always due.
  - `depositsToSettle` includes working operators.
- **New function `refundAllDue`:** one transaction for the whole run. It refuses if the chosen cash is too small for the total, and the owner gets one notice with the total.
- **Saving reminder:** the nightly job reminds a working operator with no deposit by the 5th, once a month.
- **Screens:**
  - **Home:** month wording and overdue.
  - **Operator deposits:** **Refund all**, and "Not saving this month".
  - **Operator's page:** "Saved this month", "Refund due from 30 Nov", and Record deposit.
  - **Portal:** the monthly line.
- **Damage:**
  - The settle form and `settleDeposit` take `damageKobo`, `damageWhat` and `damageOnPurpose` in place of "give back less with a reason".
  - Given back = held − cleared − damage covered. Damage beyond what is left becomes a fine (a penalty charge named "Damage: …") in the same transaction. Undo removes it.
  - The existing kept amount and kept reason columns hold the damage amount and what was damaged.
- **Database:** one small migration adds `damage_on_purpose` (yes/no) to `deposit_settlements`. Otherwise no change: the deposit month comes from the date each deposit was received.

**Tests:**
- An operator saving ₦1,000 a day in November can be refunded from 30 Nov while working, but not on 29 Nov. A deposit after the refund on 30 Nov is held for December.
- After leaving, deposits from the current month can also be settled.
- **Refund all** refunds every listed operator, clears the debts, gives back the rest from one source, and refuses when that cash is too small.
- **Undo** still works on the same day only, deposit by deposit.
- **Damage:**
  - A ₦50,000 deposit with ₦12,000 owed and ₦8,000 damage gives back ₦30,000.
  - Damage of ₦50,000 on a ₦30,000 saving with nothing owed gives back nothing and adds a ₦20,000 "Damage" fine; undo removes it.
  - The deduction needs "What was damaged".
  - The deduction can't be more than what is left after debts.
  - The operator's notice names the damage.
  - Reports show it under "Deposits kept for damage".
  - Anyone unticked in **Refund all** is left held, to be settled on their own.
- Every form works at 360 px.

**Work:** half a day.

---

The rest of this file is the first version: settle when the operator leaves. Section 0 changes when a deposit can be settled.

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
