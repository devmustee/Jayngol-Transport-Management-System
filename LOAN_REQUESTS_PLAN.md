# Jayngol Plan: Loan Requests Approved by the Manager

Status: Built (20 Nov 2026) with the suggested answers, not yet released.

**As built:**
- **Assistant Manager:** Loans shows **Request a loan**, using the same operator search. It needs a reason and ends with "Ask the Manager for ₦… for …". Home shows **Request a loan**.
  - "My requests waiting" lists their requests, each with **Withdraw request**.
  - "My answered requests" shows Approved, Rejected (with the reason) or Withdrawn.
  - Giving and cancelling loans are refused.
- **Manager:** Loans shows **Loan requests**, oldest first. Each shows the tricycle and plate, the reason, who asked and when, and what the operator owes today in balances and fines.
  - **Approve** has an amount (empty means the amount asked; it can be lowered, not raised) and where the money comes from. It opens the new loan's page.
  - **Reject** needs a reason.
  - Home shows "N loan requests waiting · oldest …".
- **Notices:**
  - The Manager gets "Loan request".
  - Only the person who asked gets "Loan request answered". This uses the existing way of naming who a staff notice goes to, so no notice change was needed.
- **Loan page:** shows "Requested by" and "Approved by".
- **Operators left out:** the operator list for giving or requesting a loan leaves out anyone who owes a loan or already has a request waiting.
- **Code:**
  - src/services/loan-requests.ts and src/components/loan-requests.tsx;
  - `payOutLoan` in src/services/loans.ts, shared by giving a loan and approving a request;
  - migration 0033.

  Covered by tests/loan-requests.test.ts.

## 1. What happens today

- The Manager and the Assistant Manager both give loans the same way.
  - On Loans, under **Give a loan**, they choose the operator, the amount and where the money comes from.
  - **Give loan** pays it out straight away. The money leaves that cash or the bank, and the operator owes it.
- Nobody else has to agree. The loan's page shows "Approved by" with the name of whoever gave it, even when that was the Assistant Manager.
- The Assistant Manager can also cancel a loan entered by mistake, as long as nothing has been repaid.
- In the code, both roles have the one permission `loan.approve`, used by `grantLoan` and `cancelLoan` in src/services/loans.ts.

## 2. How it will work

**The Assistant Manager asks, the Manager decides.**

1. **Request a loan (Assistant Manager).**
   - On Loans, **Give a loan** becomes **Request a loan**. It has the same operator search, showing name, tricycle and plate, plus the amount and a reason.
   - Saving sends the request to the Manager. No money moves, and the operator owes nothing yet.
   - The line before the button reads "Ask the Manager for ₦25,000 for Haruna Isa, tricycle GRE-4006 (WKR-106VC)."
   - The Home button **Give a loan** reads **Request a loan** for the Assistant Manager.
2. **The Manager is told.**
   - A notice reads "Loan request: ₦25,000 for Haruna Isa, from Amina Yusuf". It opens the request.
   - Home shows "N loan requests waiting" while any are open.
3. **The Manager approves or rejects.** Loans gets a **Loan requests** list at the top, oldest first. Each request shows:
   - the operator, tricycle and plate;
   - the amount and reason;
   - who asked and when;
   - what the operator owes today (unpaid balances and fines), so the Manager sees the risk.

   To **Approve**, the Manager chooses where the money comes from (a person's cash or the bank) and may lower the amount (question 1). Approving pays the loan out exactly as **Give loan** does now.

   To **Reject**, the Manager writes a reason.
4. **The Assistant Manager is told the answer.**
   - "Approved: ₦25,000 for Haruna Isa", or "Rejected: …" with the reason.
   - The request shows the same answer on their Loans page.
5. **Withdraw.** The Assistant Manager can withdraw their own request while it is still waiting.

**Rules:**
- Only an active operator with no loan owed can have a request, as now.
- Only one waiting request per operator. A second request for the same operator is refused, and the first is named.
- If the operator leaves, is sacked or is given a loan by another route while a request waits, approving is refused with the reason.
- **The Manager still gives loans directly,** with no request. The loan says "Approved by" the Manager.
- **Only the Manager can cancel a loan** entered by mistake (question 4).
- **Record:** a loan from a request shows "Requested by" with the Assistant Manager's name, and "Approved by" with the Manager's. Both are in the audit log.

## 3. Screens

| Who | Loans page | Home |
| --- | --- | --- |
| Assistant Manager | **Request a loan** form. "My requests": waiting, approved, rejected, withdrawn. Loans to collect and repayments as now. | **Request a loan** button. |
| Manager | **Loan requests** list at the top, with Approve and Reject. **Give a loan** as now. | "N loan requests waiting". **Give a loan** as now. |
| Owner | Sees requests and loans, read only. | No change. |

Taking repayments does not change. Anyone who can take payments can still take loan repayments.

## 4. Data

- **New table `loan_requests`:**
  - operator, amount, reason;
  - who asked and when;
  - status: waiting, approved, rejected or withdrawn;
  - who decided and when, and the reject reason;
  - the loan it became.
- **Permissions:**
  - New `loan.request` for the Assistant Manager.
  - `loan.approve` becomes Manager only. It covers giving directly, approving and cancelling.
- **Notices:**
  - "Loan request" goes to whoever can approve loans.
  - "Loan request answered" goes to the person who asked. Notices today go to everyone with a permission, so this needs a way to send a notice to one named person.
- **Loans:** a new optional column, `request_id`, links a loan to the request it came from.
- **Migration:** 0033, with its journal date after 0032.
- **Existing loans:** they stay as they are, with no request.

## 5. Questions for the owner

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | Can the Manager change the amount when approving? | Lower only, not higher. The Assistant Manager is told the amount approved. |
| 2 | Who chooses where the money comes from? | The Manager, when approving. If it is the Assistant Manager's cash, they hand it over, and it comes off what they hold. |
| 3 | Does a waiting request expire? | No. It waits until the Manager decides or the Assistant Manager withdraws it. Home shows how many days it has waited. |
| 4 | Can the Assistant Manager still cancel a loan entered by mistake? | No. Only the Manager, since only the Manager can give one. |
| 5 | Should the owner be told about loans? | Not now. Can be added, like large expenses, for loans over an amount. |

## 6. Work and tests

One day.

- The Assistant Manager's request moves no money, the operator owes nothing, and the Manager is told.
- **Give loan** and cancelling a loan are refused for the Assistant Manager.
- On approval, the loan is paid from the chosen source, the operator owes it, and the request shows Approved. The Assistant Manager is told, and the loan shows who requested it and who approved it.
- Approving for less is allowed; approving for more is refused.
- A rejection needs a reason, moves no money, and tells the Assistant Manager why.
- A second waiting request for the same operator is refused. A request is refused for an operator who owes a loan.
- Approving is refused once the operator has left or already has a loan.
- The Assistant Manager can withdraw their own waiting request, but not someone else's or one already decided.
- The Manager can still give a loan directly.
- Every form works at 360 px.
