# Jayngol Plan: Design Polish, Motion and Gamification

Status: Phase 1 built (12 Nov 2026), with the recommended decisions. Phases 2 to 6 are not started.

**Direction from the owner:** the design should be very clean. Motion stays quiet: short slides and fades, no bounces or glows, one accent colour. Phase 2 should remove decoration rather than add it.

**Phase 1 as built:** timing tokens and keyframes in `globals.css`; a plain white "saved" toast (`Toaster`, raised by every `ActionForm` success); a tick that draws on the save button; shimmering placeholders; sections easing open (`::details-content`, instant where unsupported); progress bars growing in and the portal ring drawing; the Money and Dashboard hero figure counting from the last value seen (`CountUp`); the bell rocking once when a new notification arrives; and a plain gold bar when changing page. Reduced motion stops all of it, including the looping shimmer.
Companion to `DESIGN_PLAN.md` (layout, tokens, tap targets) and `AWARD_TRACKER_PLAN.md` (how awards and milestones are measured).

## 1. Goal

Jayngol should feel finished, quick and rewarding to use, without getting slower on a cheap Android phone on a weak network.

- **Polish:** every screen uses the same type, spacing, surfaces and wording.
- **Motion:** every tap gets a response, and every change on screen shows where it came from and where it went.
- **Gamification:** operators look forward to opening the app because it shows their progress and celebrates it. Staff see their own good work recognised. Nobody is shamed, and no reward pushes anyone to bend the money rules.

## 2. What exists today

| Area | Today |
| --- | --- |
| Styling | Tailwind 4 with theme colours in `globals.css` (ink, paper, gold, status colours), system fonts, cards with `shadow-premium` |
| Motion | Bottom sheet slide-up, fade-in, page fade (`template.tsx`), top progress bar, pulsing placeholders and menu icons. Motion is switched off for people who ask for less. No animation library. |
| Feedback | Save buttons show "Saving…" and block double taps. Success shows a green message in the form, which is easy to miss below the fold. |
| Detail sections | `<details>` open and close instantly, with no movement |
| Operator gamification | Built and tested: 8 milestones from First Week to Award Ready, the current run and best run, "close to an award" and "run ended" notices, a progress ring, and an Honour board of the top 5 |
| Staff gamification | None. Staff see the award race for operators, not their own work. |
| Budgets (`DESIGN_BASELINE.md`) | JavaScript on first load 133–143 KB against a 130 KB target; Lighthouse 81–99, with `/me` lowest |
| Wording | Mixed names for the same thing: "Transport Fleet", "Fleet Ops", "Operations & Fleet Command Center", "Fleet Drivers & Operators" |

**What this means:** the foundations are good. The gaps are consistency, feedback that is easy to miss, and celebration. JavaScript is already over budget, so the plan adds no animation library.

## 3. Principles

1. **Motion explains, it does not decorate.** Every animation either confirms a tap, shows where something went, or celebrates something real.
2. **Fast by default.** Taps respond within 100 ms. Interface movement takes 150–250 ms, and celebrations at most 1.2 seconds. Only position and opacity are animated, so a cheap phone stays smooth.
3. **Less motion when asked.** With the phone's "reduce motion" setting on, everything appears in its final state, with no confetti and no counting.
4. **Money is never animated into a wrong number.** A total may count up on the dashboard, but the real figure is in the page from the start for screen readers, printing and copying, and amounts in forms, tables and receipts never move.
5. **Rewards come from records.** Nobody can type in points or edit a streak, the same rule as the award tracker.
6. **Encourage, never shame.** Show progress and the way back. Never show who is last, and never show one person's debts or offences to another.
7. **Never reward the wrong thing.** Staff are not rewarded for a cash count with no difference, because that encourages hiding differences. They are rewarded for doing the work on time.

## 4. Design polish

| # | Change | Where |
| --- | --- | --- |
| 4.1 | **One type scale:** page title, section title, body, small, and a figure style for money with tabular numbers | `globals.css`, `PageHeader`, `Card` |
| 4.2 | **Three surfaces only:** paper page, white card, ink "hero" card. The dashboard pulse, Money pulse, portal journey hero and Annual Balance total all use the same ink hero card. | `ui.tsx` |
| 4.3 | **Consistent corners and borders:** cards rounded 2xl, controls xl, badges full | Shared components |
| 4.4 | **Plain, consistent names:** "Jayngol" with the subtitle "Fleet" everywhere; page subtitles say what the page is for in plain words | Layout, page headers |
| 4.5 | **Empty states with a next step:** a small gold line drawing, one sentence, and the button to fix it (for example "No offences. Record late work") | `Empty` |
| 4.6 | **Toasts for saved actions:** "Daily balance saved" slides in at the top and fades after 3 seconds, as well as the message in the form, so success is never below the fold | New `Toast`, used by `ActionForm` |
| 4.7 | **Status badges** use one set of meanings: green done, gold waiting, red needs action, grey closed | `Badge` |
| 4.8 | **Dashboard and Money hero:** clearer hierarchy, with the main figure, then target and progress, then the next action | `money-summary.tsx` |
| 4.9 | **Every list row tappable,** finishing the tap-target work from `DESIGN_PLAN.md` | List pages |

## 5. Motion catalogue

Every item is CSS or a small component. Nothing needs a new package.

| Moment | Motion | Time |
| --- | --- | --- |
| Tap on a button or row | Shrinks to 98% and back | 100 ms |
| Changing page | Top bar (built). The page fades and rises 4 px (built). | 200 ms |
| List to detail (tricycle, operator) | The code or name moves from the list row into the page title (View Transitions, where the browser supports it) | 250 ms |
| Open or close a section | Height eases open instead of jumping (`interpolate-size`; older browsers stay instant) | 200 ms |
| Bottom sheet | Slides up (built). Also drag down to close. | 220 ms |
| Saved | Toast slides in; a tick draws itself on the button | 300 ms |
| Form error | The field outline flashes red and the page scrolls to the first error. No shaking. | 150 ms |
| Loading | A soft shimmer across the placeholders instead of pulsing | 1.5 s loop |
| Progress bars and rings | Fill from their last value to the new one | 600 ms |
| Hero money figure | Counts up once per visit, from the last value seen (not from zero) | 600 ms |
| Notification arrives | The bell rocks gently once and the count pops | 400 ms |
| List items | The first 8 rise in 30 ms apart, the rest appear at once | ≤ 250 ms |

**Navigation transitions:** Next.js 16 supports the browser's View Transitions behind an experimental setting. It is turned on only for list-to-detail moves. Where unsupported, the current fade applies.

## 6. Gamification

### 6.1 Operators (builds on the award tracker)

| Feature | What the operator sees | Data |
| --- | --- | --- |
| **Celebration moment** | The first time they open the app after earning a milestone or a new best: a full-screen card, the badge turning over, gold confetti for about a second, and "Share" and "Continue" buttons. Shown once. | Unread milestone notification; marked done with `acknowledged_at`, which already exists |
| **Badge cabinet** | All 8 milestone badges plus "New Best" and the three awards. Earned badges show their date; locked ones show an outline and how to earn them. | Existing milestone records |
| **Streak flame** | The current run in days, with a flame that grows at 7, 30 and 90 days. After 6 pm on a day still unpaid, it flickers with "Pay ₦X by midnight to keep your 23-day run". | `getMyRunAtRisk` (exists) |
| **This week ring** | "5 of 6 days paid on time this week", filling as they pay | Balance periods (exists) |
| **Personal best line** | On the run counter: "Best: 41 days. 18 to beat it." | Existing best run |
| **Honour board podium** | The top 3 on a podium, then 4 and 5, with badges. Still no full ranking. | Existing Honour board |
| **Run ended, kindly** | The broken run is shown greyed with "You did 23 days. Your new aim is 1 Jun 2027." | Existing notice |

### 6.2 Staff (their own work only)

| Role | Feature | Why it is fair |
| --- | --- | --- |
| Supervisor | **Today's inspections ring** ("8 of 10"), with a short celebration at 10 of 10, and a **full-coverage streak** (days in a row with every working tricycle inspected) | It is entirely their own work |
| Assistant Manager and Manager | **On-time close streak:** cash closed by its due day, every day or week in a row | Rewards closing on time. A difference never breaks the streak, so there is no reason to hide one. |
| Manager | **Week in review card** on Monday: on-time balance rate, payments confirmed against the bank, inspections covered, milestones operators reached | Shows the team's work, with no staff ranking |

### 6.3 The whole fleet

- **Monthly fleet goal**, set by the Manager, for example "95% of balances paid on time in November". Everyone (staff and operators) sees one shared progress bar, and when it is reached everyone gets one celebration and notice.
- Calculated from the same `fleetPeriod` figures as the Money screens, so it always matches them.

### 6.4 What we will not do

- No points, coins or levels that can be swapped for money or favours.
- No list of the lowest performers, and no comparison between named staff.
- Nothing that rewards speed of cash counting or a zero difference.
- No sounds.

## 7. How it is built

- **Motion foundation:** time and easing values as theme settings (`--ease-out-soft`, `--duration-fast` and so on) in `globals.css`, plus keyframes for shimmer, pop, rise, draw-tick and confetti. Components use classes, not inline animation code.
- **New small components:** `Toast`, `CountUp`, `ProgressFill`, `Celebration`, `BadgeTile`, `StreakFlame`. Together under 6 KB of JavaScript. Confetti is 16 CSS particles, not a library.
- **Data:** operator features use records that already exist. Staff streaks are calculated live from inspections and cash closes, like the award tracker. The fleet goal needs one small table (`fleet_goals`: month, measure, target, set_by), with changes recorded in the audit log.
- **Celebrations once only:** shown for the newest unacknowledged milestone notification, then acknowledged. Nothing is celebrated twice on another device.
- **Performance:** only `transform` and `opacity` are animated. Nothing animates during the first paint of `/me`. Tested at 4× CPU slowdown on a phone profile, aiming for smooth 60 frames a second.
- **Accessibility:** celebrations are announced to screen readers and closable with one tap or Escape. Nothing depends on colour alone. With reduced motion on, everything appears in its final state.

## 8. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Motion foundation | Timing tokens, Toast, tick on save, shimmer, section height easing, progress fill, count-up, bell pop | 1.5 days | Every save shows a toast, and reduced motion turns all of it off |
| 2. Design polish | Type scale, three surfaces, hero cards, badges, wording, empty states, tappable rows | 2 days | The baseline audit shows no small tap targets, and screens match the surface rules |
| 3. Navigation transitions | View Transitions for tricycle and operator list to detail; sheet drag to close | 1 day | Smooth on Chrome for Android, unchanged elsewhere |
| 4. Operator gamification | Celebration, badge cabinet, streak flame, week ring, best line, podium, kinder run-ended | 3 days | Each milestone is celebrated exactly once, checked by tests |
| 5. Staff and fleet | Inspection ring and streak, on-time close streak, Monday review, fleet goal | 2 days | Streak rules tested; a cash difference never breaks a streak |
| 6. Hardening | Low-end phone test, budgets, Lighthouse and audit re-run against `DESIGN_BASELINE.md` | 1 day | JavaScript back under 130 KB, and `/me` scores 90+ |

About 10.5 days in total. Phases 1 and 2 give most of the visible lift, and phase 4 matters most to operators.

## 9. Testing

- **Streaks:** inspection and close streaks, including holidays, weekly Manager closes and a closing done a day late.
- **Once only:** a milestone celebration shows once, even across two devices and after the nightly job runs again.
- **Fairness:** a cash difference does not break the close streak; a waived offence restores the operator's run (already true).
- **Privacy:** the podium and fleet goal show only permitted fields; no operator sees another's debts.
- **Reduced motion:** a screenshot run with it on shows final states and no confetti.
- **Budgets:** JavaScript per page, Lighthouse on the 7 main screens, and the tap-target audit.
- **Phone width (375 px)** for every new card and the celebration screen.

## 10. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Add an animation library? | No. CSS and the browser's View Transitions cover everything here without adding JavaScript. |
| 2 | Full-screen celebrations for operators? | Yes, once per milestone, closable at once |
| 3 | Phone vibration on success and milestones? | Yes on Android, short, only for saves and milestones |
| 4 | Gamify staff work? | Yes, only Supervisor inspections and on-time cash closes; no staff rankings |
| 5 | Monthly fleet goal: who sets it and on what? | The Manager, monthly, on the share of balances paid on time |
| 6 | A "Share" image of a badge for WhatsApp? | Yes, in phase 4; it shows only the operator's name, badge and date |
| 7 | Sounds? | No |
| 8 | Dark mode? | Not now. The app is used outdoors in sunlight; revisit after phase 6. |
