# Jayngol Transport Management System: Development Plan

Status: business decisions confirmed 9 November 2026, tracker vendor still to confirm (section 9)
Assumes: one full-time senior developer, greenfield build

## 1. What we are building

Jayngol owns a fleet of tricycles and issues them to operators, who bring back a fixed balance every day. The company enforces rules with fines, services and repairs the fleet from its own store, lends money to operators, and rewards the best ones.

Today that is a money, trust and evidence problem more than a software problem. The system has to answer these questions at any moment, with proof:

- Who owes what, since when, and why?
- Which tricycles are on the road, in the workshop, or due for service?
- Who broke which rule, who recorded it, and what evidence exists?
- Where did the cash go?
- Who has earned an award, and can we show why?

**Users:** Manager, Assistant Manager and Supervisor operate the app. Operators log in and see only their own records. The owner or director has a read-only login to everything.

### Success measures

- Every naira collected has a receipt and appears against a named operator within minutes.
- No penalty is charged twice, and every penalty traces back to a rule and an event.
- A daily cash close matches the physical cash, with any difference recorded.
- At least 90% of active tricycles have an inspection recorded each working day.
- A supervisor can finish one tricycle's inspection in under 15 seconds on a cheap Android phone.

### Out of scope for version 1

Live tracker integration (manual entry first, see section 4), payroll, full general-ledger accounting, online payment by operators, and a native mobile app.

## 2. Key engineering decisions

| Decision | Choice | Why |
|---|---|---|
| Architecture | One modular application | One developer and a modest load. Microservices would add cost and no benefit. |
| App | Next.js with TypeScript, Tailwind, Zod | Matches the existing Devmustee stack, so there is nothing new to learn. |
| Client | Installable PWA, mobile-first | Supervisors work outdoors on low-end phones. It needs no app store and one codebase serves everyone. |
| Database | PostgreSQL, Drizzle ORM | Money and date-range rules need real transactions and database constraints. |
| Hosting | Vercel Pro and Neon Postgres (EU region), Cloudflare R2 for photos | Low operations work and point-in-time recovery. |
| Scheduled jobs | Cron calling idempotent job endpoints, tracked in a `job_runs` table | A missed run catches up on the next run instead of losing a day. |
| Login | Staff: phone and password. Operators: phone and PIN, with rate limiting and lockout | Operators may not have email addresses. |
| SMS | Nigerian provider (Termii or similar) behind one interface | Receipts by SMS are the strongest anti-fraud control in the system. |

### Non-negotiable rules for the codebase

1. **Money is stored as integer kobo.** Never a floating-point number. ₦3,000 is `300000`.
2. **Financial records are never edited or deleted.** Corrections are new reversing records with a reason. Database triggers block `UPDATE` and `DELETE` on these tables.
3. **All business time is Africa/Lagos (WAT).** Timestamps are stored as `timestamptz`, and each event also stores its `business_date`.
4. **Every rule is enforced by the database where possible,** not just in the UI: unique keys, exclusion constraints, non-negative stock checks.
5. **Every job and every offline submission is idempotent.** Running it twice has the same effect as running it once.
6. **Every sensitive action is audited:** who, when, before, after, and why.
7. **Amounts and rules are configuration, snapshotted at use.** Changing a fine next year must not change last year's records.

## 3. Domain model

### Core tables

**People and access**
- `users`: login, role (`owner`, `manager`, `assistant_manager`, `supervisor`, `operator`), status
- `operators`: name, phone, address, photo, licence, guarantor details, status (`active`, `sacked`, `left`), `user_id`
- `dismissals`: operator, assignment, unpaid days at trigger, flagged at, confirmed by and when, appeal status, appeal decided by, reinstated on
- `audit_log`: append-only

**Fleet**
- `tricycles`: registration number (unique), code number (unique), chassis and engine numbers, **`purchased_on`**, purchase cost, service interval (`fortnightly` or `monthly`), service cycle start date, status (`in_stock`, `issued`, `off_road`, `retired`)
- `assignments`: tricycle, operator, **`issued_on`**, `returned_on`, return reason. This keeps a full history, so a reissued tricycle never loses its past.
- `balance_rates`: assignment, daily amount, effective-from date. Supports ₦10,000, ₦12,000, ₦15,000 and any later change.
- `off_road_periods`: tricycle, start, end, reason, link to work order
- `non_collection_days`: dates with no balance due (holidays, for example)

**Money**
- `charges`: one table for everything an operator owes. Type (`daily_balance`, `penalty`, `loan`), operator, tricycle, amount, `business_date`, `due_at` (empty for loans), status (`open`, `voided`)
- `payments`: operator, amount, method, `received_at`, received by, `tricycle_present`, receipt number, client ID for idempotency
- `payment_allocations`: payment, charge, amount. What is still owed on a charge is its amount less its allocations.
- `loans`: operator, principal, disbursed on, approved by, status. One active loan per operator, enforced by a unique index.
- `cash_movements`: in or out, amount, custodian, source record
- `cash_closes`: custodian, date, expected, counted, difference, explanation
- `expense_advances` and `expense_items`: funds collected, what they were spent on, receipts, change returned

One `charges` table gives each operator a single statement and removes the need for a parallel ledger that could drift out of step.

**Compliance**
- `rules`: code, name, amount, effective-from date
- `violations`: rule, operator, tricycle, occurred at, amount snapshot, source, evidence, status, **`occurrence_key` (unique)**, linked charge
- `inspections`: tricycle, operator, supervisor, date, washed and polished (yes/no), sticker intact (yes/no), photos, location
- `meetings`: title, scheduled for, created by, notice sent at, status
- `meeting_attendance`: meeting, operator, status (`present_with_tricycle`, `present_without_tricycle`, `absent`, `excused`), reason
- `award_rules`, `award_candidates` (with stored evidence), `awards` (what was given, when, cost, by whom)

**Workshop and store**
- `work_orders`: type (`service`, `maintenance`), tricycle, scheduled for, checked in at, completed at, fault, findings, labour cost, status
- `stock_items`: engine oil, gear oil, tyre and others; unit; reorder level
- `stock_movements`: item, signed quantity, unit cost, reason, work order, tricycle, performed by
- `stock_balances`: current quantity, with `CHECK (quantity >= 0)`

### Database guarantees

```sql
-- A tricycle can never be with two operators at once.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE assignments ADD CONSTRAINT one_operator_per_tricycle
  EXCLUDE USING gist (
    tricycle_id WITH =,
    daterange(issued_on, returned_on, '[)') WITH &&
  );

-- The same offence can never be charged twice.
CREATE UNIQUE INDEX one_charge_per_offence
  ON violations (occurrence_key);

-- One daily balance per operator, tricycle and day.
CREATE UNIQUE INDEX one_daily_balance
  ON charges (operator_id, tricycle_id, business_date)
  WHERE type = 'daily_balance';
```

## 4. Business rules, made exact

### Daily balance

1. At 00:10 WAT a job creates that day's balance charge for every active assignment, at the rate in force that day.
2. The balance is due every day, including Sundays and public holidays. No charge is created on a date the Manager marks as a non-collection day, or when the tricycle is off-road for maintenance that day. A service morning is still charged.
3. Payments go to the oldest unpaid balance first. A part payment leaves the rest outstanding. Money goes to penalties or a loan only when the cashier selects it.
4. Payment time is set by the server. Only the Manager can backdate a payment, with a reason, because backdating could erase a fine.
5. A receipt goes to the operator by SMS as soon as the payment is saved.

**Worked example of the 2-day rule:** an operator pays nothing from Monday 9 November.

| Day | Unpaid days | Result |
|---|---|---|
| Mon 9 Nov | 1 | Allowed, no fine |
| Tue 10 Nov | 2 | Allowed, no fine. Monday's balance must be paid by 23:59 tonight. |
| Wed 11 Nov | 3 | ₦3,000 fine, for Monday's balance |
| Thu 12 Nov | 4 | ₦3,000 fine, for Tuesday's balance |
| Fri 13 Nov | 5 | ₦3,000 fine, for Wednesday's balance. Total ₦9,000. |
| After Friday ends | 5 | Sacking alert to the Manager |

The job runs at 00:05 each day. It must test **payments received by the deadline**, not what is outstanding when the job runs. Otherwise a payment at 00:01 on Wednesday would wrongly clear the offence.

A day counts as unpaid until its balance is fully paid. Because payments clear the oldest balance first, paying off an old day reduces the count. Fines stop at 3 per run of unpaid days, so a slow sacking decision cannot add a fourth.

### Sacking and appeal

1. When 5 daily balances are unpaid at the end of a day, the app alerts the Manager. It does not sack anyone by itself.
2. The Manager confirms the sacking. The operator is marked `sacked`, the tricycle is taken back, and its assignment closes with that return date. Daily balances stop from then on.
3. All debts stay on the operator's account after sacking.
4. If the operator appeals and the Manager accepts, the operator must first pay the **₦9,000 in fines and all unpaid daily balances**.
5. Reinstatement creates a new assignment with a new issue date, so the history shows the break.
6. The 3 fines remain confirmed offences, so they still count against awards.

### Offences

| Code | Offence | Fine | How it is detected | One charge per |
|---|---|---|---|---|
| R1 | Balance not paid within 2 days | ₦3,000 | Automatic nightly job | Daily balance, up to 3 per unpaid run |
| R2 | Not washed and polished | ₦3,000 | Daily supervisor inspection | Tricycle, per day |
| R3 | Late for service (outside 8:00 to 10:00 WAT) | ₦3,000 | Workshop check-in time | Work order |
| R4 | Company sticker removed | ₦3,000 | Daily supervisor inspection | Removal incident (see below) |
| R5 | At general meeting without tricycle | ₦3,000 | Meeting attendance | Meeting |
| R6 | Absent from general meeting | ₦6,000 | Meeting attendance | Meeting |
| R7 | Working after 10:00 pm | ₦3,000 | Tracker, entered by staff | Night |
| R8 | Came to pay balance without tricycle | ₦3,000 | Checkbox on the payment screen | Operator, per day |

Details that must be handled:

- **R6 is one offence with a ₦6,000 fine,** not two records. R5 and R6 cannot both apply to the same meeting.
- **A tricycle held in the workshop is an exemption.** If it is off-road, R3, R5 and R8 do not apply, because the operator cannot bring it. R6 still applies, because the operator can attend the meeting without it.
- **R4 is charged once per incident,** not every day until the sticker is replaced. A new charge applies only if it is replaced and removed again.
- **R7 uses a "night" that ends at 05:00,** so working from 10:30 pm to 1:00 am is one offence on one date. In version 1, staff record it with the tracker time and a screenshot. A tracker import comes after go-live, once we know the vendor's export or API.
- **R8 is a required yes/no answer for in-person payments.** It must not default to either answer. Operators can pay by cash, transfer or POS, and the question does not appear for a remote transfer.
- **An excused meeting absence carries no fine.** Only the Manager can excuse one, and the reason is recorded.

### Violation lifecycle

```
Supervisor or system raises it → PROPOSED
PROPOSED → CONFIRMED (creates the charge) or REJECTED (reason required)
CONFIRMED → WAIVED or REVERSED (Manager only, reason required, charge voided)
```

R1 is confirmed automatically because it is pure arithmetic. All others are raised by one person and confirmed by the Assistant Manager or Manager. This protects operators from unfair charges and protects the company from a supervisor being paid to ignore an offence.

### Service and maintenance

- Each tricycle is on a fixed fortnightly or monthly cycle counted from its cycle start date. A late service does not move later dates. Staff can reschedule a single date without changing the cycle.
- The company pays for parts and labour, so workshop costs never become charges on an operator.
- Service and maintenance share one work-order flow: check in, record findings, issue parts from store, complete.
- Maintenance marks the tricycle off-road, which stops balance charges until it is released.
- The tricycle's history shows every service, repair, part and cost.

### Store

- Every change is a stock movement: received, issued, adjusted. Issues must link to a work order and tricycle.
- Stock cannot go below zero, including when two people issue at the same moment.
- Engine oil and gear oil are tracked by the litre, and tyres by whole quantity.
- Stock-count adjustments are Manager-only with a reason.

### Expenses and loans

- **Expenses:** the Manager records funds collected, then accounts for them with items, receipts and any change returned. The Assistant Manager countersigns, so no one person controls the record, and the owner can review it all. An unaccounted-for advance stays visible as outstanding.
- **Loans:** the Manager approves and sets the amount. There is no interest or fee and only one active loan per operator. The operator repays any amount at any time until it is cleared, using the same receipt flow as the daily balance. With no schedule there are no late-loan fines.

### Awards

The system runs on the 1st of each month and proposes candidates. The Manager approves, and the award is recorded with what was given and its cost.

| Award | Who qualifies | Prize |
|---|---|---|
| Consistency | 6 months: every balance on time and no confirmed offence of any kind | Smartphone |
| Clean vehicle | Has never had a confirmed R2 | Clothes |
| Law-abiding | Has never had a confirmed offence of any kind | Cash |

Clean Vehicle and Law-Abiding can be won every 6 months while the record stays clean. One operator can win all three awards at once. The Manager sets the cash amount. Offences in existing written records are imported and count against these awards. Operators with no written offence start clean.

Safeguards that make the awards fair:

- **Minimum service:** a new operator with a clean first week has technically "never violated". Each award needs at least 6 months of service.
- **Inspection coverage:** "never violated R2" means nothing if the tricycle was rarely inspected. Candidates need inspections on at least 80% of working days, and the Manager sees the figure.
- Rejected, waived and reversed violations do not count against an operator.
- After a Consistency award, the next 6-month period starts fresh, so one good run cannot win a phone every month.
- Each candidate stores the facts behind its result, so any award can be explained later.

## 5. Permissions

Y = yes, Own = own records only, blank = no access.

| Action | Manager | Asst. Manager | Supervisor | Operator |
|---|:-:|:-:|:-:|:-:|
| Manage tricycles, operators, issue tricycles | Y | Y | | |
| View fleet and operator records | Y | Y | Y | Own |
| Record balance payments | Y | Y | | |
| Reverse or backdate a payment | Y | | | |
| Record inspections, raise violations | Y | Y | Y | |
| Confirm or reject violations | Y | Y | | |
| Waive or reverse a violation | Y | | | |
| Confirm a sacking, decide an appeal | Y | | | |
| Schedule general meetings | Y | | | |
| Take meeting attendance | Y | Y | Y | |
| Create and complete work orders | Y | Y | Check-in only | |
| Receive and issue stock | Y | Y | | |
| Adjust stock after a count | Y | | | |
| Record expense funds | Y | | | |
| Countersign expenses | | Y | | |
| Approve loans and awards | Y | | | |
| Change rates, fines and users | Y | | | |
| Financial reports | Y | Y | | |
| Balance, penalties, loan, awards, service history | Y | Y | Limited | Own |

**Owner:** read-only access to every screen, report and the audit log. The owner cannot create or change anything.

**Operator data isolation:** all operator-portal queries live in one module and take the operator ID only from the login session, never from the URL or request. Automated tests attempt to read another operator's records through every portal route and must fail.

## 6. Key screens

- **Supervisor, Today:** a list of tricycles not yet inspected. Two taps per tricycle, with a photo required only when something fails. Works offline and syncs when signal returns.
- **Cashier, Take Payment:** search by code number, see arrears, enter amount and method, answer "tricycle present?", save, receipt sent.
- **Manager Dashboard:** expected against collected today, overdue operators, violations to confirm, tricycles off-road, services due, low stock, unaccounted advances.
- **Tricycle Profile:** purchase date, current and past operators with issue dates, income, repair costs, service history.
- **Operator Profile and Statement:** balances, penalties, loans, awards, all on one timeline.
- **Operator Portal:** what I owe, my payments, my offences with evidence, my loan, my next service, my award progress.

### Reports

Daily collection and arrears, income per tricycle against maintenance cost, offences by rule and by operator, inspection coverage by supervisor, stock usage, expenses by category, loan book, cash close history. All export to CSV and PDF.

## 7. Delivery roadmap

Estimated total: **about 13 weeks**. The company can start using the system at the end of Phase 3, at about week 6 to 7.

### Phase 0: Decisions and setup (week 1, 3 to 4 days)
- Confirm the tracker vendor (section 9).
- Collect current records: fleet list, operator list, debts, loans.
- Set up repository, CI, staging and production, backups, error monitoring.
- **Exit:** decisions signed off, and an empty app deployed to staging.

### Phase 1: Foundation (weeks 1 to 3)
- Login, roles, audit log, mobile app shell, injectable clock for testing.
- Tricycles with purchase date; operators; issue and return flow with issue date; balance rates.
- **Exit:** the whole fleet can be entered, and double-issuing a tricycle is impossible.

### Phase 2: Money core (weeks 3 to 5)
- Daily balance job with catch-up, payments, allocation, receipts, SMS.
- Reversals, operator statement, daily cash close, R1 and R8.
- 5-day sacking alert, Manager confirmation, appeal and reinstatement.
- **Exit:** a full month of simulated payments reconciles to the kobo.

### Phase 3: Rules and inspections (weeks 5 to 7)
- Rule catalogue, violation lifecycle, offline inspections with photos.
- Meetings and attendance, R2, R4, R5, R6, R7, first version of the operator portal.
- **Exit:** each rule has passing tests for its charge, its exemptions and its duplicate protection.
- **First usable release.**
- **Status:** built and tested. Evidence photos are compressed on the phone and stored privately in the database, so Cloudflare R2 is not needed until photo volume calls for it. Meeting notices are queued until an SMS provider is connected. The off-road exemptions take effect once Phase 4 can mark a tricycle off-road.

### Phase 4: Workshop and store (weeks 7 to 9)
- Service scheduling, check-in, R3, maintenance, off-road handling.
- Store items, movements, reorder alerts, tricycle cost history.
- **Exit:** a repair issues a part, reduces stock, stops the balance and shows on the tricycle's cost.
- **Status:** built and tested.

### Phase 5: Expenses and loans (weeks 9 to 10)
- Expense advances with countersign, loans with repayment at any time, full cash book.
- **Exit:** the cash book agrees with all payments, expenses, and loans for a test month.
- **Status:** built. The exit test covers a full test month of cash, bank, reversals, change, cancelled funds and loan repayments.

### Phase 6: Awards, portal and reports (weeks 10 to 11)
- Award engine and approval, complete operator portal, notifications, dashboards and exports.
- **Exit:** award results match a set of hand-checked test operators.
- **Status:** built. The exit test covers hand-checked operators and the boundaries: exactly 6 months, exactly 80% inspection coverage, waived offences and reversed payments. Assumption to confirm: giving an award moves no money, so its cost is entered as an expense by hand, the same as decision 23.

### Phase 7: Migration and go-live (weeks 11 to 13)
- Import fleet, operators, debts, loans and written offence history through validated CSV templates, with a dry run first.
- Train staff in the field, security review, restore-from-backup drill.
- Pilot with 10 to 20 tricycles, then run the paper book alongside the app for 2 weeks.
- **Exit:** two consecutive weeks of cash closes match, then the paper book stops.

## 8. Quality, security and operations

### Tests that must exist

- 2-day deadline at the exact boundary, including a payment at 23:59 and at 00:01.
- 5 unpaid days produce exactly 3 fines (₦9,000) and one sacking alert, and no fourth fine while the Manager decides.
- A payment on day 4 reduces the unpaid count and prevents the sacking alert.
- An appeal cannot reinstate an operator until the ₦9,000 and all balances are paid.
- A late service does not move the fixed service cycle.
- Part payments, overpayments and payments spanning several days.
- Reversal of a payment that had prevented a fine.
- Rate change in the middle of a month.
- Tricycle reassigned: old debts stay with the old operator.
- Job run twice, job skipped for three days and then caught up.
- Same offline inspection submitted twice.
- Two people issuing the last tyre at the same moment.
- Tricycle in the workshop on a meeting day.
- Every operator-portal route tested against another operator's data.
- Award boundary cases: exactly 6 months, a waived violation, low inspection coverage.

Time-based logic takes a clock as input so that tests can run any date without waiting.

### Security and privacy

- Server-side permission check on every action; rate limiting on login.
- Operator PINs are hashed. Staff sessions expire on idle.
- Nigeria Data Protection Act: collect only needed personal data, restrict access to guarantor details and location evidence, and agree a retention period.
- Photos are private and served through short-lived links.

### Operations

- Point-in-time database recovery, plus a nightly off-site backup and a restore test every quarter.
- Error monitoring, and an alert when a nightly job fails or does not run.
- Manager's settings changes appear in the audit log.

## 9. Confirmed decisions

Confirmed on 9 November 2026.

| # | Question | Decision |
|---|---|---|
| 1 | What does the ₦3,000 meeting offence mean? | The operator came to the meeting without the tricycle |
| 2 | Is the balance due every day? | Yes, including Sundays and holidays, except dates the Manager marks |
| 3 | Is a balance owed when off-road? | Not during maintenance. Yes on a service morning. |
| 4 | How many fines for 5 unpaid days? | 3 fines, ₦9,000, on days 3, 4 and 5 |
| 5 | What happens at 5 unpaid days? | App alerts the Manager, who confirms the sacking and decides any appeal |
| 6 | What does an appeal cost? | ₦9,000 in fines and all unpaid balances |
| 7 | How can operators pay? | Cash, transfer or POS. R8 applies to in-person payments only. |
| 8 | Who receives balance money? | Manager and Assistant Manager only |
| 9 | Who pays for parts and repairs? | The company |
| 10 | Does the sticker fine repeat daily? | No, once per removal |
| 11 | How often can Clean Vehicle and Law-Abiding be won? | Every 6 months while the record stays clean. Manager sets the cash amount. |
| 12 | Can one operator win all three awards? | Yes |
| 13 | Do past written offences count? | Yes, if on record. Otherwise the operator starts clean. |
| 14 | Do the award safeguards stay? | Yes: 6 months' service and 80% inspection coverage |
| 15 | What are the loan terms? | No interest, one active loan, Manager sets the amount |
| 16 | How are loans repaid? | Any amount at any time until cleared |
| 17 | Who checks the Manager's expenses? | Assistant Manager countersigns |
| 18 | Does the owner get a login? | Yes, read-only |
| 19 | Can a meeting absence be excused? | Yes, by the Manager, with a reason |
| 20 | How is the next service date set? | Fixed cycle, not moved by a late service |
| 21 | Can operators come to own the tricycle? | No, the company keeps it |
| 22 | Which days are free during a repair? | The day it goes in is charged. Each later day is free, including the day it is released. A repair finished the same day changes nothing. |
| 23 | How do workshop labour and store purchases reach the cash book? | The Manager enters them by hand as expenses. Recording a repair or stock delivery moves no money, so nothing is counted twice. |
| 24 | What comes off the Collected today card? | All loans and expense funds given out that day, whether from cash held, the bank or the owner. Change returned and cancellations are added back. The comparison with the amount due still uses the full amount collected. |

**Still open:** the tracker vendor and what it can export. Staff enter R7 manually with a screenshot until this is known.

**Assumption to check with the company:** the first daily balance is charged the day after a tricycle is issued, and the day it is returned is still charged.

**Assumption to check with the company:** expense funds and loans taken as cash cannot exceed what that person holds that day. Anything larger is recorded as coming from the bank or the owner.

**Assumption to check with the company:** an operator can hold only one tricycle at a time. The database enforces this, and it can be removed if some operators hold two.

**Assumption to check with the company:** a day counts as unpaid until its full balance is paid, and payments clear the oldest day first. An operator who keeps paying part of the money can therefore still reach 5 unpaid days.

## 10. Main risks

| Risk | Impact | Response |
|---|---|---|
| Staff keep using the paper book | Data is incomplete and the system is not trusted | Extremely fast entry screens, field training, and a firm date to stop the paper book |
| Cash is taken but not recorded | Direct financial loss | Instant SMS receipts, daily cash close, reversal restricted to the Manager |
| Supervisor collusion or false reports | Unfair fines, unfair awards | Two-person confirmation, photos, inspection coverage report |
| Poor network in the field | Inspections are skipped | Offline queue with safe resubmission |
| Operators dispute fines | Conflict and lost trust | Evidence visible in the portal, Manager can waive with a reason |
| Opening balances are wrong | Disputes from day one | Dry-run import, and each operator confirms their opening figures |
| Manager controls money and the system | Fraud cannot be detected | Audit log, countersign, read-only owner access |
| Scope grows during the build | The first release slips | Tracker integration and other extras wait until after go-live |

## 11. Next steps

1. Provide the current fleet list, operator list, outstanding debts, loans and written offence records.
2. Confirm the tracker vendor and the SMS sender name.
3. Start Phase 1.
