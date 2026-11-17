# Jayngol Balance Waiver Plan: Forgiving Daily Balances, with Proof

Status: proposed 17 November 2026, nothing built. Confirmed: Manager only, the Owner is told of every waiver, part amounts allowed, and the late fine is offered for waiving too. Decisions 5 to 7 in section 9 still need confirming.
Assumes: one senior developer, about 4½ working days, built on the existing ledger.

## 1. Goal

Sometimes an operator should not pay a day's balance: a breakdown the workshop never recorded, illness, a death in the family, a police seizure, or a mistake by staff. Today the only way out is to leave the debt on the books or to change records by hand. Neither is acceptable.

A waiver must:

- Remove all or part of a day's balance, so the operator no longer owes it.
- Never delete or edit a record. Every naira forgiven can be traced to a person, a reason and a time.
- Show the Owner how much income was given up, by whom and why.
- Be hard to abuse: only the Manager can waive, and the Owner is told every time, so no waiver goes unseen.

## 2. What exists today, and what we reuse

- **Charges are append-only.** A correction is always a new row. `charge_voids` already removes a whole charge; it is used when a tricycle is returned early and for contribution waivers.
- **Everything reads through two views.** `valid_charges` (charges not voided) and `effective_allocations` (payments not reversed). Owed is always charge amount minus allocations; no running balance is stored.
- **Credit moves by itself.** `applyCredit` puts unused money on the oldest unpaid days, so freeing money from a day settles itself.
- **Owner oversight already exists** for large Manager expenses (`large_expense` notice to `expense.oversee`). Waivers reuse it, for every waiver.
- **Gap:** a void can only remove a whole day. A waiver of ₦5,000 of a ₦12,000 day, or of only the unpaid rest of a part-paid day, is impossible today.

## 3. The rules, made exact

| Rule | Exact meaning |
|---|---|
| What can be waived | Daily balances only, for today or earlier. Fines keep their own waiver; loans and contributions are not covered. |
| How much | **Confirmed:** the whole unpaid part of a day (the default), or a set amount up to it. Money already paid on a day is never taken back. |
| Several days | One waiver can cover many days of one operator, oldest first, with one reason. |
| Who waives | **Manager only, confirmed.** The waiver takes effect at once; there is no request or approval step. |
| Owner | **Told of every waiver, confirmed**: operator, days, amount, reason and the Manager's name. |
| Reason | Required: a category (breakdown, illness, bereavement, accident, police, staff mistake, other) and a note. |
| Undo | The Manager can reverse a waiver with a reason. The days become owed again. |
| Already fined | **Confirmed:** the form offers "also waive the late fine" for that day, ticked by default. The Manager can untick it to keep the fine. |
| Whole fleet | A day waived for everyone (flood, strike, a public order) is done as a no-balance day after the fact, not 12 waivers (section 4.5). |

## 4. How it is built

### 4.1 Data

- **`balance_waivers`**: one waiver. `id`, `operator_id`, `reason_code`, `note`, `waived_by`, `waived_at`, `fine_waived` (yes or no). It counts from the moment it is saved.
- **`balance_waiver_lines`**: one day in a waiver. `waiver_id`, `charge_id`, `amount_kobo` (> 0). Only daily-balance charges, checked by a trigger.
- **`balance_waiver_reversals`**: `waiver_id` (primary key), `reversed_by`, `reason`, `reversed_at`. Append-only, like payment reversals.
- Waivers, lines and reversals are all append-only (`forbid_change()`).

### 4.2 One change makes the whole system respect waivers

Redefine `valid_charges` so that its `amount_kobo` is the amount **after** unreversed waivers, and a charge waived down to zero drops out like a void:

```sql
CREATE OR REPLACE VIEW valid_charges AS
  SELECT c.id, c.type, c.operator_id, c.tricycle_id, c.assignment_id,
         c.amount_kobo - COALESCE(w.waived, 0) AS amount_kobo,
         c.business_date, c.due_on, c.created_at
  FROM charges c
  LEFT JOIN LATERAL (SELECT SUM(l.amount_kobo) AS waived ... not reversed) w ON true
  WHERE NOT EXISTS (SELECT 1 FROM charge_voids v WHERE v.charge_id = c.id)
    AND c.amount_kobo - COALESCE(w.waived, 0) > 0;
```

Every screen that reads owed balances (Unpaid balances, Take payment, statement, sacking count, the late fine, reports) already goes through this view, so they all follow without their own change. A new `charge_waived_kobo` view gives the waived figure for reports.

Places that read `charges` directly are reviewed one by one: the statement history (shows the original amount and a "Waived ₦…" note) and the payment-review tricycle lookup (no change needed).

### 4.3 Saving a waiver

In one transaction, holding the operator's row lock:

1. Re-read each day. A line may not exceed what is unpaid **now**; if a payment came in while the form was open, the Manager sees the new figure and saves again.
2. Write the waiver and its lines.
3. If "also waive the late fine" is ticked, waive the R1 fines linked to those days (`violations.source_charge_id`) through the existing `waiveViolation`.
4. Run `applyCredit`, so any money waiting as credit moves to the next unpaid day.
5. Re-check open sacking alerts for the operator: if their unpaid days fall below 5, the alert closes with the note "Days waived".
6. Audit, notify the operator ("Your balance for 9 Nov 2026 was waived"), and notify the Owner: "Jayngol Manager waived ₦12,000 for Sadiq Bello (1 day, 9 Nov 2026): illness."

Reversing a waiver does the same in reverse: the days are owed again, credit is re-applied, and the R1 fine is **not** brought back (it was waived on its own).

### 4.4 Effects on rules that look at the past

- **Late fine (R1):** a day waived before it is judged is never fined. A day judged late keeps its record in `late_evaluations`.
- **Sacking:** waived days stop counting immediately.
- **Awards:** a waiver must not turn a late day into an on-time one. The award checks keep using money received by the deadline against the **original** amount for days judged late, and treat a day waived in full as neither worked nor late (decision 5). Tests cover both.
- **Reports:** "Balances due" falls by the waived amount, and a new **Waived** line shows it, so due − waived − paid = owed still adds up. This line appears in balance periods, monthly reports, the annual balance and its CSV.
- **Cash:** no cash moves. A waiver never touches the cash book, so the cash close is unaffected.

### 4.5 Waiving a day for the whole fleet

The Manager adds a past date on the **No-balance days** page. Today that only stops future balances; it will now also offer "Waive balances already raised for this date", which creates one waiver per affected operator, with reason "No-balance day" and a single audit entry for the batch. The Owner gets one notice for the whole day, not one per operator.

### 4.6 Screens

- **Unpaid balances page** (the screenshot): a **Waive** button next to **Take payment** on each operator, shown to the Manager only. It opens the waiver form for that operator.
- **Waiver form** (`/waivers/new?operator=…`):
  - Unpaid days listed with tick boxes, each with the amount owed, oldest first.
  - Per day: "Whole day" or "Set amount".
  - Reason category, note, and a running total.
  - "Also waive the late fine" for days that were fined, ticked by default.
  - The button reads "Waive ₦27,000", followed by a confirm step showing the days and total.
- **Waivers page** (`/waivers`, under Money → Problems to follow up):
  - Every waiver, newest first, with search by operator, phone, tricycle or plate (same search bar as the other pages), filter by status and reason, and totals for this week and month.
  - Reverse, for the Manager, with a reason.
- **Operator profile and statement:** waived days show "Waived ₦5,000 · illness · by …".
- **Operator portal:** the day shows as waived, and the message appears in their notices.
- **Owner:** each waiver arrives as a notice that opens the waiver on the Waivers page.

### 4.7 Permissions

| Action | Who | New permission |
|---|---|---|
| Waive or reverse a waiver | Manager | `balance.waive` |
| Be told of every waiver | Owner | new `balance.waive.oversee` |
| See waivers | Owner, Manager, Assistant Manager | `finance.view` |
| See own waived days | The operator | portal |

## 5. Delivery

### Stage 1: Ledger (2 days)
- Tables, triggers, the new `valid_charges` view, saving and reversing, the late-fine option, credit, sacking re-check.
- **Exit:** the full test suite still passes unchanged (proof that the view change broke nothing), plus the new tests in section 6.

### Stage 2: Screens (1½ days)
- Waive button on Unpaid balances, waiver form, Waivers page with search, statement and portal lines, the Waived line in reports.
- **Exit:** a Manager waives two days in under 30 seconds from Unpaid balances, and the Owner's notice arrives straight away.

### Stage 3: Fleet day, messages, sample data (half a day)
- No-balance day after the fact, operator and Owner notices, waivers in `npm run db:sample`.

### Stage 4: Check (half a day)
- Full suite, page audit on the two new pages, walkthrough with the Manager.

## 6. Tests that must exist

- A whole-day waiver removes the day from Unpaid balances, the statement and the sacking count; a part waiver leaves exactly the rest.
- A waiver can never exceed what is unpaid, even when a payment lands while the form is open.
- Money already paid on a day is never moved or lost; credit moves to the next unpaid day.
- Reversing a waiver brings the exact amount back as owed.
- Only the Manager can waive or reverse; the Assistant Manager, Supervisor and Owner are refused.
- The Owner gets exactly one notice per waiver, and one per fleet day.
- With the fine box ticked the R1 fine is waived; unticked it stays owed.
- A waived day is never fined; an already-judged late day stays late for awards.
- Reports: due − waived − paid = owed, for a week, a month and the year, to the kobo.
- The cash close is unchanged by any waiver.
- The fleet-day waiver creates one waiver per affected operator, and running it twice changes nothing.
- An operator sees only their own waived days.

## 7. Main risks

| Risk | Impact | Response |
|---|---|---|
| The view change alters a figure somewhere unexpected | Wrong totals | The whole existing suite must pass unchanged before any screen work; review every direct read of `charges` |
| Waivers used to favour friends | Lost income | Manager only, the Owner told of every waiver, reasons required, a Waived line in every report |
| Waivers used to escape sacking or win an award | Unfair outcomes | Sacking re-check is logged; awards judge lateness by the original deadline |
| Stale amounts while the form is open | Waiving money already paid | Re-check under the operator lock when saving |

## 8. Out of scope for version 1

- Waiving fines (already exists), loans or contributions from this screen.
- Automatic waivers, for example from workshop records. The existing off-road rule already stops balances for recorded workshop days.
- A monthly waiver budget per Manager.

## 9. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| 1 | Who can waive | **Confirmed: Manager only.** |
| 2 | When the Owner is told | **Confirmed: every waiver.** One notice per fleet day. |
| 3 | Part amounts | **Confirmed: allowed.** A whole day is the default. |
| 4 | Late fine on a waived day | **Confirmed:** offered at the same time, ticked by default. |
| 5 | Awards | A day judged late stays late; a day waived in full before its deadline counts as neither worked nor late. |
| 6 | Undo | Manager can reverse with a reason. |
| 7 | How far back | Any unpaid day, while the operator still owes it. |
