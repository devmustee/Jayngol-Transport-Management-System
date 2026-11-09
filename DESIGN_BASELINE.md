# Jayngol Design Baseline

Measured 9 November 2026, before any redesign. This is Stage 0 of `DESIGN_PLAN.md`.
Data: a private copy of the sample data (12 tricycles, 32 days), on a production build.
To repeat it: `npm run audit:prepare`, `npm run audit:build`, `npm run audit`, then `npm run audit:lighthouse`.

## Result

| Check | Result | Target | Verdict |
|---|---|---|---|
| Sideways scrolling, 555 page views at 5 widths | 0 | 0 | Met |
| Pages that failed to load or threw a script error | 0 | 0 | Met |
| Automated accessibility rules, WCAG A and AA, 222 page views | 0 violations | 0 | Met for what automation can detect |
| Phone page views with a tap target under 44px | 152 of 222 | 0 | **Not met** |
| Pages with at least one small tap target | 25 of 37 | 0 | **Not met** |
| JavaScript on first load | 133 to 143 KB | 130 KB | **Slightly over on every page** |
| CSS on first load | 5 KB | 20 KB | Met |
| Lighthouse performance on 7 main screens | 81 to 99 | 90 or more | **`/me` is under** |
| Lighthouse accessibility on 7 main screens | 100 | 90 or more | Met |
| Inspection under 15 seconds on a real phone | Not measured | Under 15 seconds | **Still to do, needs a phone** |

The audit includes a self-check that runs the same rules on a deliberately broken page, and it detected the overflow, the small button and the pale text.

## What this changes in the plan

- **Sideways scrolling is not the problem.** The app already fits every width. The responsive work is about using large screens well and reaching every area on a phone.
- **Small tap targets are one pattern, not 25 separate problems.** Nearly all are text links inside list rows, plus the back link at the top of each page. Three other sources are minor: the 40px alert links on Dashboard and Money, the 24px Clear link in filters, and date inputs at 42px.
  - Fixing the back link in `PageHeader` clears most pages with only one or two findings.
  - Making the whole row tappable, in the Stage 1 list components, clears the rest.
- **The worst pages are the newest.** `/store/usage`, `/offences` and `/workshop/history` put several small links in every row.
- **JavaScript is mostly the framework.** All pages sit within about 10 KB of each other, so there is little to trim per page. The limit in `DESIGN_PLAN.md` moves from 130 KB to 150 KB, which leaves room for the app-wide worker code and stops further growth.
- **Lighthouse covers this laptop, not the field.** The server and database are on the same machine, so real response times will be slower. A single run also varies: `/me` scored 95 in an earlier run on a busier machine and 81 in this one. Stage 6 should take the middle of three runs.

## Not covered

- No real phone was used. Screen widths and slowed-down loading are simulated.
- Pages were measured as they first load, with folded sections opened. Error messages, open menus and confirmation states were not measured.
- Automated accessibility checks catch only part of what matters. Screen reader use and keyboard order have not been tested by hand.

## Real-phone check still needed

On a low-end Android phone connected to the same Wi-Fi as the computer, or on a staging address:

1. Log in as a Supervisor and open Inspect.
2. Time one tricycle from opening its card to seeing it saved, once with a pass and once with a failure and photo.
3. Turn on airplane mode, inspect one tricycle, turn the signal back on, and confirm it arrived once.
4. Note anything hard to read in sunlight.

The Stage 0 exit stays open until this is done. It does not block Stage 1, but it must be done before Stage 4 so there is a figure to compare against.

## Lighthouse, mobile, one clean run

| Page | Performance | Accessibility | Best practices | Largest paint | Blocking time | Layout shift |
|---|---|---|---|---|---|---|
| `/login` | 99 | 100 | 100 | 2.0 s | 40 ms | 0 |
| `/dashboard` | 98 | 100 | 100 | 2.1 s | 130 ms | 0 |
| `/tricycles` | 96 | 100 | 100 | 2.2 s | 190 ms | 0 |
| `/money` | 96 | 100 | 100 | 2.2 s | 180 ms | 0 |
| `/payments/new` | 97 | 100 | 100 | 2.3 s | 160 ms | 0 |
| `/inspections` | 96 | 100 | 100 | 2.2 s | 200 ms | 0 |
| `/me` | 81 | 100 | 100 | 2.4 s | 600 ms | 0 |

## Every page

Roles: O Owner, M Manager, A Assistant Manager, S Supervisor, Op Operator. A role that is redirected away from a page is not counted.
"Small targets" is the highest count for any role at 375 pixels. It rises with the amount of data on the page. "Views" is role and width combinations measured.

| Page | Roles | Views | Sideways scroll | Small targets | Accessibility | JavaScript | HTML |
|---|---|---|---|---|---|---|---|
| `/store/usage` | O, M, A | 15 | 0 | 66 | 0 | 139 KB | 11.0 KB |
| `/offences` | O, M, A, S | 20 | 0 | 48 | 0 | 140 KB | 15.2 KB |
| `/workshop/history` | O, M, A, S | 20 | 0 | 30 | 0 | 139 KB | 11.7 KB |
| `/store/:item` | O, M, A | 15 | 0 | 25 | 0 | 140 KB | 9.6 KB |
| `/workshop` | O, M, A, S | 20 | 0 | 8 | 0 | 140 KB | 6.7 KB |
| `/tricycles/:tricycle` | O, M, A, S | 20 | 0 | 7 | 0 | 140 KB | 8.3 KB |
| `/dashboard` | O, M, A, S | 20 | 0 | 2 | 0 | 139 KB | 6.1 KB |
| `/money` | O, M, A | 15 | 0 | 2 | 0 | 139 KB | 6.1 KB |
| `/offences/late-work` | M, A, S | 15 | 0 | 2 | 0 | 140 KB | 6.9 KB |
| `/operators/:operator` | O, M, A, S | 20 | 0 | 2 | 0 | 140 KB | 7.0 KB |
| `/payments/:payment` | O, M, A | 15 | 0 | 2 | 0 | 140 KB | 6.5 KB |
| `/sacking` | O, M, A | 15 | 0 | 2 | 0 | 140 KB | 6.5 KB |
| `/workshop/:workOrder` | O, M, A, S | 20 | 0 | 2 | 0 | 140 KB | 6.2 KB |
| `/arrears` | O, M, A | 15 | 0 | 1 | 0 | 139 KB | 6.1 KB |
| `/cash` | O, M, A | 15 | 0 | 1 | 0 | 140 KB | 6.3 KB |
| `/meetings/:meeting` | O, M, A, S | 20 | 0 | 1 | 0 | 140 KB | 6.6 KB |
| `/no-balance-days` | O, M, A | 15 | 0 | 1 | 0 | 140 KB | 5.8 KB |
| `/operators/:operator/edit` | M, A | 10 | 0 | 1 | 0 | 140 KB | 6.2 KB |
| `/operators/:operator/statement` | O, M, A | 15 | 0 | 1 | 0 | 139 KB | 9.1 KB |
| `/operators/new` | M, A | 10 | 0 | 1 | 0 | 140 KB | 6.2 KB |
| `/payments` | O, M, A | 15 | 0 | 1 | 0 | 139 KB | 6.2 KB |
| `/payments/new` | M, A | 10 | 0 | 1 | 0 | 141 KB | 5.4 KB |
| `/tricycles/:tricycle/edit` | M, A | 10 | 0 | 1 | 0 | 140 KB | 6.5 KB |
| `/tricycles/new` | M, A | 10 | 0 | 1 | 0 | 140 KB | 6.2 KB |
| `/workshop/new` | M, A | 10 | 0 | 1 | 0 | 140 KB | 6.8 KB |
| `/account` | O, M, A, S | 20 | 0 | 0 | 0 | 140 KB | 6.3 KB |
| `/audit` | O, M | 10 | 0 | 0 | 0 | 139 KB | 10.6 KB |
| `/inspections` | M, A, S | 15 | 0 | 0 | 0 | 143 KB | 6.4 KB |
| `/inspections/report` | O, M, A | 15 | 0 | 0 | 0 | 139 KB | 6.2 KB |
| `/login` | Public | 5 | 0 | 0 | 0 | 133 KB | 3.2 KB |
| `/me` | Op | 5 | 0 | 0 | 0 | 135 KB | 7.5 KB |
| `/meetings` | O, M, A, S | 20 | 0 | 0 | 0 | 140 KB | 6.1 KB |
| `/operators` | O, M, A, S | 20 | 0 | 0 | 0 | 139 KB | 7.1 KB |
| `/rules` | O, M, A, S | 20 | 0 | 0 | 0 | 140 KB | 6.4 KB |
| `/store` | O, M, A | 15 | 0 | 0 | 0 | 140 KB | 6.6 KB |
| `/tricycles` | O, M, A, S | 20 | 0 | 0 | 0 | 139 KB | 7.4 KB |
| `/users` | M | 5 | 0 | 0 | 0 | 140 KB | 7.1 KB |
