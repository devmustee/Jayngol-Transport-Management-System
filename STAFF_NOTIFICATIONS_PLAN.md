# Staff Notifications (Notification Plan, Phase 2)

Status: built 17 Nov 2026 (tests/staff-notifications.test.ts). Differences from the plan: staff account changes were dropped, because only the Manager makes them and the actor is never told; reversals are not sent to the operator (no operator notice existed); the Money and Home alert rows still read `financeOverview`, which uses the same queries; the bell counts each kind of work once, not every item. This plan details Phase 2 of `NOTIFICATION_PLAN.md`. Once it is built, that plan's section 5 table is replaced by section 4 here.

## 1. The problem

Staff see an empty Notifications page. The bell, the inbox and `notify()` all work (Phase 1), but almost nothing sends staff a notice:

- Only two staff notice kinds exist, `balance_waiver` and `large_expense`, and both go to the Owner.
- The Manager, the Assistant Manager and the Supervisors receive nothing.
- Work waiting for them is shown only as alert rows on the Money and Home pages. Nobody sees it unless they open those pages.

## 2. Goal

Every staff member opens the app and sees, in one place:

- **Needs action:** work waiting for them now.
- **Updates:** things that happened and that they should know about.

Urgent items stay in view until opened. Each event reaches exactly the right people, and nobody is told about something they just did themselves.

## 3. Design

### 3.1 Needs action is calculated live, never stored

This was agreed in `NOTIFICATION_PLAN.md` 3.1. A stored "3 offences to confirm" goes stale the moment someone else confirms one, so the list is worked out from the records each time.

- One new service, `needsAction(ctx)`, returns a list of `{ key, title, count, link, severity }` for the person, filtered by permission.
- It reuses the queries the alert rows already use: `financeOverview`, `cashAlerts`, `advanceCounts`, `awardsToDecide`, `lowStock`, `partsToIssue` and `inspectionToday`. The Money and Home alert rows then read from it too, so the two can never disagree.
- The bell count becomes unread updates plus open action items. The 60-second summary check gets one combined count query (target under 50 ms on the sample data) rather than calling every list.

### 3.2 Updates are stored, in the same transaction as the event

`notify()` is unchanged in principle. Three small additions:

1. **More than one audience permission.** A catalogue entry can name a list of permissions, and anyone holding any of them is told. For example, an Owner-only `*.oversee` permission plus the permission of the person who acts.
2. **Never tell the actor.** `NotifyEvent.exceptUserId` (set from `ctx.actor.userId`) removes the person who caused the event. The Manager is not told that the Manager reversed a payment.
3. **Named people.** `userIds` already exists. It is used for events about one person, such as the receiver of a handover or the Supervisor who raised an offence. The permission check still applies, so a disabled account is skipped.

Every stored event has a `dedupeKey` built from the entity and the event, so a retry or a re-run of the nightly job posts nothing twice.

### 3.3 Critical banner

A strip across the top of every staff page shows the newest unread critical update, such as "Musa Ali has reached 5 unpaid days". Tapping it opens the notice and marks it read. It is drawn on the server from the same summary the bell uses, so it costs no extra request.

### 3.4 Owner noise

Following decision 4 of the main plan, the Owner receives:

- critical items;
- the oversight notices that already exist (waivers and large expenses);
- payment reversals and backdates (decision 1 below).

The weekly summary stays in Phase 5.

## 4. Who gets what

### 4.1 Updates (stored)

| Event | Raised in | Severity | Recipients (audience permission) | Dedupe key |
| --- | --- | --- | --- | --- |
| Payment reversed | `reversePayment` | action | Operator (exists), Owner (new `payment.oversee`) | `payment:<id>:reversed` |
| Payment backdated | `recordPayment` when backdated | action | Owner (`payment.oversee`) | `payment:<id>:backdated` |
| Operator reaches 5 unpaid days | `daily-job` sacking check | critical | `dismissal.decide`, Owner (new `dismissal.oversee`) | `dismissal:<id>:flagged` |
| Offence raised | `proposeViolation`, `raiseLateWork` | action | `violation.confirm`, except the person who raised it | `violation:<id>:raised` |
| Offence confirmed, rejected or waived | `confirmViolation`, `rejectViolation`, `waiveViolation` | info | The Supervisor who raised it (`userIds`) | `violation:<id>:<outcome>` |
| Cash handover sent | `createTransfer` (handover) | action | The receiver (`userIds`) | `transfer:<id>:sent` |
| Cash handover refused | `rejectTransfer` | action | The sender (`userIds`) | `transfer:<id>:rejected` |
| Cash short or over at close | `closeCash` when counted is not expected | critical | `cash.oversee` (new: Manager, Owner), except the person who closed; the Owner only as decision 3 says | `cash_close:<id>` |
| Expense sent for countersigning | `submitAdvance`, `finishAdvance` | action | `expense.countersign` | `advance:<id>:submitted` |
| Expense sent back or countersigned | `sendBackAdvance`, `countersignAdvance` | action / info | The person who recorded it (`userIds`) | `advance:<id>:<outcome>` |
| Award proposed | `proposeAwards` (nightly job) | action | `award.approve`, one notice per run | `awards:<run>` |
| Stock fell below reorder level | `issuePart`, `takeOutItems`, `adjustStock`, when a move crosses the level | action | `stock.move` | `stock:<item>:low:<date>` |
| Account locked after failed logins | `login` lock branch | critical | `user.manage` | `user:<id>:locked:<time>` |
| Staff account created, disabled or password reset | `createStaff`, `setStaffStatus`, `resetStaffPassword` | info | `user.manage`, except the actor | `user:<id>:<event>:<time>` |

The cash close is now one step, so "recount differs" from the main plan's table is dropped.

The Manager's own short count reaches only the Owner, because the actor is excluded.

### 4.2 Needs action (live)

| Item | Shown to (permission) | Source that exists today |
| --- | --- | --- |
| Offences to confirm | `violation.confirm` | `financeOverview.toConfirm` |
| Sacking decisions waiting | `dismissal.decide` | `financeOverview.sackingAlerts` |
| Awards to decide | `award.approve` | `awardsToDecide()` |
| Your cash not closed | `cash.close`, own only | `cashAlerts().cashNotClosed` |
| Handovers waiting for you | The receiver only | `money_transfers` pending, where `to` is the person |
| Expenses to countersign, or sent back to you | `expense.countersign`, or the recorder | `advanceCounts()` |
| Bank payments to check | `bank.reconcile` | `cashAlerts().bankToCheck` |
| Parts to issue, stock below reorder | `stock.move` | `partsToIssue()`, `lowStock()` |
| Inspections left today, from 4 pm | `inspection.record` | `inspectionToday()` |
| Nightly job has not run today | `user.manage` (Manager) | `financeOverview.jobIsCurrent` |

The 4 pm inspection reminder is a live item that appears after 4 pm. It is not a stored message sent by a second schedule (decision 2).

Until phone push arrives in Phase 4, a stored message is seen only when someone opens the app anyway, and a live item does the same job with no extra cron.

## 5. Screens

- **Inbox (`/notifications`):** tabs become **Needs action** (default when it has items), **Updates** and **New**. Needs action rows show a count and open the page where the work is done.
- **Bell:** shows the combined count. It turns red when there is a critical update or a critical action item (sacking decision, nightly job).
- **Critical banner:** in the staff layout (3.3).
- **Money and Home alert rows:** read from `needsAction()` and look the same as today.

## 6. Build order

1. `notify()` additions (permission list, `exceptUserId`), the new permissions (`payment.oversee`, `dismissal.oversee`, `cash.oversee`) and the catalogue entries. Tests for audience rules. *(0.5 day)*
2. Stored events from section 4.1, each written inside its existing transaction. One test per event checks who it reaches and who it does not. *(1.5 days)*
3. `needsAction()`, the combined count for the bell, then moving the Money and Home alert rows onto it. *(1 day)*
4. Inbox tabs, bell colour and the critical banner. *(0.5 day)*
5. Sample data: the sample run produces realistic staff notices, so the page is not empty locally. Then a browser check as each role. *(0.5 day)*

Total: about 4 days.

## 7. Testing

- Each stored event: the listed people get exactly one notice, the actor gets none, a disabled account gets none, and a retry adds nothing.
- `needsAction()`: each role sees only its items. Each count matches the page it links to.
- The nightly job processing a past day posts nothing about that day. This is the existing rule, and it is tested again for awards and sacking.
- Performance: the bell summary stays under 50 ms with 12 months of sample data.

## 8. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Should the Owner be told of every payment reversal and backdate, although they are not critical? | Yes. Money taken off the record is what the Owner most needs to see. |
| 2 | 4 pm inspection reminder: a live item after 4 pm, or a stored message sent by a second daily schedule? | Live item. No extra cron is needed until phone push exists. |
| 3 | Cash short or over: tell people about every difference, or only above an amount? | Tell the Manager of any difference in the Assistant Manager's count. Tell the Owner when the difference is ₦2,000 or more, or when it is the Manager's own count. |
| 4 | Should staff be told about things they did themselves? | No. |
