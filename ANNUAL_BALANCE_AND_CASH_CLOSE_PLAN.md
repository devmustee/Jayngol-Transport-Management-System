# Jayngol Annual Balance and Cash Close Plan

Status: Not started. There are two parts:

- **Part A:** a new Annual balance page.
- **Part B:** a change to how often each person closes their cash.

---

## Part A: Annual balance

### A1. Goal

One page shows the whole year, January to December, broken down by month and by week. Each month and week has its own figures, each month gets a subtotal, and the year gets a grand total. Every figure adds up to the kobo, so the Owner can use it for the year's accounts.

### A2. What exists today

- The dashboard and Money page show **this week** and **this month** only.
- The collections report can group by day, week or month for any dates, but it shows only balances and payment methods, with no subtotals per month.
- Expenses, loans and deposits each have their own page and are never added up together.

### A3. The page

**Money → Annual balance** (`/money/year?year=2026`), for Owner, Manager and Assistant Manager (`finance.view`).

**Top:** a year switcher (‹ 2025 · **2026** · 2027 ›), then the year's headline figures:

| Figure | Meaning |
| --- | --- |
| Balances due | All daily balances charged in the year, without voided charges |
| Paid | How much of those balances has been paid, whenever the money came in |
| Still owed | Due minus Paid |
| Money received | All payments taken in the year, without reversed ones |
| Money out | Expenses spent plus loans given |
| Net | Money received minus money out |

**The year table:** one row per month, January to December. Each row shows Due, Paid, Owed, Received, Expenses, Loans given, Loans repaid and Net.

- Tapping a month opens its **weeks** underneath, each with the same figures, then the **month subtotal** line.
- The last row is the **year total**.
- On a phone, each month is a card showing Due, Paid, Owed and Received, with a "Show weeks" toggle. The full set of columns appears from tablet width up.

**Below the table:**

- **Money received by method:** Cash, POS and Transfer, per month and for the year.
- **What the money paid for:** balances, fines, loans and credit, per month and for the year.
- **Deposits:** taken and returned, kept separate because deposits are not income.

**Downloads:**

- **CSV:** every week, the month subtotals and the year total, ready for a spreadsheet.
- **Print / Save as PDF:** a clean one-year statement.

### A4. Rules that keep the totals honest

- **Weeks that cross a month end are split.** For example, Mon 28 Sep to Sun 4 Oct appears as 28 to 30 Sep in September and 1 to 4 Oct in October. So the weeks always add up exactly to the month, and the months to the year (decision A1).
- The same rules as the existing screens:
  - **Paid** follows the day a balance was for.
  - **Received** follows the day money came in.
  - Reversed payments and voided charges never count.
- The current year runs to **today**, and future months show as empty.
- The figures come from the existing balance and money functions, so the Annual balance always agrees with the dashboard, the Money page and the reports.

### A5. Data and speed

- **No new tables.** One grouped query per figure for the whole year, using the existing indexes.
- Target: the page loads in under 0.5 seconds for 200 operators and a full year of records. This will be measured on test data before release.

### A6. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| A1. Engine | Year, month and week figures with split weeks, subtotals and totals, plus tests | 1 day | Weeks add up to months and months to the year, to the kobo, in tests |
| A2. Page | Year switcher, headline, month rows that open into weeks, phone cards | 1 day | Readable at 375 px. Owner, Manager and Assistant Manager see it, Supervisor cannot |
| A3. Extras | Method and purpose tables, deposits, CSV and printable statement | Half a day | The CSV totals equal the page totals |

---

## Part B: Cash close, weekly for the Manager and daily for the Assistant Manager

### B1. What happens today

- Everyone who holds cash (Manager and Assistant Manager) is expected to count and close their cash **every day**.
- A red alert, "X has not closed cash since …", appears the morning after any day that is not closed.
- A count already covers every day since that person's last count. Closing on Sunday therefore covers Monday to Sunday with no gaps, so the system already supports a weekly count.
- A different person must check each count.

### B2. The new rule

| Person | Closes | When the alert appears |
| --- | --- | --- |
| **Assistant Manager** | **Every day**, as now | The morning after a day that was not closed |
| **Manager** | **Once a week**, covering Monday to Sunday | From Tuesday morning if last week was not closed (Monday is a day of grace) |

- **Manager:**
  - The Manager may still close early, for example before travelling. An early count simply covers the days up to that date.
  - The Manager's weekly count is still checked by a second person. The Assistant Manager checks it, as today.
- **Assistant Manager:** nothing changes for them, except that the Cash page says "Close today's cash".

### B3. Screen changes

- **Cash page for the Manager:** a **This week's cash** card:
  - The week's dates, the opening amount (last week's counted cash), and money in and out for each day of the week.
  - The cash expected now, and the count form labelled "Close this week".
- **Cash page for the Assistant Manager:** the daily close as it is today.
- **Dashboard and Money alerts:**
  - For the Manager: "Jayngol Manager has not closed last week's cash (3 to 9 Nov)".
  - For the Assistant Manager: "Amina Yusuf has not closed cash since 9 Nov", as today.
- **Cash book:** every close shows the days it covered, for example "Week close, 3 to 9 Nov" or "Day close, 9 Nov".

### B4. Data and permissions

- **No database change for the rule itself.** How often each role closes is fixed in the code:
  - Manager: weekly.
  - Assistant Manager: daily.
- The days a close covered come from the person's previous close, so they need no new column.
- **Safety:** a weekly close means the Manager may hold a week of cash.
  - Handovers to the bank and to other staff are still recorded the day they happen, through Move money, so the expected cash stays right every day.
  - The Owner can check the Manager's expected cash at any time on the Cash page.

### B5. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| B1. Rule and alerts | Close rhythm by role, the weekly alert from Tuesday, the daily alert as today | Half a day | Tests: the Manager gets no alert on Monday, does on Tuesday, and the Assistant Manager does after one missed day |
| B2. Screens | "This week's cash" card, a daily breakdown, "Close this week", coverage dates in the cash book | 1 day | At 375 px, the Manager closes a week in one form and the Assistant Manager checks it |

---

## Testing for both parts

- A year of test data: the weeks add up to the months and the months to the year, for Due, Paid, Received and Money out.
- A week that crosses a month end is split, and both parts appear in the right months.
- A reversed payment or voided charge changes the right week, month and year.
- The Manager closes on Sunday: the expected amount includes all seven days, and there is no alert on Monday. If the week is not closed, the alert appears on Tuesday.
- The Assistant Manager misses one day and gets the alert the next morning.
- The Manager cannot check their own weekly count.
- A Supervisor sees neither the Annual balance nor the Cash page.

## Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| A1 | When a week crosses a month end, should it be split between the two months, or counted wholly in the month it starts in? | Split it, so the weeks add up exactly to each month |
| A2 | Should operators see their own year (due, paid and owed by month) on their portal? | Yes, later, using the same figures |
| A3 | Should the year run January to December, or follow a different financial year? | January to December, unless your accountant uses another year |
| B1 | Which day does the Manager's week end on? | Sunday, matching the balance week, with the alert from Tuesday |
| B2 | If there are two Managers or Assistant Managers in future, should the rhythm follow the role, or be set per person? | Follow the role for now |
| B3 | Should the Owner also be able to check (recount) the Manager's weekly close? | Yes. The Owner is a second person, and this matters most for the larger weekly amount |
