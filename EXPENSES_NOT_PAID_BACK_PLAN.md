# Jayngol Plan: Expenses Are Spent, Not Paid Back

Status: Phase 1 and section 11 (who approves) built (13 Nov 2026), not yet released. Phases 2 and 3 still to do.

**Phase 1 as built:** **Record an expense** on the Expenses page (and the Home button) records what it was for, category, amount, date spent (never a future day) and an optional receipt in one save. The money comes straight off the company balance at once, never out of the Manager's or Assistant Manager's cash in hand (owner's rule, 13 Nov 2026), so the form has no "where the money came from" choice and the expense waits for approval. Sent back, the Manager can correct it (only the difference moves) or remove it (the money goes back). Approved, it is final: correcting, removing, cancelling and change are all refused. Nobody can approve an expense they recorded. Older advances still work line by line. `recordExpense`, `correctExpense` and `removeExpense` in src/services/expenses.ts; covered in tests/expenses.test.ts.

## 1. How it works today

Expenses are run as **advances**:

1. The Manager **collects funds** for expenses (for example ₦30,000 "Office supplies and transport"). The money leaves cash or the bank.
2. Over the next days the Manager adds **what was spent** line by line, and records any **change returned**, which goes back into cash.
3. Until every naira is spent or returned, the record shows **"Still to account for"** and sits under **"To account for"**.
4. Once it adds up, the Manager sends it for countersign, and the Assistant Manager **countersigns** or sends it back.

So the screens talk about money that is still owed back ("Still to account for", "Record change returned", "To account for (1)"). That is not how Jayngol works.

## 2. The owner's rule

- **An expense is money spent. It is not paid back.**
- There is no change to return and nothing "to account for" later.
- **Once approved, an expense is final.** It cannot be refunded, cancelled or changed.

## 3. Recording an expense, in one step

**Record an expense** (Manager), from Home and from the Expenses page:

| Field | Example |
| --- | --- |
| What it was for | Engine oil for the store |
| Category | Store purchase, Workshop labour, Fuel and transport, Office, Salaries, Other |
| Amount (₦) | 48,000 |
| Date spent | Today, or an earlier day; never a future day |
| Receipt photo | Optional |

Saving takes the money off the company balance, once (never out of a person's cash in hand), and the expense waits for approval. There is no later "add what was spent" step and no "change returned".

## 4. Approval, then final

| State | Who acts | What can happen |
| --- | --- | --- |
| **Waiting for approval** | Assistant Manager | **Approve**, or **send back** with what needs correcting |
| **Sent back** | Manager | Correct the amount, category or date and send again, or **remove it** if it was entered by mistake. Removing puts the money back on the balance, as a correction of a wrong entry, not a refund. |
| **Approved** | Nobody | Final. No change, no removal, no refund. |

The same person cannot record and approve, as today.

## 5. Screens

**Expenses page**

- **Record an expense** at the top.
- **Waiting for approval** and **Sent back** lists.
- **Approved**, with this month's total spent.
- **Expense report** button, as now.
- Gone: "Still to account for", "To account for", "Collect funds for expenses".

**One expense**

- Shows what it was for, category, amount, date spent, where the money came from, receipt, recorded by, and approved by.
- The Assistant Manager gets **Approve** and **Send back**. The Manager gets **Correct** and **Remove** only while it is sent back.
- Gone: "Add what was spent", "Record change returned", "Still to account for".

**Home**

- The button becomes **Record an expense**.
- The only expense notice is "N expenses waiting for approval", for the Assistant Manager.

**Expense report**

- Columns become Spent and each category.
- **Funds collected** and **Change returned** are removed, since money is no longer collected first.

**What stays the same:** the cash book, the annual balance and the reports already count an expense on the day it was spent. They need no change.

## 6. Existing records

- **Countersigned** records are shown as **Approved**. They stay exactly as they are, including any old change returned in their history.
- **Open** records still have money "to account for". In the local sample, "Office supplies and transport" is ₦30,000, with ₦8,000 spent and ₦22,000 left. Each one needs a decision (question 4).
- **Waiting for countersign** records simply wait for approval.

## 7. Questions for the owner

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | Is this the meaning of "not paid back": money taken for expenses is spent, with no change returned and nothing to account for later? | Yes |
| 2 | Does the Assistant Manager still approve each expense? | Yes, as the second person |
| 3 | One item per expense, or several items under one expense? | One item each. Several purchases are recorded one by one, so each has its own category and receipt. |
| 4 | An open record with money still "to account for" | The Manager records what the rest was spent on, then sends it for approval. Anything left after that is counted as "Other". |

## 8. Data

- No new tables.
- Each new expense is one record with one spent line, saved together and waiting for approval.
- "Countersigned" is shown as "Approved".
- The old advance steps (add a line, change returned, submit) are no longer offered for new expenses.
- Nothing already recorded is rewritten.

## 9. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Record in one step, approve, final | New form and service, approval and send back, correct or remove only while sent back, approved is final | 1 day | An approved expense cannot be changed, removed or refunded, in tests |
| 2. Screens and wording | Expenses page, the expense page, Home button and notice, report columns | Half a day | No screen mentions accounting for or change returned |
| 3. Existing open records | The step chosen in question 4 | 2 hours | No record is left "to account for" |

## 10. Testing

- Recording takes the money off the company balance once, and nobody's cash in hand changes, and the expense waits for approval.
- A future date is refused.
- The same person cannot approve their own expense.
- Sent back: correcting changes the amount, and the money moves by the difference only.
- Sent back: removing puts the money back on the balance.
- Approved: correcting, removing and refunding are all refused.
- The report, cash book and annual balance totals match the expenses recorded.
- Old countersigned records show as Approved and are unchanged.
- Every form works at 375 px.

## 11. Who approves (owner's rule, 13 Nov 2026)

**As built:** the Manager and the Assistant Manager can both record an expense. The Manager's is saved as approved with no approver ("Approval: Not needed, recorded by the Manager"), and the Manager can correct or remove it only on the day it was saved. The Assistant Manager's waits for the Manager, who approves it or sends it back; only the Assistant Manager who recorded it can correct or remove it while it is sent back. The owner gets a notice for any single Manager expense over ₦50,000. Older Manager records that were waiting for the Assistant Manager's countersign are approved as they stand (drizzle/0027), and an older advance the Manager submits is final at once. Covered in tests/expenses.test.ts.

- **The Manager records an expense: no approval.** It is final the moment it is saved.
- **The Assistant Manager records an expense: the Manager approves it.** It waits until the Manager approves it or sends it back.

| Recorded by | After saving | Who approves | Mistakes |
| --- | --- | --- | --- |
| Manager | **Approved**, final at once | Nobody | See question 5 |
| Assistant Manager | **Waiting for the Manager's approval** | Manager | While sent back, the Assistant Manager corrects or removes it, as in section 4 |

**What changes**

- **Who can record.** The Manager and the Assistant Manager both get **Record an expense** (today only the Manager can).
- **Who can approve.** Only the Manager, and only expenses the Assistant Manager recorded. The Assistant Manager no longer approves anything.
- **The Manager's own expense.** It is saved as approved, with "Recorded by the Manager, no approval needed" in place of an approver.
- **Home.** The Manager sees "N expenses waiting for your approval". The Assistant Manager sees their own expenses that were sent back.
- **The owner** sees every expense and who recorded it, so the Manager's own spending stays in view without an approval step.
- **Older records** already countersigned by the Assistant Manager stay approved. Any old Manager record still waiting for the Assistant Manager's countersign is approved as it stands (see question 6).

**Data**

- No new tables. The record's status is set to approved on saving when the Manager records it, with no approver.
- The database rule that the approver differs from the recorder stays, so nobody approves their own entry.
- Permissions: `expense.record` becomes Manager and Assistant Manager; `expense.countersign` becomes Manager.

**Questions for the owner**

| # | Question | Suggested answer |
| --- | --- | --- |
| 5 | The Manager's expense is final at once. What if the Manager types a wrong amount? | The Manager can correct or remove their own expense **on the same day** only. From the next day it is final. |
| 6 | Old Manager records still waiting for the Assistant Manager's countersign | Approve them as they are, since the Manager no longer needs approval. |
| 7 | Should the owner be told about the Manager's large expenses? | Yes. A notice to the owner for any single Manager expense over ₦50,000. |

**Work:** half a day, after phase 2.

**Tests**

- A Manager expense is approved and final on saving, and the money leaves once.
- An Assistant Manager expense waits for the Manager, and the Assistant Manager cannot approve it.
- The Manager cannot approve an expense the Manager recorded, since none ever waits.
- Sent back, the Assistant Manager corrects or removes their own expense.
- The Manager corrects their own expense only on the same day, if question 5 is agreed.
