# Jayngol Plan: Each Tricycle Has Its Own Daily Balance

Status: Built on 12 Nov 2026 with the decisions in section 10. Not yet released to production.

**As built:** the balance lives in a `tricycle_balances` table (amount and start date per row, append-only) instead of a column on `tricycles`, so a change set for a later date is kept with its date. A tricycle's amount on any day is the newest row starting on or before it. Migration 0024 adds the table; 0025 fills it from every issue record, so each tricycle's amount today equals what it is charged today. The first amount entered when adding a tricycle starts from its purchase date. Issuing copies the tricycle's amount, and any change still to come, onto the issue record. The change form sits in the Current operator card (or a Daily balance card when in stock), and needs a reason. Covered by tests/assignments.test.ts.

## 1. Goal

Tricycles do not all earn the same: some pay ₦12,000 a day and some ₦15,000. The daily balance should belong to the **tricycle**:

- It is typed in by hand when a tricycle is added. There is no default.
- It can be changed later on the tricycle's page.
- Whoever holds the tricycle is charged that tricycle's amount.

## 2. What happens today

| | Today |
| --- | --- |
| Adding a tricycle | No balance is asked for. |
| Issuing to an operator | The balance is typed in every time, on the issue form, on the new operator form and on reinstatement. Nothing stops ₦12,000 one week and ₦15,000 the next for the same tricycle. |
| Where it is stored | On the issue record (`balance_rates`, one row per change, per assignment). The tricycle itself has no amount. |
| Changing it | Manager only (`rate.change`), from today or a later date, and only while the tricycle is with an operator. |
| Charging | The nightly job charges each day at the rate in force that day. |
| In the sample data | ₦10,000, ₦12,000 and ₦15,000 are all in use. 11 tricycles are out, 2 are in stock. |

The charging rules work well and stay as they are. The change is **where the amount comes from**.

## 3. The new rule

1. **Each tricycle has a daily balance.** A new `daily_balance_kobo` column on `tricycles`, required for every new tricycle.
2. **Adding a tricycle:** the form has a required **Daily balance (₦)** field. It is empty, so it must be typed. The hint reads "What this tricycle pays each day, for example 12,000 or 15,000".
3. **Issuing a tricycle:** the form no longer asks for an amount. It shows "Daily balance: ₦15,000 (set on the tricycle)". The amount is copied into `balance_rates` as today, so the nightly job does not change. The same applies to the new operator form and to reinstatement.
4. **Changing the amount:** on the tricycle's page, **Change daily balance** works whether the tricycle is in stock or with an operator.
   - **In stock:** the new amount applies straight away. No one is being charged.
   - **With an operator:** choose the start date, today or later, as now. The tricycle's amount changes, and a new rate is added to the open issue record from that date, so charges follow it.
   - A reason is required. The change is recorded in the audit log with the old and new amounts.
   - The operator gets a notice: "Your daily balance for JT-012 changes from ₦12,000 to ₦15,000 from 15 Nov 2026."
5. **History:** the tricycle page lists every amount it has had and from when (new `tricycle_balance_changes` table, append-only like the other money records).

## 4. Data and migration

**New column:** `tricycles.daily_balance_kobo`, with a check that the amount is above zero.

**New table:** `tricycle_balance_changes`.
- Columns: `id, tricycle_id, amount_kobo, effective_from, reason, created_by, created_at`.
- Append-only, so the history cannot be edited.

**Filling in existing tricycles (one migration):**

| Tricycle | Amount it gets |
| --- | --- |
| With an operator | The rate in force today on its open issue record |
| In stock, issued before | The last rate it was charged at |
| Never issued | None. It shows **"Daily balance not set"** and cannot be issued until the Manager sets it. |

- Every filled-in amount is also written to `tricycle_balance_changes` as its starting entry, so history starts complete.
- **Before release:** a read-only check on production lists each tricycle and the amount it will get, for the Manager to confirm. Any existing amount outside ₦5,000 to ₦30,000 is flagged; it is kept as it is, and only new changes must be in range.

**The column stays nullable** in the database so the "never issued" tricycles can exist. The add form and the issue check make it required in practice.

## 5. Screens

| Screen | Change |
| --- | --- |
| Add tricycle | Required **Daily balance (₦)** field, empty to start |
| Tricycles list | Shows each tricycle's daily balance; a "Balance not set" badge where it is missing |
| Tricycle page | Daily balance in the details, **Change daily balance** form (in stock or issued), history of amounts |
| Issue form, new operator form, reinstatement | Amount field removed; the tricycle's amount is shown instead. Choosing a tricycle with no amount says "Set this tricycle's daily balance first", with a link. |
| Operator page and portal | No change; they already show the current balance |

## 6. Permissions

| Action | Who |
| --- | --- |
| Set the balance when adding a tricycle | Manager and Assistant Manager (`tricycle.manage`, as for adding) |
| Change it later | Manager only (`rate.change`, as today) |
| See it | Everyone who can see tricycles |

## 7. Rules that keep the money right

- **No change in the past.** Today's charge is raised tonight at today's rate, so a start date of today is allowed but yesterday is not. This is the current rule.
- **One amount at a time.** A tricycle's amount and its open issue record's rate always agree from the start date onwards. Both are written in one transaction.
- **Old charges never move.** Changing the amount only affects days from the start date.
- **Limits:** an amount below ₦5,000 or above ₦30,000 is refused, to catch a missing or extra zero.

## 8. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Data | Column, history table, migration that fills in existing tricycles, production check | Half a day | Every issued tricycle's amount equals its current rate |
| 2. Add and change | Required field when adding; change form for in-stock and issued tricycles; history; audit; operator notice | 1 day | A change from tomorrow charges the new amount tomorrow and the old amount today, in tests |
| 3. Issue paths | Remove the amount from the issue, new operator and reinstatement forms; block issuing without an amount; list badge | Half a day | All three paths charge the tricycle's amount, in tests |

## 9. Testing

- Adding a tricycle without a balance is refused, and one with ₦15,000 is saved.
- Issuing charges the tricycle's amount, through all three paths (issue, new operator, reinstatement).
- A tricycle with no amount cannot be issued.
- Changing an issued tricycle from tomorrow: tonight's charge uses the old amount, tomorrow's uses the new one.
- Changing an in-stock tricycle applies at once, and its next issue uses the new amount.
- A change in the past is refused. An Assistant Manager cannot change the amount.
- ₦4,999 and ₦30,001 are refused; ₦5,000 and ₦30,000 are accepted.
- The migration gives each existing tricycle the right amount.
- The operator receives the change notice, and the audit log holds old and new amounts.
- The forms work at phone width (375 px).

## 10. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | When issuing, may staff type a different amount for that operator only (a discount)? | **Decided:** no. One amount per tricycle; change the tricycle's amount if needed. |
| 2 | Who may change a tricycle's amount after it is added? | **Decided:** Manager only, as today |
| 3 | Should the operator be told when the amount changes? | **Decided:** yes, by an in-app notice |
| 4 | What limits should catch typing mistakes? | **Decided:** refuse below ₦5,000 or above ₦30,000 |
| 5 | Tricycles never issued get no amount from the migration. Should they be blocked from issuing until one is set? | **Decided:** yes |
