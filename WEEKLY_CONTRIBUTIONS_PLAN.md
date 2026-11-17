# Jayngol Weekly Contributions Plan: ₦500 a Week from Every Operator

Status: proposed 17 November 2026, nothing built. Confirmed: the contribution is paid every Sunday, and it is company income. Decisions 3 to 8 in section 9 still need confirming.
Assumes: one senior developer, about 5½ working days, built on the existing ledger.

## 1. Goal

Every working operator pays ₦500 each week, on Sunday. At any moment the system must answer, with proof:

- Who has paid this week's contribution, and who has not?
- How many weeks does each operator owe, and since when?
- How much has been collected in total, and where is that money now?
- What has each operator contributed over time? Each operator must be able to see this for themselves.

It must be as easy to collect as the daily balance, and it must never mix with the daily balance, fines or loans.

## 2. What exists today, and what we reuse

- **One ledger for everything owed.** Daily balances, fines and loans are all `charges` rows. What is owed is always worked out from charges minus payments, and no running balance is stored. A weekly contribution fits this exactly as a fourth charge type.
- **Payments have a purpose:** day balance, old balance, fine, loan or general. Contributions become a fifth purpose.
- **The nightly job** already raises the daily balance for each operator and catches up missed days safely. It will also raise the weekly contribution.
- **The business week already runs Monday to Sunday** (`weekStart` in `src/lib/periods.ts`), so weekly totals line up with the existing week reports.
- **Corrections are reversal rows, never edits.** Payment reversals and charge voids already exist and will work for contributions without change.
- **One gap to close.** Credit, meaning money paid ahead, is spent automatically on daily balances (`applyCredit`). Contribution money must never be spent this way, and balance money must never pay a contribution. Section 4.3 covers this.

## 3. The rules, made exact

These follow the recommendations in section 9 and change if those decisions change.

| Rule | Exact meaning |
|---|---|
| Amount | ₦500 per week, kept in a dated rate table. A later change applies from a chosen Sunday, and past weeks keep the amount they had. |
| Who pays | Every **active** operator who holds a tricycle at the start of Sunday. |
| When it is raised | The nightly job for Sunday raises one contribution per operator for the week ending that Sunday. |
| Payment day | **Sunday, confirmed.** It is paid on Sunday, and becomes overdue from Monday. |
| New operator | Issued a tricycle on Sunday itself: the first contribution is the following Sunday. Issued any earlier day of the week: they pay that Sunday. |
| Tricycle in the workshop | Still charged. It is a membership contribution, not linked to earnings. This is decision 3. |
| Holidays | No effect. Holidays only stop daily balances. |
| Sacked or left | Weeks already raised are still owed. No new weeks are raised. |
| Late payment | No fine in version 1. Unpaid weeks show as owed, and reminders go out. This is decision 4. |
| Paying early | Allowed, from Monday of the same week, and up to 4 weeks ahead. The money waits as contribution credit and pays each Sunday's contribution as it is raised. |
| Part payment | Allowed. The oldest unpaid week is paid first. |
| Waiving a week | Manager only, with a reason. The charge is voided, not deleted, and the action is audited. |
| Start | The first Sunday after go-live. Weeks before that are never charged. |

Two weekly charges for the same operator and week are made impossible by a database constraint, so a job that runs twice changes nothing.

## 4. How it is built

### 4.1 Data

- **Migration 0029a:** add `contribution` to the `charge_type` and `payment_purpose` types. PostgreSQL cannot use a new type value in the same transaction that adds it, so this migration stands alone.
- **Migration 0029b:**
  - A `contribution_rates` table with `effective_from` (a Sunday) and `amount_kobo`, seeded with ₦500 from the start Sunday.
  - A unique index for one contribution per operator per week: `(operator_id, business_date) WHERE type = 'contribution'`, where `business_date` is the Sunday. `due_on` is the same Sunday.
- Money stays integer kobo, and the rate is copied onto each charge when it is raised.

### 4.2 Nightly job

- Add `createWeeklyContributions(tx, date)` to `processDay`, running only when the date is a Sunday, after daily balances are raised. The job runs as the day begins, so the contribution is ready before the first operator arrives on Sunday.
- It raises one charge per qualifying operator, then spends that operator's contribution credit.
- Catch-up runs raise each missed Sunday once and send no messages for past weeks, as the daily job already does.

### 4.3 Keeping the money separate

- **Payments:** `recordPayment` accepts `purpose = contribution`. That money goes only to contribution charges, oldest week first. Anything left becomes contribution credit, up to 4 weeks ahead.
- **Credit:** `applyCredit` and `unallocatedPayments` skip contribution payments. A new `applyContributionCredit` spends only contribution credit, and only on contributions.
- **Unpaid balances:** `listArrears`, the sacking count and the late balance fine (R1) read daily balances only, so an unpaid contribution never causes a fine or a sacking alert. Tests will check this.
- **Awards:** unpaid contributions do not count against the 6-month award in version 1. This is decision 6.
- **Reversals:** reversing a contribution payment brings the week back as owed, through the existing mechanism.

### 4.4 Screens

- **Contributions page** (`/contributions`, under Money):
  - This week: paid, part paid and unpaid, with totals and the date.
  - Each operator: phone, tricycle and registration, weeks owed and amount, with a **Take contribution** button.
  - Search by name, phone, tricycle or plate, following the other pages, and a filter by week.
- **Take payment:** a new **Contribution** option, prefilled with what the operator owes.
  - On the day-balance screen, a reminder appears if this week's contribution is unpaid, with a one-tap link to collect it.
  - The receipt says "Weekly contribution, Sunday 22 Nov 2026".
  - On Sundays, the Home page shows contributions collected so far today as its own figure.
- **Operator statement and profile:** contribution weeks appear on their own line, with paid, owed and credit.
- **Operator portal** (`/me`):
  - A "This week's contribution" card showing Paid, or ₦500 due on Sunday.
  - A history of weeks paid.
  - The total contributed.
- **Money page and Home:** a tile for this week's contributions collected out of the amount expected, and the count still unpaid. Weekly and monthly reports gain a contributions line.
- **Cash book:** contribution money enters cash like any other receipt, labelled Contribution, so the daily cash close still balances. It is company income, so it appears in income reports as its own line, next to daily balances and fines. Nothing is refunded.

### 4.5 Messages

These are queued in the existing SMS outbox and send once an SMS provider is connected.

- **Saturday evening:** "Jayngol: Your weekly contribution of ₦500 is due tomorrow, Sunday."
- **Monday:** a reminder to operators who did not pay on Sunday, with the number of weeks owed.
- **Payment:** confirmation on the payment receipt message.

### 4.6 Permissions

| Action | Who |
|---|---|
| View contributions | Owner, Manager, Assistant Manager (`finance.view`) |
| Take a contribution | Manager, Assistant Manager (`payment.record`) |
| Waive a week | Manager |
| Change the amount | Manager, from a future Sunday only |
| See own contributions | The operator, in the portal |

## 5. Delivery

### Stage 1: Ledger and job (2 days)
- Migrations, rate table, nightly raising, payments and the separate credit, waivers, reversals.
- **Exit:** a simulated 8 weeks for 12 operators reconciles to the kobo. This includes joining mid-week, sacking, paying ahead, part payments, reversals and a job run twice.

### Stage 2: Screens (2 days)
- The Contributions page, the Take payment option, statement, profile, portal, the Money tile and reports.
- **Exit:** a cashier collects a contribution in two taps from the Contributions page, and the operator sees it in the portal straight away.

### Stage 3: Messages and sample data (half a day)
- The Saturday and Monday messages, and the contributions added to `npm run db:sample`.
- **Exit:** the sample data shows a realistic mix of paid, owed and prepaid weeks.

### Stage 4: Check and sign-off (1 day)
- Full test suite, page audit for the new page, a walkthrough with the Manager.

## 6. Tests that must exist

- One charge per operator per Sunday, even if the job runs twice or catches up 3 missed weeks. No charge is raised on any other day.
- No charge for a week before the start date, for an operator who is not active, or for one with no tricycle at the start of Sunday.
- Amount comes from the rate in force on that Sunday, and a rate change never alters past weeks.
- Contribution money never pays a balance, fine or loan, and balance credit never pays a contribution.
- An unpaid contribution never adds an R1 fine, a sacking alert or a change to the unpaid balances total.
- Paying ahead stops at 4 weeks, and credit is spent on the next week as it is raised.
- Reversing a payment brings the week back as owed, and a waiver removes it with an audit entry.
- An operator sees only their own contributions.

## 7. Main risks

| Risk | Impact | Response |
|---|---|---|
| Contribution money is spent on balances by mistake | Wrong records for both | Separate credit rule, with tests in both directions |
| Operators see ₦500 as an extra charge and dispute it | Bad feeling, refusals | Clear portal card, receipts, Saturday message, and clear wording that it is a company contribution |
| Contribution income is hidden inside balance income | Owner cannot see what contributions bring in | Its own line in every income report, with a test |
| Cash close no longer matches | Daily close fails | Contribution receipts are part of the cash close from the first day, with a test |

## 8. Out of scope for version 1

- Interest or dividends on contributions.
- Different amounts for different operators.
- Online payment by operators.
- Automatic deduction from the daily balance. Each payment keeps one purpose, as decided for fines and loans.

## 9. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| 1 | What is the ₦500 for? | **Confirmed: company income.** No separate fund, payouts or refunds. |
| 2 | Which day it is paid | **Confirmed: every Sunday.** It is raised as Sunday begins and overdue from Monday. The week it covers is Monday to Sunday, matching the reports. |
| 3 | Charge when the tricycle is in the workshop | Yes. It is a membership contribution, not tied to earnings. |
| 4 | A fine for paying late | Not in version 1. Show it as owed and send reminders, then review after 2 months. |
| 5 | What happens when an operator is sacked or leaves | Weeks already raised stay owed. Nothing is refunded. |
| 6 | Does an unpaid contribution affect awards? | Not in version 1. |
| 7 | Paying ahead | Allow up to 4 weeks. |
| 8 | Start date | The first Sunday after go-live, with no back-charging. |
