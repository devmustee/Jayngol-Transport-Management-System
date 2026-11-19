# Jayngol Plan: Giving a Loan and Taking It Back

Status: Built (20 Nov 2026) with the suggested answers, not yet released.

**As built:**
- **Give a loan:** a search box (name, tricycle, plate or phone) sits above the Operator list. Each choice reads "Name · GRE-4012 · WKR-101VC" or "Name · No tricycle", and the note under the list says how many are left out for owing a loan. Once an operator is chosen, a line before **Give loan** reads "₦25,000 to Haruna Isa, tricycle GRE-4006 (WKR-106VC)."
- **After giving:** the loan's own page opens. It shows the tricycle and plate, "Loan given" with where repayments are taken, and what is still owed with **Take loan repayment**.
- **Take payment:** for an operator with a loan, it shows "Loan unpaid · Collect".
- **Operator's page:** a Loan card shows what was given, what is left and **Take loan repayment**.
- **Home:** **Take loan repayment** shows while any loan is owed. It lists everyone who owes, with tricycle, plate and what is left, oldest loan first.
- **Code:** `operatorsForLoan`, `operatorsOwingLoans` and `activeLoanFor` in src/services/loans.ts, and src/components/forms/loan-operator-picker.tsx. It is covered in tests/collections.test.ts.
- No database change.

## 1. What happens today

**Giving a loan.** On Loans, under **Give a loan**:
- The Operator list shows names only, in alphabetical order.
- With 40 or more operators, and some names alike (Abubakar Yola, Muhammed yola, Nasiru Yola), it is easy to pick the wrong person.
- There is no tricycle number or plate to check against.

**Taking a loan back already works,** in four places:

| Where | What is there |
| --- | --- |
| Loans, **Loans to collect** | A **Take repayment** button beside each operator who owes |
| One loan's page | **Take loan repayment** |
| Take payment, after choosing the operator | **Loan** under "Other payments", with what is owed |
| Home, money summary | The loans line links to Loans |

Each opens the payment form for that operator's loan only. The money goes on the receipt and comes off what is owed. The loan reads **Cleared** once all of it is paid.

**Why it's hard to find:**
- Production shows "Owed to the company: ₦0", so no loan has been given yet.
- With no loans, **Loans to collect** is empty and has no buttons.
- After **Give loan**, the page only says "Loan recorded." and stays on the form, so the Manager never sees where the repayment button is.

## 2. The fix

### Choosing the operator
1. **Each choice shows the name, tricycle number and plate:** "Abubakar Yola · GRE-4012 · WKR-101VC". An operator with no tricycle reads "Abubakar Yola · No tricycle".
2. **A search box above the list.** Typing a name, tricycle number, plate or phone narrows the list, as on the Operators page.
3. **Before giving, the form repeats who it is for:** "₦50,000 to Abubakar Yola, tricycle GRE-4012 (WKR-101VC)". This sits above **Give loan**, so a wrong pick is seen in time.
4. **Operators who can't take a loan** (one is still owed) stay out of the list, as now. The note under the list names how many are left out and why.

### Taking the loan back
5. **After giving, the loan's own page opens.** It shows:
   - the operator, tricycle and plate;
   - what was given;
   - what is left;
   - a large **Take loan repayment** button.
6. **On Take payment, an operator with a loan gets a gold reminder.** It reads "Loan unpaid: ₦35,000 left · Collect", just like the weekly contribution reminder, so the loan is seen while today's balance is taken.
7. **Home gets "Take loan repayment".** It sits in the money summary next to **Take payment** and **Take contribution**. It shows only while at least one loan is owed. It opens the operator search in loan mode, listing only operators who owe a loan, with what each owes.
8. **The operator's page shows the loan.** It shows a **Loan** card with the amount left and **Take loan repayment**, beside the deposit card.

Repayments stay as now: any amount at a time, on a receipt, never more than what is left, and taken by whoever can take payments.

No database change.

## 3. Questions for the owner

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | Should an operator with no tricycle be able to take a loan? | Yes, as today. The list marks them "No tricycle". |
| 2 | Should loans be paid back in fixed amounts (for example ₦2,000 a day), with a reminder when one is missed? | Not now. Any amount, any day, as today. Can be added later. |
| 3 | Should the operator see their loan and what is left on their portal? | Yes, it already shows. No change. |

## 4. Work and tests

Half a day.

- The operator list shows name, tricycle number and plate. Search by plate finds the right operator.
- The confirm line names the operator, tricycle and plate, and giving opens the new loan's page.
- Take payment for an operator with a loan shows the reminder, and it opens the loan repayment form.
- "Take loan repayment" on Home lists only operators who owe a loan, and shows nothing when none do.
- A repayment lowers what is left, and the loan reads Cleared when it reaches ₦0.
- Every form works at 360 px.
