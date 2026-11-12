# Jayngol Plan: Taking Items From the Store, and a Workshop Report for Each Tricycle

Status: Phases 1 to 4 built (13 Nov 2026), not yet released. Questions for the owner in section 5.

**Phase 1 as built:** the Store page has **Take out items** and a **Take out** link on each item with stock (Manager and Assistant Manager). The form (`/store/take`) lists tricycles in the workshop with their job, every item with stock and a quantity box, and a live summary of what goes out and its cost at the store's price. One save takes all items out or none (`takeOutItems` in src/services/store.ts, items locked in a fixed order); too much, part of a whole item or a word in place of a number is refused on that item's line. After saving, the job page opens with the items under Parts used, where Return still works item by item. Covered in tests/workshop.test.ts.

**Phase 2 as built:** the job page shows **Take from store** openly while the tricycle is in the workshop (no fold), using the same several-item form with the tricycle already chosen, so after **Check in now** it is right there. The form empties itself once items go out. The **Complete** card lists what was taken (with costs for those who see them). A service with nothing taken shows "No items were taken from the store for this service" and the Complete button stays off until that is ticked; repairs are not asked. The old one-item "Issue a part" form and its action are gone.

**Phase 3 as built:** **Workshop report** on the tricycle page's Service and repairs card opens `/tricycles/[id]/workshop`. Period chips (this month, last 3 months, this year, all time) and Choose dates, never past today (`readReportPeriod` in src/lib/report-period.ts, shared with phase 4 through `PeriodPicker`). Figures: spent (parts and labour), services done and missed, repairs (and whether it is in the workshop now), days off the road (days with no balance charged, an open repair counted up to today), last and next service. Parts used are totalled by item, returns left out. Every job lists fault, who held the tricycle when a repair was reported, what was done, parts, cost, days off road and who completed it. Save as PDF prints it without the menu or buttons. The Supervisor sees no naira figures. `tricycleWorkshopReport` in src/services/workshop.ts; covered in tests/workshop.test.ts.

**Phase 4 as built:** **Report** on the Workshop page opens `/workshop/report` with the same period picker. Fleet figures at the top (spent, services done and missed, repairs, days off the road), then one row per tricycle, costliest first: cards on a phone, a table with totals on wider screens and in print. Tricycles with no work still appear; retired ones only when they had work. A tricycle that missed a service is marked, and so are those with the most repairs when that is two or more. Each row opens that tricycle's report for the same period. The Supervisor sees no naira figures. `fleetWorkshopReport` in src/services/workshop.ts; covered in tests/workshop.test.ts.

## 1. What is there today

- **Store** lists each item with its quantity and value, and has a **Usage record**. There is no way to take an item out from the Store page.
- Items can only be taken out from inside an open work order (Workshop → the job → "Issue a part"). That button is hidden in a fold, takes **one item at a time**, and only shows while the tricycle is checked in. Staff who start from the Store page cannot find it.
- Every item taken out is already recorded against the tricycle and the job, with its cost at the store's average price. **Return** undoes a mistake while the job is open.
- The tricycle page has a short list of its services and repairs, and Workshop has a history across all tricycles. There is no report that sums up one tricycle: what it cost, which parts it used, how often it broke down and how long it was off the road.

## 2. Part A: Take items from the store

### 2.1 From the Store page

A **Take out items** button sits next to Usage record (Manager and Assistant Manager, as today).

1. **Which tricycle.** The list shows only tricycles in the workshop now, each with its job: "GRE,4001 · service, checked in 9:10". A tricycle with no open job can't be chosen (see question 1).
2. **Which items.** Every item with stock left, each with a quantity box and "29 litres left". Several items go out in one save, for example engine oil 1.5 litres, gear oil 0.5 litres and 1 tyre.
3. **Check.** Before saving, a short summary: the items, the quantities, and the total cost (cost shown only to those who can see costs).
4. **Save.** All items go out together or none do. Anything more than what is left is refused, naming the item: "Only 6 litres of gear oil left". Items counted whole (tyres) refuse 1.5.

Each item card on the Store page also gets a **Take out** link that opens the same form with that item ready.

### 2.2 From the work order

The job page shows **Take from store** openly (no hidden fold) while the tricycle is in the workshop, using the same multi-item form. After **Check in now**, the page opens with the form ready, since that is when parts are needed.

The **Complete** card lists what was taken, so the mechanic sees it before closing the job. A service completed with nothing taken from the store asks once: "No items were taken from the store for this service. Complete anyway?"

### 2.3 What stays the same

- Stock never goes below zero, and two people taking the same item at once are queued, as today.
- Cost is the store's average price, as today.
- Return still undoes an item while the job is open. After the job closes, a count correction (Manager) is the only change.
- Low stock still shows "Low, reorder" on the Store page and in notifications.

## 3. Part B: Workshop report for each tricycle

### 3.1 One tricycle

A **Workshop report** button on the tricycle page opens `/tricycles/[id]/workshop`, with a period picker: this month, last 3 months, this year, all time, or chosen dates.

**Summary at the top**

| Figure | Example |
| --- | --- |
| Spent on this tricycle | ₦84,500 (₦62,000 parts, ₦22,500 labour) |
| Services | 5 done, 1 missed |
| Repairs | 2 |
| Days off the road | 4 |
| Last service / next service | 2 Nov / 16 Nov |

**Parts used**, totalled by item: "Engine oil 7.5 litres ₦34,875 · Tyre 2 ₦56,000".

**Every job**, newest first: the date, service or repair, the fault reported, what was found and done, the items taken, labour, the total, who completed it and how many days it was off the road. Each links to its work order.

**Who held it.** For each repair, the operator who held the tricycle when the fault was reported, so repeat problems with one operator show up.

### 3.2 All tricycles

**Workshop report** on the Workshop page opens `/workshop/report`, with the same period picker and one row per tricycle:

| Tricycle | Services done / missed | Repairs | Days off road | Parts | Labour | Total |
| --- | --- | --- | --- | --- | --- | --- |

It is sorted by total cost, with fleet totals at the top. Each row opens that tricycle's report. Missed services and the most repairs are highlighted.

### 3.3 Printing and who sees what

- Both reports print cleanly on A4 (no menu, no buttons), for the owner's file.
- Owner, Manager, Assistant Manager and Supervisor can open them. Money (parts, labour, totals) is shown only to those who already see workshop costs. The Supervisor sees jobs, items and days off road, but no naira figures.

## 4. Data

No new tables or migrations. Everything comes from what is already recorded: work orders, items taken out (with returns removed), labour, and off-road periods. Part A adds one service function that takes several items in one transaction, built on the current single-item one.

## 5. Questions for the owner

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | Can items be taken out for a tricycle that is **not** in the workshop (for example an oil top-up at the park)? | **No.** Check it in as a quick repair, take the items, and complete it straight away. Every item stays tied to a job. |
| 2 | Who can take items out? | Manager and Assistant Manager, as today. |
| 3 | Should a service with no items taken ask before completing? | Yes, once. |
| 4 | Report periods | This month, last 3 months, this year, all time, chosen dates. |

## 6. Phases

| Phase | Work | Estimate | Done when |
| --- | --- | --- | --- |
| 1. Take out items from the Store page | Button, tricycle choice, several items in one save, summary, refusals | 1 day | Three items go to GRE,4001's job in one save, and more than what is left is refused by name |
| 2. Same form on the work order | Open "Take from store", ready after check-in, list on Complete, the "nothing taken" question | Half a day | A mechanic adds parts from the job page without opening any fold |
| 3. Report for one tricycle | Summary, parts by item, every job, days off road, period picker, print | 1 day | The owner prints one tricycle's year |
| 4. Report for all tricycles | Fleet table, totals, highlights, print | Half a day | The owner sees which tricycle costs most this month |

## 7. Testing

- Several items in one save: all go out, stock and value drop, each is recorded against the job and the tricycle.
- One item over what is left: nothing goes out, and the message names the item.
- Whole items refuse fractions.
- Two people taking the last tyre at once: one succeeds, the other is refused.
- A tricycle not in the workshop can't be chosen.
- Return after a multi-item save returns only that item.
- Report totals match the work orders, with returned items left out.
- Days off road count a repair still open up to today.
- The Supervisor's report shows no naira figures.
- Both forms and both reports work at 375 px and print on A4.
