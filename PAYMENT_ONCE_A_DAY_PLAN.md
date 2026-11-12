# Jayngol Plan: Each Tricycle's Balance Is Taken Once a Day

Status: Phases 1 to 4 built (12 Nov 2026), not yet released. Owner's decisions in section 9.

**Phase 1 as built:** migration 0026 adds `purpose` (day_balance, old_balance, fine, loan, general) and `for_date` to payments, with a check that a day payment always has its day. Take payment sends "day" (the payment date), the Unpaid page "old", Loans "loan". A day payment pays its own day first (`allocateBalances` in the ledger); before the nightly job raises that day, it waits for it instead of paying an older day. Older payments are "general" and keep the oldest-first rule, as does any call that gives no purpose. The form's preview follows the same rule for today (a backdated preview still shows oldest first until phase 2 reworks the form). Covered in tests/money.test.ts and tests/collections.test.ts.

**Phase 2 as built:** `dayStatus` (src/services/day-balance.ts) works out one operator's day: what is due (the raised balance, or the tricycle's rate under the job's own conditions before the job runs), what is paid and by which receipts, and what is left. Saving a day payment refuses a paid day (naming the last receipt), more than what is left, fines or loan money mixed in, and a day with no tricycle; the operator row lock makes two staff at the same moment safe. Take payment now opens on the day's status with the amount filled in, and shows no form once the day is paid. The Manager enters an earlier unpaid day late from chips under "Other payments", which use the same rule. "Older days and fines" and "Loan" still open the previous form until phase 3. Covered in tests/money.test.ts.

**Phase 3 as built:** every payment now has one purpose. "Older days" (Unpaid page, `for=balance`) pays only days before today, oldest first, up to what is owed for them. "Fines" (`for=fines`, from the new **Fines owed** list at the top of Offences, per operator) pays only fines, up to what is owed. "Loan" pays only the loan. Mixing parts into a single-purpose payment is refused. The tricycle question is asked only for the daily balance, so paying fines or old days at the office does not raise R8. The receipt notice says what the money was for. The old mixed form is gone; payments with no purpose (older code and tests) keep the general rule. Covered in tests/money.test.ts.

**Phase 4 as built:** **Payments to review** (Money, under Problems to follow up; Manager only, as it needs Reverse payment) lists every operator-day with more than one live payment towards balances, with the day's balance, the total taken and each receipt, and marks days with the same amount twice. A second list shows live payments with money not used yet, largest first, with the total. The page changes nothing: each mistake is put right with Reverse payment on its receipt. Fines and loan payments are left out of the repeats. Covered in tests/money.test.ts.

## 1. The problem

Take payment accepts any number of payments for the same operator on the same day. A tricycle owes its own daily balance once a day, so a second ₦12,000 for the same day is a mistake: the button pressed again on a new form, two staff taking the same money, or a transfer entered twice.

The repeat is not refused and not flagged. It becomes **credit**, and the nightly job quietly uses it on other days. The day looks paid in advance, the cash count is higher than it should be, and nobody is told.

There is a second, hidden problem. A payment taken today is applied at night to the operator's **oldest** unpaid day, not to today. An operator who owes for 5 Nov and pays today ends up with 5 Nov paid and today unpaid, which is not what the cashier meant.

In the local sample data, Musa Abdullahi has three cash payments on 9 Nov (₦12,000, ₦15,000, ₦12,000) against one ₦12,000 balance, and ₦27,000 sits as unused credit.

## 2. The owner's rules

1. Operators pay their daily balance every day. Each tricycle has its own amount.
2. **Take payment takes one tricycle's balance for one day, once.**
3. **Old balances** are paid from the **Unpaid** page, or through Take payment with a **backdate** to the day being paid.
4. **Fines** are paid separately, from the fines (offences) page, per operator.
5. **No paying ahead.** Nothing can be paid for a day that has not come.
6. **Amounts above what is owed are refused.**

## 3. Four ways to pay, each with one purpose

| Where | What it pays | Most it accepts |
| --- | --- | --- |
| **Take payment** (Money, Dashboard, operator page) | That tricycle's balance for **today** | Today's balance, less anything already paid for today |
| **Take payment, backdated** (Manager only, as now) | That tricycle's balance for **the chosen day** | That day's balance, less anything already paid for it |
| **Pay old balance** (Unpaid page) | Unpaid earlier days, oldest first, never today | What is owed for days before today |
| **Pay fines** (Offences page, new button) | Confirmed fines for that operator | What is owed in fines |
| **Pay loan** (Loans page, unchanged) | The loan | What is owed on the loan |

The penalty field goes from Take payment, because fines have their own page now. The loan keeps its own button, as today.

Every payment records **what it is for**, and for daily balances **which day**. So a payment for today pays today, even if older days are unpaid.

## 4. What Take payment checks

Once an operator is chosen, the form shows where their tricycle stands for the day:

| State | The form shows | Saving |
| --- | --- | --- |
| Not paid | "GRE,4001 · today's balance ₦12,000 · not paid yet". The amount is filled in as ₦12,000. | Accepted up to ₦12,000 |
| Part paid | "₦6,000 of ₦12,000 paid at 9:14 by Amina Yusuf (R-000123)". The amount is filled in as ₦6,000. | Accepted up to ₦6,000 |
| Paid | "Today's balance is paid: ₦12,000 at 9:14 by Amina Yusuf (R-000123)". No amount field. A link to the Unpaid page if older days are owed. | Refused |

The check is repeated inside the save, with the operator locked. Two staff saving at the same moment cannot both get through, and the message names the receipt that got there first:

> "Today's balance for GRE,4001 is already paid: ₦12,000 at 9:14 by Amina Yusuf (receipt R-000123)."

More than what is left is refused:

> "Only ₦6,000 is left to pay for GRE,4001 today."

## 5. Before and after the nightly job

Today's balance is charged by the nightly job, so during the day there is no charge yet. Take payment uses the tricycle's amount for today from its balance history, which is the same amount the job will charge. The payment is held for today and the job puts it on today's charge. It never goes to an older day and never to tomorrow.

If the nightly job has not run for an earlier day, that day can still be paid by backdating, and the job applies it to that day when it runs.

## 6. Pay old balance (Unpaid page)

- The Unpaid page's button opens a short form: operator, amount, method.
- It lists the unpaid days, oldest first, for example "5 Nov ₦12,000 · 7 Nov ₦12,000".
- The amount can be anything up to the total, and pays the oldest days first.
- Today is never included. Today is paid through Take payment.

## 7. Pay fines (Offences page)

- Each operator with confirmed, unpaid fines gets a **Pay fines** button.
- The form lists the fines and takes up to the total owed.
- The receipt and the operator's notice say "Fines".

## 8. Existing credit and past repeats

1. **Read-only check on production first:** every operator-day with more than one payment, and every payment that still has unused credit. Nothing is changed.
2. For each mistake, the Manager uses the existing **Reverse payment**, with a reason. Cash already in a closed count is corrected in the next cash close, as now.
3. Credit that was real money is left as it is and used by the nightly job as today. From release on, no new credit can be created, because nothing can be paid above what is owed.

## 9. Decisions

| # | Question | Decided |
| --- | --- | --- |
| 1 | May anyone pay for future days? | **No.** Never. |
| 2 | Amount above what is owed | **Refuse.** |
| 3 | Same day paid twice | **One balance per tricycle per day.** A second payment for a paid day is refused. A part payment can be completed. |
| 4 | Old balances | Paid from the Unpaid page, or by backdating Take payment |
| 5 | Fines | Paid separately from the fines page, per operator |

Still to confirm when building: a part payment (₦6,000 now, ₦6,000 later) stays allowed. This plan assumes yes, since the second payment only completes the day.

## 10. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Purpose and day on payments | Migration adding what each payment is for and, for balances, which day; the nightly job puts day payments on their own day | Half a day | A payment for today pays today even when 5 Nov is unpaid, in tests |
| 2. Take payment, once a day | Day status on the form, amount filled in, refusal of a paid day and of overpayment, penalty field removed; backdate uses the same rule | 1 day | A second ₦12,000 for a paid day is refused, naming the first receipt |
| 3. Old balance and fines | Unpaid page form (older days only, oldest first); Pay fines button and form on the Offences page | 1 day | Both refuse more than is owed and never touch today |
| 4. Clean-up report | Read-only production list of repeats and unused credit for the Manager | 2 hours | The Manager has the list |

## 11. Testing

- Today paid in full: a second payment is refused, and the message names the first receipt.
- Part payment: the rest is accepted, then anything more is refused.
- ₦15,000 on a ₦12,000 balance is refused.
- Paying today when 5 Nov is unpaid: today is paid, 5 Nov stays unpaid.
- Before the nightly job, today's amount comes from the tricycle's balance history; the job then puts the payment on today's charge, once.
- A tricycle whose balance changes from today uses the new amount.
- Backdating to a paid day is refused; to an unpaid day, it pays that day only.
- The Unpaid page pays oldest days first, never today, never more than owed.
- Pay fines takes only confirmed fines, never more than owed.
- Two staff saving at the same moment: one is accepted, the other refused.
- An operator with no tricycle cannot use Take payment, but can still pay old balances, fines and the loan.
- All forms work at 375 px.
