# Production Reset Plan

Status: script built 17 Nov 2026 (`src/db/reset-for-go-live.ts`, `npm run db:reset-go-live`), with the recommended decisions in section 7. It was tried on a copy of the sample database, then **run on production on 17 Nov 2026 at about 12:24 Lagos time**. It kept the Manager and Assistant Manager logins, 29 operators and 29 tricycles (28 In stock, 1 Retired). The backups taken just before are in `~/Documents/Jayngol backups/`.

**Decisions taken:** the Owner login is kept with the Manager and Assistant Manager. Supervisor and operator portal logins are removed. Sacked and departed operators are kept as they are. Rules, fine amounts and every tricycle's daily balance history are kept. Who holds which tricycle is cleared. Store items are kept at zero stock.

## 1. Goal

Start live use with a clean ledger. Every payment, charge, fine, cash, bank, workshop, store, meeting, notice and audit record is removed. What stays:

| Kept | Notes |
| --- | --- |
| **Manager, Assistant Manager and Owner logins** | Same phone numbers and passwords. Everyone signs in again, because sessions are cleared. |
| **Operators** | Name, phone, address, licence and guarantor details. |
| **Tricycles** | Registration, code, chassis and engine numbers, purchase details, service cycle, and the daily balance set for each tricycle. |
| **Rules and fine amounts** | System settings, not records (decision 5). |

Before go-live, the Manager re-issues each tricycle to its operator. Balances, services and fines then start from that day.

## 2. What is cleared

All rows in these tables are removed:

- **Ledger and money:** `charges`, `charge_voids`, `payments`, `payment_allocations`, `payment_reversals`, `payment_references`, `late_evaluations`, `balance_waivers`, `balance_waiver_lines`, `balance_waiver_reversals`, `loans`, `operator_deposits`, `operator_deposit_reversals`, `contribution_rates`, `contribution_weeks`.
- **Cash and bank:** `cash_movements`, `cash_closes`, `cash_close_checks`, `money_transfers`, `bank_movements`, `bank_reconciliations`, `expense_advances`, `expense_lines`, `expense_line_voids`.
- **Who holds what:** `assignments`, `balance_rates`, `off_road_periods`.
- **Discipline and awards:** `violations`, `sticker_incidents`, `dismissals`, `meetings`, `meeting_attendance`, `award_candidates`, `awards`, `award_milestones`.
- **Workshop and store:** `work_orders`, `inspections`, `stock_items`, `stock_balances`, `stock_movements` (the item list may stay, at zero stock: decision 8).
- **Messages and system:** `notifications`, `notification_recipients`, `operator_notices`, `sms_outbox`, `photos`, `non_collection_days`, `job_runs`, `sessions`, `login_failures`, `audit_log`.
- **Logins:** every user except the Manager and the Assistant Manager. That is the Owner, the Supervisors and operator portal logins (decisions 1 to 3).

Then these are put straight:

- Every tricycle is set to **In stock**, since nobody holds one and no repair is open. Retired tricycles stay retired.
- Each operator's link to a portal login (`operators.user_id`) is cleared.
- The Manager's and Assistant Manager's failed-login counts and locks are reset.
- Receipt numbers restart at R-000001, and deposit receipts restart too.
- One audit entry, "System reset for go-live", records the date and how many rows each table had.

`job_runs` empty is safe. The nightly job then starts from the day it next runs and does not go back over old dates (`runDailyJob`).

## 3. How it is done

A one-off script, `src/db/reset-for-go-live.ts`. It is not a migration, so it can never run by accident on a deploy.

- **Dry run by default.** It prints what would be kept and removed, table by table, and changes nothing.
- **Runs only on purpose.** It needs `--confirm <database name>`, and it refuses `jayngol_test` and `jayngol_dev`.
- **One transaction.** It either finishes completely or changes nothing.
- **Order of work:**
  1. Lock the tables.
  2. `TRUNCATE … RESTART IDENTITY` all cleared tables in one statement. The append-only guards fire on delete and update, not on truncate. The three truncate guards (`audit_log`, `balance_rates`, `tricycle_balances`) are switched off for `audit_log` and `balance_rates` only, then switched back on before commit.
  3. Clear `operators.user_id`, then delete the other users.
  4. Set tricycle statuses, reset the receipt sequences, and write the reset audit entry.
  5. Run the checks in section 5. If any fails, everything is rolled back.
- **Tested first** on a copy of the production database restored locally, then on the sample database, before it ever touches production.

## 4. Running it on production

1. **Choose a quiet time.** Not between 22:30 and 23:30 Lagos time, around the nightly job at 23:05. Tell staff not to use the app for 30 minutes.
2. **Back up:** `pg_dump --format=custom` of production, saved in two places. Then check that the backup restores into a local database.
3. **Dry run** against production. Compare the kept counts with what the Manager expects: 2 logins, N operators, N tricycles.
4. **Run** with `--confirm`. Point the script at production by setting `DATABASE_URL` on the command line, which takes priority over `.env.local`. Use Supabase's Session pooler (port 5432), and a database login that owns the tables, since switching the truncate guards off needs it:

   ```bash
   DATABASE_URL='<production session pooler URL>' npm run db:reset-go-live
   DATABASE_URL='<production session pooler URL>' npm run db:reset-go-live -- --confirm postgres
   ```

   The first command is the dry run. The name after `--confirm` must be the database name the dry run prints.
5. **Check** (section 5), then sign in as the Manager.
6. **Re-issue the tricycles** to their operators, dated the go-live day. Re-create the Owner and Supervisor logins and operator PINs as decided.
7. **Keep the backup** for at least 12 months. It is the only copy of the old records.

## 5. Checks after the reset

- Exactly 2 users: one Manager, one Assistant Manager. Both can sign in.
- Operator and tricycle counts are the same as before.
- Every tricycle is In stock or Retired, and each still has its daily balance.
- Every cleared table has 0 rows, apart from the single reset audit entry.
- No reference points at a deleted row.
- Money, Unpaid balances, Cash close and Notifications all show empty, not errors.
- The next receipt number is R-000001.

## 5a. Trial result (17 Nov 2026, copy of the sample database)

- The dry run listed 38 tables with rows, and 10 already empty.
- A wrong `--confirm` name was refused, with nothing changed.
- The reset kept 3 logins, 12 operators, 14 tricycles (all In stock) and their 15 daily balance rows. It left one audit entry and no operator linked to a login.
- The append-only and truncate guards were working again afterwards.
- A second run was harmless.
- On the reset copy, a tricycle was issued and a payment recorded. Its receipt was R-000001.

## 6. Going back

There is no undo inside the app. Restoring the backup from step 2 (`pg_restore --clean`) returns the database to exactly where it was before the reset. Any records made since the reset are lost.

## 7. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Remove the **Owner** login as asked? The Owner would see nothing, and the oversight notices (waivers, large expenses, reversals, cash differences) would have nobody to go to until a new Owner login is made. | Keep the Owner login. |
| 2 | Remove the **Supervisor** logins as asked? Inspections and offence reports need them. | Remove, as asked. The Manager re-creates them from Staff in a minute. |
| 3 | Remove **operator portal logins**, so operators need a new PIN? | Remove, as asked. Set PINs again at go-live, as `NOTIFICATION_PLAN.md` section 11 already advises. |
| 4 | **Sacked or departed operators:** keep them as they are, or delete them? | Keep them as they are. They cannot be issued a tricycle, and their history is in the backup. |
| 5 | Keep the **rules and fine amounts**? | Keep. They are settings, and the Manager may have changed amounts. |
| 6 | Keep each tricycle's **daily balance** history, or only its current amount? | Keep it all. It belongs to the tricycle, not to any operator. |
| 7 | **Who holds which tricycle:** clear it and re-issue at go-live, or carry the current holders over? | Clear and re-issue. Carrying holders over would need their issue dates rewritten and invites old balances back. |
| 8 | **Store items:** clear the list too, or keep the items at zero stock? | Keep the item list at zero, so the Manager only enters opening stock. This differs from "keep only operators and tricycles", so it needs your word. |
