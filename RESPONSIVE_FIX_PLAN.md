# Jayngol Plan: Screens That Don't Scroll to the Bottom

Status: Built (19 Nov 2026), not yet released.

**As built:**
- **Bottom space:** below 768 px, the page always ends 96 px (plus the phone's gesture area) above the bottom of the screen, whatever the width. It was checked at 360, 700, 740 and 767 px.
- **Side menu:**
  - It shows a thin scrollbar, plus a fade and arrow while more items are below.
  - On screens under 760 px tall, the items are closer together.
  - "Account" is no longer repeated in the menu, since the name at its foot opens it.
  - Even so, all 17 items don't fit on screens under about 800 px tall; the fade shows there is more.
- **Phone held sideways (under 500 px tall):**
  - the top bar scrolls away;
  - the bottom bar shows icons only, at 53 px;
  - the urgent banner keeps to one line.
- **Phone's gesture area:** the page is not set to use the whole screen. Without that setting, the phone's browser already keeps the page clear of its gesture area, and turning it on would need extra space for notches throughout. Item 4 below was left out for that reason.
- **Code:** the `<main>` padding in src/app/(staff)/layout.tsx, `SideNav` and `BottomNav` in src/components/nav.tsx, and the `low` and `short` screen-height rules in src/app/globals.css.

## 1. What was checked

- **Screens:** all 56 staff screens (every list, form and detail page), signed in as the Manager on the local copy.
- **Widths:** 360 px (small phone), 700 px (fold screen, small tablet, phone on its side), 1024 × 600 (short laptop) and 740 × 360 (phone on its side).
- **What each screen was measured for:**
  - content wider than the screen;
  - the bottom of the page hidden behind the bottom bar;
  - boxes that scroll sideways;
  - buttons and fields too small to tap;
  - text that is too small.

## 2. What is wrong

| # | Problem | Where | Who sees it |
| --- | --- | --- | --- |
| 1 | **The last row of every page is hidden behind the bottom bar and cannot be scrolled into view.** This is the user's screenshot (Money, with "Awards" and "No-balance days" cut off). | Every staff screen, at widths from 640 to 767 px | Fold phones opened, small tablets, many phones held sideways |
| 2 | **The side menu hides items on short screens.** At 1024 × 600, only Home to Inspect show. Workshop, Store, Offences, Meetings, Reports, Awards, Staff and Audit log are below the fold. The menu does scroll, but its scrollbar is hidden, so nothing shows that there is more. | Every screen with the side menu (768 px and wider), on screens less than about 900 px tall | Laptops, tablets held sideways |
| 3 | **Very little room on a phone held sideways.** At 740 × 360, the top bar (64 px), the urgent banner (about 56 px) and the bottom bar (65 px) leave about 175 px for the page. | Every staff screen, sideways phones | Staff who turn the phone |

**What is fine:**
- At 360 px wide, all 56 screens pass every check: nothing is too wide, the bottom is reachable, and every button and field is large enough to tap.
- The tables on Annual balance and the reports scroll sideways inside their own boxes, which is intended.
- The operator portal has no bottom bar, so it is not affected.

**Why problem 1 happens:**
- The page leaves 112 px of space at the bottom for the 65 px bar.
- But a wider-screen rule ("24 px of padding on all sides from 640 px") overrides it.
- The bar itself is shown until 768 px.
- So between 640 and 767 px, only 24 px of space is left under a 65 px bar.

The code is the `<main>` padding in src/app/(staff)/layout.tsx.

## 3. The fix

1. **Bottom space always clears the bar.**
   - Below 768 px, the page's bottom space is always the bar's height, plus the phone's own gesture area, plus a margin, whatever the width.
   - From 768 px, where the bar is replaced by the side menu, it goes back to normal.
2. **The side menu fits short screens.**
   - The menu shows a thin scrollbar.
   - It fades at the bottom while more items are below.
   - Below 760 px in height, the items are packed a little closer, so the whole menu fits on a 768 px-tall laptop.
3. **More room on a phone held sideways.** When the screen is less than 500 px tall:
   - the top bar is not pinned, so it scrolls away;
   - the bottom bar shows icons only (no labels), at 52 px;
   - the urgent banner keeps its place but uses one line.
4. **The phone's gesture area is respected.** The page is told to use the whole screen, so the bottom bar sits above the gesture area on iPhones and Android phones with gesture navigation.

No database change.

## 4. Work and tests

Half a day.

- At 360, 412, 700, 740 and 767 px wide, the last item on Money, Home, Annual balance, Statement and Offences can be scrolled fully above the bottom bar.
- At 1024 × 600 and 1280 × 720, every side menu item can be reached, and the fade shows while more items are below.
- At 740 × 360, a form (Take payment) can be filled in and submitted without the bars covering the fields.
- The full 56-screen check is run again at 360, 700 and 1024 px, with nothing too wide and nothing hidden.
- The Fines owed waive bar still sits above the bottom bar at every width.
