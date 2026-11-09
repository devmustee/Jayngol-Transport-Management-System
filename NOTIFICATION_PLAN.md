# Jayngol Global Notification Plan

Status: proposed. Nothing in this plan has been built yet.

## 1. Goal

Every person who uses Jayngol, in every role, sees what needs them from any page. Nothing important is lost, repeated or shown to the wrong person.

| Role | Main need |
| --- | --- |
| Owner | Serious problems and a summary, without daily noise |
| Manager | Decisions waiting, cash problems, system failures |
| Assistant Manager | Countersigning, second counts, bank confirmations, handovers |
| Supervisor | Inspections left, meetings, announcements |
| Operator | Receipts, fines, reminders, meetings, awards, announcements |

## 2. What exists today

- Operators have Notices on the portal (`operator_notices`), written by payments, offences, meetings, awards and the nightly job.
- Staff have no inbox. They only see alerts on the Home and Money pages, and those alerts are mostly finance-only, so Supervisors see very little.
- Alert counts are calculated live, so they are never out of date. This is worth keeping.
- There is no way to send a message to everyone.
- A service worker and app manifest exist, but there is no phone push.
- The only scheduled job runs once a day at 00:05 Lagos time.
- The small team (about 6 staff and 11 operators in the sample) keeps message volume low, so no separate messaging service is needed.

## 3. Design decisions

### 3.1 Two kinds of item, in one bell

| | **Needs action** | **Updates** |
| --- | --- | --- |
| Example | 3 cash counts waiting for a check | Your payment of ₦12,000 was received |
| Stored? | No, calculated live from the records | Yes, one saved record per person |
| Clears when | The work is done | The person reads it |

Saving "needs action" items would leave them stale after someone else finishes the work. Calculating them live avoids that.

### 3.2 One way to create a notification

All features call one function, `notify(tx, event)`. A catalogue (`src/lib/notification-catalogue.ts`) sets each event's severity, wording, link and audience. Features never pick recipients themselves.

Staff audiences are based on **permissions, not role names**, so they follow any future change to the permission matrix.

### 3.3 Saved with the event

The notification is written in the same database transaction as the event. If a payment saves, its receipt notice exists, and if it fails, neither does. Each event has a unique key, so a retry or a re-run of the nightly job cannot post it twice.

### 3.4 Showing new items

The app checks a small summary endpoint every 60 seconds while the page is visible, and when the person returns to it. An unchanged result sends almost no data, which suits weak networks and costs little on the hosting plan. Live connections are not worth their complexity at this size.

## 4. Data model

**`notifications`**: one per event.
`id, kind, severity (info, action, critical), title, body, link, entity_type, entity_id, dedupe_key (unique), requires_ack, expires_at, created_by (empty for the system), created_at`

**`notification_recipients`**: one per person.
`id, notification_id, user_id or operator_id (exactly one), read_at, acknowledged_at`

- Operators are addressed by `operator_id`, because they can receive notices before a login is set up.
- A database trigger allows only `read_at` and `acknowledged_at` to change, so what someone was told stays on record.
- `operator_notices` is copied across and then retired.

**Phase 4 only:** `push_subscriptions` (one per device) and `notification_deliveries` (channel, status, attempts, last error). The unused `sms_outbox` can become another delivery channel if SMS returns.

## 5. Who gets what

| Event | Severity | Recipients |
| --- | --- | --- |
| Payment received | info | Operator |
| Payment reversed or backdated | action | Operator, Owner, Manager |
| Balance due, late fine, sacking warning | action | Operator |
| Operator reaches 5 unpaid days | critical | Manager, Owner |
| Sacking decision or reinstatement | critical | Operator |
| Offence raised | action | Those who can confirm offences |
| Offence confirmed or waived | action | Operator, and the Supervisor who raised it |
| Service tomorrow, service missed | action | Operator |
| Repair finished, tricycle back on the road | info | Operator |
| Stock below reorder level | action | Those who manage stock |
| Meeting scheduled or cancelled | action | Everyone expected |
| Inspections left at 4 pm | action | Supervisors |
| Loan granted or cleared | info | Operator |
| Expense submitted | action | Assistant Manager |
| Expense sent back or countersigned | action | Manager |
| Cash handover sent or refused | action | The receiver or the sender |
| Cash short or over, recount differs | critical | Manager, Owner |
| Payment not found on the bank statement | critical | Manager, Owner |
| Award proposed | action | Manager |
| Award won | info | Operator |
| Nightly job did not run | critical | Manager |
| Account locked after failed logins | critical | Manager |
| Staff role changed or account disabled | info | That person, Manager |
| Announcement | set by sender | Chosen audience |

**Privacy rule:** operator messages never contain costs, staff notes or another operator's details. Clicking a link still goes through that page's normal permission check.

## 6. Screens

- **Bell with an unread count** in the staff header, side menu and operator portal, on every page.
- **Inbox page** at `/notifications`, with Needs action and Updates tabs, filters, "mark all as read", and 200+ items loaded in pages. The portal uses the same inbox.
- **Critical banner** across the top until the person opens it.
- **Announcements page** for the Manager: write a message, choose everyone, a role or specific operators, set an expiry, preview the number of recipients, and optionally require "I have read this". The page shows who has and hasn't acknowledged it.
- **Preferences** on the Account page in Phase 4. Critical messages and required acknowledgements cannot be turned off.

## 7. Keeping noise down

- Payment receipts stay one per payment because they are proof. Repeated reminders of the same kind merge into one line, such as "3 reminders today".
- A catch-up run of the nightly job never posts about past days, which is already the rule today.
- The 4 pm inspection reminder goes only to people with inspections still left.
- The Owner gets critical items only, plus a weekly summary.
- Read items are kept for 12 months, then removed by a monthly job. Announcements and acknowledgements are kept permanently.

## 8. Reliability and security

- The person is always taken from the login session. No endpoint accepts a user or operator ID.
- A disabled staff account stops receiving messages straight away.
- Sending an announcement is recorded in the audit log and limited to prevent accidents. Messages are shown as plain text only.
- The nightly job's own failure is detected when someone loads a page, because a failed job cannot report itself.
- Phone push is sent after the database save, so a push failure never affects a payment. Devices that stop working are removed automatically.

## 9. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Foundation | Tables, catalogue, `notify`, move operator notices, bell, inbox, 60-second refresh | 3 days | Every role sees the bell, and existing operator notices are intact |
| 2. Staff events | Everything in section 5, Needs action tab, critical banner, 4 pm reminder | 3 days | Each event reaches exactly the listed people, checked by tests |
| 3. Announcements | Compose page, audiences, expiry, acknowledgements, audit | 2 days | Manager can reach all users and see who acknowledged |
| 4. Phone push | Push through the service worker, device sign-up, preferences, retries | 3 days | A test message reaches an installed app on a real Android phone and iPhone |
| 5. Hardening | Clean-up job, weekly Owner summary, load test, documentation | 1 to 2 days | 12 months of simulated data keeps the bell responding in under 200 ms |

Phases 1 to 3 are needed for go-live. Phase 4 can follow.

## 10. Testing

- **Isolation:** no user can read or mark another person's notification, across all five roles.
- **Audience:** one test per catalogue event confirms exactly who receives it, and a test fails if any event has no audience.
- **Exactly once:** retried requests and repeated job runs post nothing twice.
- **All or nothing:** a failed payment leaves no notice.
- **Disabled accounts, expired announcements, muted categories** and critical items that cannot be muted.
- **Phone width (375 px)** for the bell, inbox and banner, and a check on real devices for push.

## 11. Limits to plan around

- **iPhone push** only works after the app is added to the Home Screen, on iOS 16.4 or later. Android is simpler. In-app notices remain the source of truth, so nobody depends on push.
- **Reminders during the day** need a second schedule (the 4 pm check), and retries need one every few minutes. How often these can run depends on the Vercel plan, so this must be confirmed before Phase 2. An outside scheduler calling the existing secured job endpoint is the fallback.
- **Operators who never open the app** will miss messages until SMS returns. Operators with no login at all can't see any notices, so a PIN should be set for every operator at go-live.

## 12. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Who can send announcements? | Manager only |
| 2 | Can sacked or departed operators still see their notices? | Yes, read-only, until their account is settled |
| 3 | Should phone push be part of go-live? | No, add it straight after go-live |
| 4 | How much should the Owner receive? | Critical items and a weekly summary |
