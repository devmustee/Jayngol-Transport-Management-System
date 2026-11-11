# Jayngol Collections Plan: Taking Unpaid Balances and Loan Repayments

Status: Built (12 Nov 2026) with the recommended decisions: the full amount owed is prefilled, extra money stays as credit, operators no longer working are listed separately, and there is no loan schedule. Covered by tests/collections.test.ts.

## 1. Goal

When staff see money owed, they should be able to collect it in one or two taps, from the place where they see it:

- **Unpaid balances:** take payment directly from the Unpaid balances list and from an operator's statement.
- **Unpaid loans:** take a loan repayment directly from the Loans list and the loan's own page, with the amount going to the loan.

Before saving, staff should see exactly what the money will clear, so nothing is applied by surprise.

## 2. What exists today

- **Take payment** (`/payments/new?operator=…`) already handles everything. One payment can go to unpaid balances (oldest first), to fines, and to the loan. Only the amount typed into "Part of this for the loan" goes to the loan.
- **Unpaid balances** (`/arrears`) lists who owes and how much, but each row only opens the statement. There is no button to collect.
- **The statement** shows what is owed, with no way to take payment from it.
- **The loan page** has a "Take a repayment" button, but it opens the general form. Staff must then type the amount twice: once as the payment and again as the loan part.
- **The Loans list** shows what is left on each loan, with no button to collect.
- **The pulse count and the list disagree:** the pulse counts active operators only (4), while Unpaid balances also lists sacked and departed operators (5 rows). This looks like an error to staff.
- **Who can take money:** sacked or departed operators can already pay. Only staff with `payment.record` (Manager and Assistant Manager) can take money.

## 3. What will change

### 3.1 Unpaid balances list

- Each row gets a **Take payment** button next to the amount. The row itself still opens the statement.
- The button opens Take payment with the full unpaid amount filled in. Staff can change it before saving.
- Two groups with separate totals:
  - **Working operators:** these match the pulse count.
  - **No longer working:** sacked or left, still owing.
- When the list is filtered to a week or month, the filled-in amount is still the operator's whole unpaid balance, because a payment always clears the oldest days first.

### 3.2 Operator statement and profile

- A **Take payment** button in the statement header. The operator profile already has one.
- If the operator has a loan, a second button, **Take loan repayment**.

### 3.3 Loans

- Each active loan on the Loans list gets a **Take repayment** button.
- The loan page button opens the form in **loan mode**.
- A **Loans to collect** summary at the top: total owed, number of operators, and for each loan the days since its last repayment. The oldest goes first, so slow payers stand out.
- The Money page tile's description changes from "Disbursed loans and recovery schedules" to "Money lent to operators and what is left to collect", since loans have no schedule.

### 3.4 Take payment form

- **Quick amounts** (one tap fills the amount):
  - **All unpaid balances** (₦X)
  - **Today's balance** (₦Y)
  - **Clear the loan** (₦Z), only when a loan is owed
  - **Fines** (₦W), only when fines are owed
- **Loan mode** (`?for=loan`) fills the amount and the loan part with the same figure, so the whole payment goes to the loan. Staff can change either one.
- **Balance mode** (`?for=balance`) fills the amount with the unpaid balance.
- **What this payment will clear:** a live summary under the amount before saving. For example:
  - "Clears 9 Nov balance ₦15,000"
  - "Loan ₦5,000, ₦20,000 left after this"
  - "₦2,000 kept as credit for the next balance"
- The save button names the amount, for example **Take ₦20,000**, so a wrong amount is easier to catch.
- No change to how money is applied. The server still decides, and the summary uses the same rule: oldest balances first, and only the stated loan part to the loan.

### 3.5 Financial Pulse and Money page

- The pulse line says **"4 working operators owe ₦X"** and links to the Unpaid balances list, so the count and the list match.
- When loans are owed, a second line, **"Loans to collect: ₦Y from N operators"**, links to the Loans page.

## 4. Data and permissions

- **No database changes.** All figures come from what exists: open charges, effective allocations and loans.
- The Take payment buttons show only to staff with `payment.record`. Others still see the amounts if they have `finance.view`.
- The filled-in amounts come from the server when the page loads. The server checks them again when saving, as it does today. A loan part larger than the loan, or fines larger than what is owed, are still refused.

## 5. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Buttons where money is owed | Take payment on Unpaid balances rows and the statement. Take repayment on the Loans list and in loan mode. Working and no-longer-working groups. Pulse wording | Half a day | From each list, one tap opens the form with the right amount |
| 2. Smarter form | Quick amounts, loan and balance modes, live "what this clears" summary, amount on the button | 1 day | The summary matches the receipt to the kobo in tests |
| 3. Loans to collect | Summary, days since last repayment, oldest first, loans line on the pulse | Half a day | A loan with no repayment for 7 days shows at the top |

## 6. Testing

- A balance-mode payment from Unpaid balances clears the oldest days first, and Unpaid balances drops by exactly that amount.
- A loan-mode payment reduces only the loan, and the loan shows **Cleared** once fully repaid.
- A payment larger than everything owed keeps the rest as credit, and the summary says so.
- Fines and loan parts larger than what is owed are refused with a clear message.
- A sacked operator can still pay what they owe from the "No longer working" group.
- A Supervisor sees no Take payment buttons and no amounts. The Owner sees amounts but no Take payment buttons.
- Everything fits at 375 px and every button is at least 44 px tall.

## 7. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | From Unpaid balances, should the amount be filled in with the full unpaid balance, or left empty? | Filled in, because staff usually collect the whole debt. They can still change it |
| 2 | Should loans get a repayment plan, for example a fixed amount each week, so the app can say who is behind? | Not now. Show days since the last repayment first, then decide |
| 3 | When an operator pays more than their unpaid balances and has a loan, should the extra go to the loan automatically? | No. Keep the current rule that only the stated loan part goes to the loan, and show the extra as credit so staff can choose |
| 4 | Should sacked and departed operators be listed separately on Unpaid balances? | Yes, with their own total, so the pulse count matches the "Working operators" group |
