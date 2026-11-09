# Jayngol Award Tracker Plan

Status: built. All four phases are complete.

## 1. Goal

Every operator can see how far they are from an award, what they have already achieved, and what could stop them. Staff can see who is close and who needs help. Awards should feel like something an operator is working towards every day, not something that appears from nowhere on the 1st of the month.

## 2. What exists today

- The award rules are built and tested: `awardFacts` collects the facts for one operator and `awardBlockers` gives the reasons they do not qualify.
- `/awards` only shows candidates waiting for a decision and awards already given. Between those moments the page is empty, which is what the Manager sees now.
- `/me` shows each award as "On track" or "Not yet" with reasons, but gives no number, date or sense of progress.
- Awards are judged on the 1st of each month, over the previous 6 calendar months.

### What the records show

| Finding | Why it matters for the design |
| --- | --- |
| Sample operators were all issued a tricycle on 8 Oct 2026, so their earliest possible award date is **1 May 2027**, 173 days from 9 Nov 2026. | The tracker has a real countdown to show from day one. |
| The window always starts on the 1st of a month, so one late balance on 5 Nov moves the earliest Consistency award from 1 May to **1 Jun 2027**. | A single slip costs about a month, not the whole 6 months. Operators should be told this. |
| All 11 active sample operators have a confirmed offence, and 8 have a confirmed R2. | Clean Vehicle and Law-Abiding are "never in your whole record" awards, so these operators can **never** win them. See decision 1. |
| Inspections must cover 80% of working days. | This depends on staff, not the operator. An operator must not look as if they failed because a Supervisor skipped inspections. |

## 3. Design principles

1. **One source of truth.** The tracker uses the same rules as the real award. It must never say "you qualify" and then have the award engine disagree.
2. **Everything is calculated from records.** Nobody can type in points or edit a streak. A waived offence restores a streak automatically, and a reversed payment removes credit automatically.
3. **Encourage, do not shame.** Operators see their own progress and a board of top performers. Nobody sees who is last, and nobody sees another operator's debts or offences.
4. **Always show the way back.** After a break, the screen leads with the new date to aim for and the record to beat.

## 4. How progress is measured

### 4.1 Consistency journey

The **clean run** counts days since the operator's last break. A break is either of these:

- A balance not fully paid by the end of its due date.
- A confirmed offence of any kind.

These do not break a run: non-collection days, approved off-road periods, and proposed offences. A proposed offence shows as "Under review" until it is decided. If it is rejected or waived, nothing is lost.

### 4.2 The numbers each operator sees

| Number | How it is worked out |
| --- | --- |
| Next award date | The first upcoming 1st of a month where the operator would qualify if nothing else goes wrong |
| Days to go | Calendar days from today to that date |
| Journey percent | Days completed in the qualifying 6 months |
| Current run | Days since the last break |
| Personal best | Longest run ever |
| Next milestone | The next stage on the path, with days left |

The next award date is the first 1st of a month, `run`, where all of these are true:

- First issue date is on or before `run` minus 6 months.
- For Consistency, no break falls on or after `run` minus 6 months.
- No earlier win of the same award covers that period.

This calculation goes in one new function, `projectAward`, next to `awardFacts` in `src/services/awards.ts`. A test confirms that an operator who stays clean until the projected date is accepted by the real `awardFacts` and `awardBlockers`.

### 4.3 Stages

| Stage | Meaning | Colour |
| --- | --- | --- |
| Ready | Would qualify at the very next award date | Gold |
| Close | Would qualify at the award date after that | Gold outline |
| On the way | Further away than that | Green |
| Waiting for decision | The Manager has this award to decide | Gold outline |
| Under review | A proposed offence could move the date | Grey |
| Restarting | Consistency only: broke a run in the last 30 days | Plain, never red |
| Closed | A "never" rule was broken and cannot be undone, or the operator is no longer active | Plain |
| No tricycle | Not holding a tricycle at the moment, so no date is shown | Plain |

Awards are judged monthly, so anyone within 30 days is already at the next award date. "Close" therefore means one award date further on, up to about 2 months.

### 4.4 Milestones

| Clean run | Milestone | Clean run | Milestone |
| --- | --- | --- | --- |
| 7 days | First Week | 3 months | Halfway Hero |
| 14 days | Steady Rider | 4 months | Road Veteran |
| 1 month | One Month Strong | 5 months | Final Stretch |
| 2 months | Two Month Trust | 6 months | Award Ready |

Other badges:

- **Comeback:** reached 30 clean days after a break.
- **New Best:** beat their own personal best.
- **Winner:** one badge for each award received, with the date.
- **Clean Six:** 6 months without any offence. This one is for operators who can no longer win a "never" award (decision 1).

Milestones earned stay earned after a later break. Only a correction to the records can remove one, in which case it is voided with a reason, like other records in the system.

### 4.5 Inspection coverage

Inspection coverage is shown to staff as a warning, for example "Inspections behind: 71% of 80% needed". Operators see "We need to inspect your tricycle more often, ask your Supervisor" and do not lose their stage for it. The award itself still requires 80%, so the Manager and Supervisors must clear these warnings before the award date.

## 5. Screens

### 5.1 Awards page (`/awards`), Owner, Manager, Assistant Manager

Order from top to bottom:

1. **Summary tiles:** Ready, Close, Inspections behind, Next award date.
2. **Waiting for your decision** (existing section, shown only when there is something to decide).
3. **Award race:** every operator, with a switch for Consistency, Clean Vehicle and Law-Abiding. Each row shows the name, tricycle, journey bar, days to go, current run, stage and latest milestone. Closest to winning comes first. Filters: stage, and "Inspections behind".
4. **Hall of winners** (existing given awards, redesigned with badges).

Selecting an operator opens their journey: the milestone path, breaks with dates and reasons, and the same blockers the Manager will see at decision time.

### 5.2 Supervisor view

Supervisors get the same race but only with stage, days to go and inspection coverage. It leaves out money owed. Their main list is "Inspect these first": operators who are Close or Ready but behind on inspections.

### 5.3 Home dashboard, all staff

A compact **Award race** card shows the top 3 closest operators, the number Ready, and a link to `/awards`. The Manager's alerts gain one line when a Ready operator is below 80% inspection coverage with fewer than 14 days left.

### 5.4 Operator profile, staff

A small journey card on each operator's profile, so a Manager can encourage or caution them during a conversation.

### 5.5 Operator portal (`/me`)

This replaces the current "My award progress" card and sits directly after what they owe.

1. **Journey hero:** large "84 days to go", the next award and its prize, the award date, and a progress ring.
2. **Run counter:** current run, personal best, and a row of the last 7 days as filled or missed dots.
3. **Protect your run:** only appears when something is at risk, for example "Pay today's ₦3,500 by midnight to keep your 96-day run".
4. **Milestone path:** earned badges, the next one highlighted with days left, later ones locked.
5. **Three award cards:** Consistency, Clean Vehicle and Law-Abiding, each with its status and prize.
6. **Honour board:** the top 5 only (decision 2).

After a break the hero changes to: "Your run ended on 5 Nov because of a late balance. Award date: 1 Jun 2027. Your best to beat: 96 days."

### 5.6 Notifications

Sent through `notifyOperators` today, and through the catalogue once `NOTIFICATION_PLAN.md` is built. Each is sent at most once.

| Event | Message to operator |
| --- | --- |
| Milestone reached | "One Month Strong! 30 clean days. 152 days to go." |
| Run at risk | Added to the existing balance reminder for runs of 7 days or more: "Pay today to avoid a fine and keep your 45-day run." |
| Became Close | "You are 30 days from the Consistency award." |
| Run ended | "Your run has ended. New award date is 1 Jun 2027. You can do this." |
| Award approved | Existing award notice, with a link to the badge |

Staff see a warning on the Home Award race card when a Ready operator's inspections are behind. "Run ended" is sent only for runs of 7 days or more.

## 6. Data and permissions

- **No score table.** Progress is calculated live from existing records. Measured with 200 simulated operators and a year of records: the full race takes about 0.6 seconds, and the Honour board and nightly step about 0.2 seconds.
- **New table `award_milestones`:** `operator_id, code, reached_on, evidence, voided_at, void_reason`, unique per operator and milestone. It is written by the nightly job so that each celebration is sent only once.
- **New permission `awards.track`:** Owner, Manager, Assistant Manager and Supervisor. The existing `finance.view` still protects award decisions and what was given.
- **Operators are identified only from the login session,** and can only open their own journey.
- **Honour board** returns only the name, tricycle code, run length and badges of the top 5.

## 7. Fairness and misuse

| Risk | Safeguard |
| --- | --- |
| Staff waive offences to help a favourite | The award decision screen shows how many offences were waived in the period and by whom |
| Operators pressure Supervisors not to report offences | Inspection coverage is still required, and existing offence audit stays in place |
| Backdated payments rescue a run | The tracker uses the same late rule as awards, based on effective payment date, and every backdated payment is already audited |
| A break in service still counts as continuous | Existing gap: the 6-month rule uses the first issue date. See decision 4 |
| Ranking discourages those at the bottom | No full ranking for operators, and only the top 5 are shown |

## 8. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Engine | `projectAward`, clean run, stages, milestone rules, `awards.track`, hand-checked tests | 2 days | Every projected date is confirmed by the real award rules |
| 2. Staff screens | Award race on `/awards`, Supervisor view, Home card, profile card, operator journey | 2 days | All four staff roles see the correct view with correct limits |
| 3. Operator portal | Journey hero, run counter, milestone path, award cards, Honour board | 2 days | Clear and usable at 375 px on a phone |
| 4. Celebrations | `award_milestones`, nightly job, notifications, "Protect your run" | 1 to 2 days | Repeating the nightly job never sends a milestone twice |

## 9. Testing

- **Agreement:** projected date against the real award engine, for hand-checked operators.
- **Boundaries:** payment on the last moment of the due date, a break on the 1st and on the last day of a month, exactly 80% coverage, exactly 6 months of service.
- **Corrections:** a waived offence restores the run, and a reversed payment breaks it.
- **Exempt days:** non-collection days and off-road periods neither break nor end a run.
- **Repeat wins:** after winning, the next date starts after the won period.
- **Privacy:** an operator cannot open another's journey, and the Honour board contains only the permitted fields.
- **Supervisor limits:** no amounts owed appear.

## 10. Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | One offence shuts Clean Vehicle and Law-Abiding forever. Should that stay? | Keep the prize rules as agreed, and add the Clean Six badge so operators who are shut out still have something to reach for. The alternative is to judge these awards over the last 12 months, which would change the agreed rules and could mean more prizes |
| 2 | Should operators see each other's progress? | Honour board of the top 5 only, with no full ranking |
| 3 | How close counts as "Close"? | One award date after the next one (see section 4.3) |
| 4 | If an operator leaves and comes back, does their service restart? | Yes. It restarts when a tricycle was returned because the operator left or was sacked. Changing tricycle does not restart it |
