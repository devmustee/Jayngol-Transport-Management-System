# Jayngol Plan: Home Figures for Today, This Week and This Month

Status: Built (19 Nov 2026) with the suggested answers, not yet released.

**As built:** Today's footer reads "Older debts, before today" (every operator who owes, including those who have left) and links to the debt list up to yesterday, with "Owed in total" beside it. The week's and month's Remaining say how much is from today and how much from earlier days. A period that began before records did counts from the first day charged ("Received this month · 16 Nov to 19 Nov", "Records start 16 Nov"), and no comparison is shown until a whole earlier period is on record. `financeOverview` in src/services/finance.ts, `countFrom` and `fleetPeriod` in src/services/balance-periods.ts; covered in tests/collections.test.ts and tests/balance-periods.test.ts. No database change.

## 1. What the screens show (production, 19 Nov)

| | Today | This week (16 to 19 Nov) | This month (1 to 19 Nov) |
| --- | --- | --- | --- |
| Due | ₦372,800 | ₦1,410,800 | ₦1,410,800 |
| Received | ₦57,800 | ₦747,900 | ₦747,900 |
| Remaining | ₦315,000 | ₦662,900 | ₦662,900 |
| Footer | All money in ₦245,700. **Older debts ₦662,900 from 25 operators** | All money in ₦747,900 | All money in ₦747,900 |

## 2. What is actually wrong

**The week's figures are right. The "Older debts" line under Today is wrong**, and that makes the week look wrong.

- **Today's remaining plus older debts should equal what is owed in total.** Today: ₦315,000 + ₦662,900 = ₦977,900. The week (every day since records started) says only ₦662,900 is owed, so the two disagree by exactly today's ₦315,000.
- **The reason:** "Older debts" adds up every unpaid day, **today included**. So today's ₦315,000 is counted twice: once as today's remaining and again inside older debts.
- **The correct figures:**
  - Older debts (16 to 18 Nov): ₦662,900 − ₦315,000 = **₦347,900**.
  - Owed in total: **₦662,900** (₦315,000 from today and ₦347,900 from earlier days), which is what the week shows.
- **The week adds up:**
  - Due ₦1,410,800, paid ₦747,900, remaining ₦662,900.
  - Today's ₦245,700 in: ₦57,800 went to today's balances and ₦187,900 to 16 to 18 Nov.

**The month shows the same as the week because records start on 16 Nov.** No balances exist for 1 to 15 Nov, so those days add nothing. The figures are right, but the label "1 Nov to 19 Nov" makes it look like a copy of the week.

The code: `financeOverview` in src/services/finance.ts takes "Older debts" from `listArrears` with no date range, so today's unpaid balances are included.

## 3. The fix

1. **Older debts means before today.** The Today footer counts only unpaid days before today: "Older debts: ₦347,900 from N operators". The **See who owes** link for older debts opens the list up to yesterday.
2. **Remaining says where it comes from.** Under the week's and month's Remaining: "₦315,000 from today, ₦347,900 from earlier days". Today and older debts then visibly add up to the week.
3. **The month starts when records start.**
   - Until a full month has passed since records began, the month reads "Received this month · 16 Nov to 19 Nov", with "Records start 16 Nov".
   - Records start on the first day a daily balance was charged, so no setting is needed.
   - The same applies to the week if records ever start mid-week.
4. **No comparison with a period before records began.** "Compared with last week" or "last month" is hidden when that period has no balances, rather than comparing against nothing.

No database change.

## 4. Questions for the owner

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | Should older debts include operators who have left or been sacked? Today it shows only active operators; the week's Remaining includes everyone. | Include everyone, so the figures add up. The debt list already marks who has left. |
| 2 | Should the dashboard also show one plain figure, "Owed in total"? | Yes. Under Today: "Owed in total: ₦662,900". |

## 5. Work and tests

Half a day.

- Older debts leaves out today's unpaid balances: with ₦315,000 unpaid today and ₦347,900 unpaid before, it shows ₦347,900.
- Today's remaining plus older debts equals the week's remaining when records start this week, and the month's when they start this month.
- The month reads from the first day charged, and its figures match the week while records are younger than a week.
- No comparison is shown against a period with no balances.
- A payment today for an earlier day lowers older debts, not today's remaining.
- Home works at 375 px.
