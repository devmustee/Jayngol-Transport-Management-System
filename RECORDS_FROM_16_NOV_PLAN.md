# Records From 16 Nov 2026 Plan

Status: built 18 Nov 2026 with the decisions in section 5 (migration `0031_back_entry_windows`). Not yet deployed.

## 1. Goal

Official records start on **Monday 16 Nov 2026**. Every operator's daily balance for 16 Nov onwards must be in the system. Payments already taken on 16 and 17 Nov must be entered against the day they were paid, without anyone being fined for staff entering them late.

## 2. Why it does not work today

| Finding | Effect |
| --- | --- |
| Production was reset on 17 Nov. The nightly job then had no history, so its first run (00:05 on 18 Nov, Lagos time) handled 18 Nov only. It never goes back to earlier days. | No balances exist for 16 or 17 Nov, and none ever will on their own. |
| A balance starts the day **after** a tricycle is issued. | To owe a balance on 16 Nov, a tricycle must be issued on 15 Nov. |
| Issuing a tricycle with a past date raises nothing for the days already gone (`issueTricycle`, `changeIssueDate`). | A tricycle issued today dated 15 Nov owes nothing for 16, 17 or even 18 Nov, because the job already ran for 18 Nov before the tricycle was issued. |
| A payment can only be backdated to a day that has an unpaid balance. The Manager does this through the "Enter an earlier day's payment late" links on Take payment. | With no balances for 16 and 17 Nov, there is nothing to backdate. That is why the screen shows "Older days: Nothing owed". |
| The night after a day is due, any part of it not paid is fined (R1), and the fine is a confirmed offence. | If back entries are not finished in time, operators are fined for staff entering late. A confirmed offence also breaks their award run and shuts the Clean Vehicle and Law-Abiding awards until it is waived. |

The nightly job runs at **00:05 Lagos time** (`5 23 * * *` in UTC in `vercel.json`), not 23:05 as `PRODUCTION_RESET_PLAN.md` says.

## 3. What to build

### 3.1 Issuing with a past date raises the days already gone

When a tricycle is issued with a date before today, the system raises its daily balance for every day the nightly job has already done, from the day after the issue date up to the last day the job ran. It uses the same rules as the nightly job: the tricycle's own daily balance on each day, no balance on days the Manager marked as no-balance days, and none while off-road.

- The same applies when the Manager moves an issue date **earlier** with `changeIssueDate`. A later date already takes balances back.
- The issue screen shows what will be raised before saving, for example "This raises 3 daily balances: 16, 17 and 18 Nov, ₦45,000".
- The Manager and the Assistant Manager can both issue with a date before today, as now (decision 2).
- Audited, with the days and total raised.

### 3.2 Late checks wait for back entries

Fine checks for days before go-live entry is finished wait until the Manager says back entries are done.

- A setting, **Back entries open until**, holds a date. While it is set, the nightly job skips the late check for any balance dated on or before it. The balances themselves are still raised.
- Money page shows "Back entries for 16 to 18 Nov are open" with a button **Back entries finished**. Pressing it clears the setting, and the next nightly run checks those days. Payments entered with their real date count as on time, exactly as now.
- As a safety stop, the hold ends by itself on **25 Nov 2026** if nobody presses the button.
- Audited.

### 3.3 Faster back entry

- The backdate reason starts filled in as "Records start 16 Nov 2026" for days from 16 Nov until back entries are finished. The Manager can change it.
- No other change to Take payment. The "Enter an earlier day's payment late" links already list the last 7 unpaid days.

### 3.4 Tests

- Issuing on 15 Nov after the job ran for 18 Nov raises exactly 16, 17 and 18 Nov, at the right amount, and skips no-balance days and off-road days.
- Issuing again or retrying raises nothing twice.
- Moving an issue date earlier raises the missing days.
- An Assistant Manager can issue with a past date, and the balances are raised the same way.
- While back entries are open, no R1 fine is raised for those days. After **Back entries finished**, unpaid days are fined and backdated payments count as on time.
- The hold ends by itself after its stop date.

Estimate: about one day, including tests.

## 4. Steps on go-live day, after this is deployed

1. **The Manager opens back entries** on the Money page ("Enter past days' payments late"): first day 16 Nov, last day 18 Nov, fines wait until 25 Nov at the latest.
2. **The Manager or Assistant Manager issues each tricycle** to its operator, dated **15 Nov 2026**. Each one then owes 16, 17 and 18 Nov.
3. **Enter the payments**, one operator at a time from Take payment:
   - 16 and 17 Nov through "Enter an earlier day's payment late". The receipt shows the real day and the reason.
   - 18 Nov as today's balance.
4. **Cash already moved:** a backdated cash payment counts as cash now held by the person entering it. If cash from 16 or 17 Nov was already given to the Owner or banked, record that move today in Move money, so the cash close is right.
5. **Bank:** set the bank opening balance as of **15 Nov 2026**, using the bank's own figure for the end of that day. POS and transfer payments from 16 and 17 Nov are dated on their real day.
6. **Manager presses Back entries finished.** The next nightly run fines only days that were truly not paid on time.
7. **Close cash for 18 Nov** as normal. There is no cash close for 16 or 17 Nov, because their cash enters the system on 18 Nov.

Expenses, deposits, loans and offences from 16 and 17 Nov are dated the day they are entered unless their form has a date field. Add a note saying the real day.

## 5. Decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | Does every operator owe a balance for 16 Nov itself? | Yes. Issue dated 15 Nov, so the first balance is 16 Nov. |
| 2 | Who may issue a tricycle with a past date, now that it raises balances? | The Manager and the Assistant Manager. Backdating a payment stays with the Manager. |
| 3 | Should unpaid days from 16 to 18 Nov be fined at all? | Yes, once back entries are finished. Days truly not paid were late. |
| 4 | Is 25 Nov the right safety stop for the hold? | Yes, 25 Nov. |

## 6. Not known from here

The production database was not checked. If any tricycle has already been issued there, its issue date can be moved to 15 Nov after this is built, and the missing days will be raised (section 3.1).
