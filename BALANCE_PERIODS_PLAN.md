# Jayngol Weekly and Monthly Balance Plan

Status: All four phases are built (`src/lib/periods.ts`, `src/services/balance-periods.ts`, migration `0020_balance_period_indexes`, the dashboard switch, the Money page card, My collections and Collections by cashier on the Cash page, the balance card on the portal and operator profile, and Group by Day / Week / Month on the collections report and its CSV). Migration 0020 is applied in production. The four decisions in section 8 are agreed, and the "Full week" line from decision 2 is built.

## 1. Goal

Operators still pay a daily balance. Everyone should also be able to see how that adds up over the current week and month: how much was due, how much has been paid, and how much is still owed.

- **Owner, Manager and Assistant Manager** see fleet-wide totals.
- **Cashiers** (staff who record payments) also see what they collected themselves.
- **Operators** see only their own week and month.

## 2. What exists today

- The Home dashboard's Financial Pulse shows **today only**: balances due today, money received today and the percentage collected.
- The **Daily collections** report lists one row per day for a chosen date range. It never adds days up into weeks or months.
- The operator portal (`/me`) shows the tricycle, deposit, fines and meetings, but no running total of balances due and paid.
- A staff member's operator profile has no balance summary either.

So the figures exist one day at a time, but nothing adds them up.

## 3. Definitions

| Term | Meaning |
| --- | --- |
| Week | Monday to Sunday, using Lagos business dates (decision 1, agreed) |
| Month | 1st to the last day of the calendar month |
| This week / this month | From the first day of the period up to today |

Each period shows four figures:

| Figure | How it is worked out |
| --- | --- |
| **Due** | Daily balances charged for days in the period. Voided charges are left out. |
| **Paid** | How much of those balances has been paid, from payments that have not been reversed, whenever the payment was made |
| **Owed** | Due minus Paid |
| **Received** | All money taken in during the period, by Cash, POS and Transfer, split into balances, fines and loan repayments |

**Paid** and **Received** answer different questions and must both be shown. If an operator clears last week's debt this Monday, it counts as Received this week but as Paid last week. Received can therefore be higher than Due. Deposits are not balance money, so they stay out of all four figures and keep their own page.

Collection rate = Paid ÷ Due, shown as a percentage.

## 4. Screens

### 4.1 Home dashboard, Owner, Manager, Assistant Manager

The Financial Pulse gains a **Today / This week / This month** switch. Each view shows Due, Paid, Owed, the collection rate and the progress bar, and compares against the same point last week or last month, for example "₦412,000 paid, ₦38,000 more than this time last week".

### 4.2 Money page, Owner, Manager, Assistant Manager

A **Balances by period** card with two columns, this week and this month. It shows Due, Paid, Owed and Received, with Received split by method and by what it paid for. Selecting Owed opens the existing Unpaid balances list, filtered to that period.

### 4.3 Cashiers

A **My collections** card on the Cash page shows today, this week and this month: total received, split into Cash, POS and Transfer. It counts only payments the signed-in staff member recorded. The Manager also sees one row per cashier.

### 4.4 Operator portal (`/me`)

A **My balance** card sits directly after what they owe, with a This week / This month switch:

- Due, Paid and Owed
- Days paid in full, for example "6 of 7 days paid"
- Whatever is still unpaid, with the oldest unpaid date

It is calculated only for the operator in the login session.

### 4.5 Operator profile, staff

The same card as on the portal, so a Manager can show an operator their week during a conversation. Supervisors do not see it, because they do not see money.

### 4.6 Reports

The **Daily collections** report gains a **Group by: Day / Week / Month** option, with the same CSV and PDF download. Grouping happens in the database query, so the totals match the screens.

## 5. Data and permissions

- **No new tables.** All figures come from the existing charges, payments, payment allocations and reversals. A voided charge or a reversed payment corrects every figure automatically.
- **One service function** works out the four figures for any date range and scope (whole fleet, one cashier or one operator). Every screen and the report use it, so they cannot disagree.
- **Permissions:**
  - Fleet totals need `finance.view`.
  - My collections needs `payment.record` and is always limited to the signed-in staff member.
  - The portal card needs `portal.viewOwn`.
- **Speed:** check that the database has indexes on `charges (business_date, type)`, `payments (business_date)` and `payment_allocations (charge_id)`, then measure a full month for 200 operators. The target is under 0.3 seconds.

## 6. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Engine | Period function, week and month boundaries, any missing indexes, tests | 1 day | Totals match a hand-checked week and month to the kobo |
| 2. Staff screens | Dashboard switch, Money page card, comparison with the last period | 1 day | Owner, Manager and Assistant Manager see matching figures in each place |
| 3. Cashier and operator | My collections, portal card, profile card | 1 day | Each person sees only what they are allowed to see, and it is clear at 375 px on a phone |
| 4. Reports | Group by Day, Week or Month on Daily collections | Half a day | The report's totals equal the screen totals for the same period |

## 7. Testing

- **Boundaries:** a payment at 23:59 on Sunday and at 00:00 on Monday, Lagos time, and the last day of a 28, 30 and 31 day month.
- **Late payment:** a balance due this week but paid next week counts as Paid this week, and as Received next week.
- **Corrections:** a reversed payment raises Owed again, and a voided charge lowers Due.
- **Part payment:** a part-paid day counts towards Paid, and the day does not count as "paid in full".
- **Exempt days:** non-collection days and off-road days add nothing to Due.
- **Rate change mid-week:** each day uses the rate in force that day.
- **Privacy:** an operator cannot see another operator's figures, a cashier sees only their own collections, and a Supervisor sees no amounts.

## 8. Decisions

All four were agreed as recommended.

| # | Question | Decision | Where it stands |
| --- | --- | --- | --- |
| 1 | Does the week start on Monday or Sunday? | Monday, the common business week in Nigeria | Built: weeks run Monday to Sunday |
| 2 | Should the operator's "This week" show the rest of the week ahead, for example "₦70,000 for the full week"? | Yes, as a separate "Full week" line, never mixed into Due | Built: a "Full week" or "Full month" line on the portal and profile card. It adds the days still to come by the night job's rules (no non-collection or off-road days, each day at its rate) and shows only while days remain and the operator holds a tricycle |
| 3 | Should cashiers see fleet-wide totals as well as their own? | Assistant Managers see fleet totals. Any later cashier role sees only their own | Built: fleet totals need `finance.view`, My collections needs `payment.record` |
| 4 | Should the Owner's weekly summary in `NOTIFICATION_PLAN.md` use these figures? | Yes, so the summary and the screens always agree | Noted in `NOTIFICATION_PLAN.md`; applies when the weekly summary is built |
